import 'dotenv/config';
import pLimit from 'p-limit';
import git from 'isomorphic-git';
import fs from 'node:fs';
import path from 'node:path';

import { loadState, saveState, isReviewed } from './state.js';
import { getChannelVideos, getVideoDescription, getVideoUploadDate, getPinnedComment } from './youtube.js';
import { parseGitHubUrls, parseGitHubUrlsFromComment } from './parser.js';
import { fetchProjectDetails, githubLimit } from './github.js';
import { summarizeReadme } from './llm.js';
import { writeReportJson } from './render.js';
import {
  initDashboard, stopDashboard,
  setVideoTotal, setProjectTotal,
  incVideosDone, incProjectsDone, incLlmDone, incReportsWritten,
  setCurrentVideo, setCurrentProject, addCurrentLlm, removeCurrentLlm,
  logLine,
} from './dashboard.js';
import type { VideoReport, GitHubProject, ReviewedVideo } from './types.js';

// ── Configuration ──────────────────────────────────────────
const CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID || 'UC9Rrud-8CaHokDtK9FszvRg';
const OUTPUT_DIR = process.env.OUTPUT_DIR || './output';
const STATE_FILE = process.env.STATE_FILE || './state/reviewed.json';
const VIDEO_CONCURRENCY = parseInt(process.env.VIDEO_CONCURRENCY || '3', 10);
const PROJECT_CONCURRENCY = parseInt(process.env.PROJECT_CONCURRENCY || '5', 10);
const LLM_CONCURRENCY = parseInt(process.env.LLM_CONCURRENCY || '3', 10);
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '';  // e.g. "0 */6 * * *"
const GIT_REPO_URL = process.env.GIT_REPO_URL || 'https://github.com/mcowger/gha.git';
const GIT_REPO_DIR = process.env.GIT_REPO_DIR || '/repo';

function validateEnv(): void {
  const required = ['LLM_API_KEY'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    console.error('Check .env.example for required configuration.');
    process.exit(1);
  }
}

// ── Concurrency limiters ───────────────────────────────────
const videoLimit = pLimit({ concurrency: VIDEO_CONCURRENCY });
const projectLimit = pLimit({ concurrency: PROJECT_CONCURRENCY });
const llmLimit = pLimit({ concurrency: LLM_CONCURRENCY });

// ── Git helpers ─────────────────────────────────────────────

/**
 * Ensure we have a cloned git repo to work in. If GIT_REPO_DIR doesn't exist,
 * clone it. If it does, pull latest. Then chdir into it.
 */
async function gitInitOrPull(): Promise<void> {
  const dir = GIT_REPO_DIR;
  const token = process.env.GH_TOKEN;
  const auth = { username: 'mcowger', password: token };
  const http = await import('isomorphic-git/http/node').then(m => m.default);
  const url = token
    ? GIT_REPO_URL.replace('https://', `https://mcowger:${token}@`)
    : GIT_REPO_URL;

  if (!fs.existsSync(path.join(dir, '.git'))) {
    console.log(`📋 Cloning ${GIT_REPO_URL} → ${dir}...`);
    await git.clone({ fs, http, dir, url, onAuth: () => auth, singleBranch: true, depth: 50 });
    console.log('  ✅ Repo cloned');
  } else {
    try {
      const branch = (await git.currentBranch({ fs, dir })) || 'main';
      const remote = (await git.listRemotes({ fs, dir }))[0]?.remote || 'origin';
      await git.pull({ fs, http, dir, remote, ref: branch, url, onAuth: () => auth, singleBranch: true });
      console.log('  ✅ Repo pulled');
    } catch {
      console.log('  ⚠️  Pull failed (may be ahead of remote)');
    }
  }

  process.chdir(dir);
}

async function gitCommitAndPush(message: string): Promise<void> {
  try {
    const dir = process.cwd();
    const token = process.env.GH_TOKEN;
    const remote = (await git.listRemotes({ fs, dir }))[0]?.remote || 'origin';
    const branch = (await git.currentBranch({ fs, dir })) || 'main';
    const repoUrl = token
      ? GIT_REPO_URL.replace('https://', `https://mcowger:${token}@`)
      : GIT_REPO_URL;

    const auth = { username: 'mcowger', password: token };
    const http = await import('isomorphic-git/http/node').then(m => m.default);

    // Stage output files
    const pattern = 'output/';
    const matrix = await git.statusMatrix({ fs, dir, filter: (f: string) => f.startsWith(pattern) });

    const changed = matrix.filter((row: Array<string | number>) => {
      return row[0] === 0 && row[1] === 0  // new file
        || row[1] !== row[2];              // modified
    });

    if (changed.length === 0) {
      console.log('  📭 No changes to commit');
      return;
    }

    // Stage all changed files
    for (const [filepath] of changed) {
      await git.add({ fs, dir, filepath });
    }

    // Compare content vs HEAD to skip no-op commits
    let hasRealChanges = false;
    for (const [filepath, headSha] of changed) {
      if (headSha === 0) {
        hasRealChanges = true;
        break;
      }
      try {
        const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
        const headBlob = await git.readBlob({ fs, dir, oid: headOid, filepath: String(filepath) });
        const headContent = Buffer.from(headBlob.blob).toString('utf-8');
        const workContent = fs.readFileSync(path.join(dir, String(filepath)), 'utf-8');
        if (headContent !== workContent) {
          hasRealChanges = true;
          break;
        }
      } catch {
        hasRealChanges = true;
        break;
      }
    }

    if (!hasRealChanges) {
      console.log('  📭 No content changes to commit');
      try { await git.resetIndex({ fs, dir, filepath: '.' }); } catch { /* ok */ }
      return;
    }

    // Commit
    await git.commit({ fs, dir, message, author: { name: 'gha-bot', email: 'bot@gha.local' } });

    // Push
    await git.push({ fs, http, dir, remote, ref: branch, url: repoUrl, onAuth: () => auth, force: true });

    console.log(`  📤 Pushed: ${message}`);
  } catch (err) {
    console.error(`  ❌ Git push failed: ${err instanceof Error ? err.message : err}`);
  }
}

// ── Core pipeline ───────────────────────────────────────────

async function processProject(p: GitHubProject): Promise<GitHubProject> {
  const label = `${p.owner}/${p.repo}`;

  setCurrentProject(label);

  const detailed = await fetchProjectDetails(p);

  if (!detailed.readme) {
    logLine(`⚠️  No README found for ${label}`);
    detailed.error = 'No README found';
  } else {
    logLine(`📖 README fetched for ${label} (${detailed.readme.length} chars)`);
    addCurrentLlm(label);
    const summary = await llmLimit(() => summarizeReadme(detailed.readme!, p.owner, p.repo));
    removeCurrentLlm(label);
    detailed.summary = summary;
    incLlmDone();
    if (summary) {
      logLine(`✅ Summarized ${label}`);
    } else {
      logLine(`⚠️  Summarization failed for ${label}`);
    }
  }

  logLine(`⭐ ${detailed.stars ?? '?'} stars | ${detailed.language ?? 'unknown'} | ${label}`);
  incProjectsDone();
  return detailed;
}

interface VideoResult {
  reviewed: ReviewedVideo;
  report: VideoReport | null;
}

async function processVideoWithDescription(
  video: { id: string; title: string; publishedText?: string; uploadDate?: string | null; thumbnails: { url: string }[] },
  description: string,
  state: { videos: ReviewedVideo[] },
): Promise<VideoResult> {
  setCurrentVideo(video.title);

  let projects = parseGitHubUrls(description);

  if (projects.length === 0) {
    logLine(`No GitHub links in description for ${video.title}, checking pinned comment...`);
    const comment = await getPinnedComment(video.id);
    if (comment) {
      projects = parseGitHubUrlsFromComment(comment);
    }
  }

  if (projects.length === 0) {
    logLine(`⚠️  No projects found in ${video.title}`);
    incVideosDone();
    return {
      reviewed: {
        videoId: video.id,
        title: video.title,
        publishedAt: video.publishedText || new Date().toISOString(),
        retrievedAt: new Date().toISOString(),
        projectCount: 0,
      },
      report: null,
    };
  }

  const enrichedProjects = await Promise.all(
    projects.map((p) => projectLimit(() => processProject(p))),
  );

  const report: VideoReport = {
    videoId: video.id,
    title: video.title,
    publishedAt: video.publishedText || new Date().toISOString(),
    uploadDate: video.uploadDate ?? null,
    thumbnailUrl: video.thumbnails[0]?.url || '',
    videoUrl: `https://www.youtube.com/watch?v=${video.id}`,
    projects: enrichedProjects,
  };

  const jsonPath = writeReportJson(report, OUTPUT_DIR);
  logLine(`💾 JSON → ${jsonPath}`);
  incReportsWritten();

  state.videos.push({
    videoId: video.id,
    title: video.title,
    publishedAt: video.publishedText || new Date().toISOString(),
    retrievedAt: new Date().toISOString(),
    projectCount: enrichedProjects.length,
  });
  saveState(STATE_FILE, state);

  incVideosDone();
  return { reviewed: state.videos[state.videos.length - 1], report };
}

// ── Commands ────────────────────────────────────────────────

async function fetch(): Promise<void> {
  validateEnv();

  const state = loadState(STATE_FILE);

  let videos;
  try {
    videos = await getChannelVideos(CHANNEL_ID, 10);
  } catch (err) {
    console.error(`❌ Failed to fetch channel videos: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const newVideos = videos.filter((v) => !isReviewed(state, v.id));
  if (newVideos.length === 0) {
    console.log('✅ No new videos since last run. Exiting.');
    return;
  }

  // Pre-fetch descriptions to discover total project count
  const videoDescriptions = new Map<string, string>();
  let totalProjects = 0;

  for (const video of newVideos) {
    try {
      const desc = await getVideoDescription(video.id);
      if (!desc) {
        console.log(`  ⚠️  Empty description for ${video.title}`);
        continue;
      }
      videoDescriptions.set(video.id, desc);
      let projects = parseGitHubUrls(desc);
      if (projects.length === 0) {
        const comment = await getPinnedComment(video.id);
        if (comment) projects = parseGitHubUrlsFromComment(comment);
      }
      totalProjects += projects.length;

      // Fetch precise upload date for sorting
      video.uploadDate = await getVideoUploadDate(video.id);

      console.log(`  📋 ${video.title}: ${projects.length} projects`);
    } catch (err) {
      console.log(`  ❌ Pre-flight failed for ${video.title}: ${err instanceof Error ? err.message : err}`);
    }
  }

  initDashboard(videoLimit, projectLimit, llmLimit, githubLimit);
  setVideoTotal(newVideos.length);
  setProjectTotal(totalProjects);

  const results = await Promise.all(
    newVideos.map((video) => {
      const description = videoDescriptions.get(video.id) || '';
      return videoLimit(() => processVideoWithDescription(video, description, state));
    }),
  );

  stopDashboard();

  const projectCount = results.reduce((sum, r) => sum + r.reviewed.projectCount, 0);
  console.log(`\n✨ Fetch complete! ${results.length} videos, ${projectCount} projects processed`);
}

async function render(): Promise<void> {
  console.log('🎨 GithubAwesome Monitor — render\n');

  const { renderAllJson } = await import('./render.js');
  renderAllJson(OUTPUT_DIR);

  console.log('\n✨ Render complete!');
}

/**
 * Run fetch + render + git push. Used by both the 'run' command and the daemon.
 */
async function runOnce(): Promise<void> {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  GithubAwesome Monitor — ${new Date().toISOString()}`);
  console.log(`${'═'.repeat(50)}\n`);

  await gitInitOrPull();

  await fetch();
  console.log();
  await render();

  // Commit and push output
  const dateStr = new Date().toISOString().slice(0, 10);
  await gitCommitAndPush(`📡 update reports ${dateStr}`);
}

/**
 * Parse a cron expression (e.g. "0 *\/6 * * *") and return ms until next run.
 * Supports: minute, hour, dayOfMonth, month, dayOfWeek.
 * Handles: wildcard, step (every N), and specific values.
 */
function getNextCronDelay(expression: string): number {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Invalid cron: ${expression}`);

  const [minuteField, hourField, , ,] = parts;

  const parseField = (field: string, min: number, max: number): number[] => {
    if (field === '*') return Array.from({ length: max - min + 1 }, (_, i) => min + i);
    if (field.startsWith('*/')) {
      const step = parseInt(field.slice(2), 10);
      return Array.from({ length: Math.floor((max - min) / step) + 1 }, (_, i) => min + i * step);
    }
    return field.split(',').map(Number);
  };

  const minutes = parseField(minuteField, 0, 59);
  const hours = parseField(hourField, 0, 23);

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Find next occurrence (check next 48 hours)
  for (let offset = 0; offset < 48; offset++) {
    const day = new Date(startOfToday);
    day.setDate(day.getDate() + offset);

    for (const h of hours) {
      for (const m of minutes) {
        const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0);
        if (candidate.getTime() > now.getTime()) {
          return candidate.getTime() - now.getTime();
        }
      }
    }
  }

  // Fallback: 6 hours
  return 6 * 60 * 60 * 1000;
}

/**
 * Daemon mode: runs on a cron schedule, fetches + renders + pushes each cycle.
 */
async function daemon(): Promise<void> {
  if (!CRON_SCHEDULE) {
    console.error('CRON_SCHEDULE is required for daemon mode. e.g. "0 */6 * * *"');
    process.exit(1);
  }

  console.log(`🕐 Daemon mode — schedule: ${CRON_SCHEDULE}\n`);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = true;

  const cleanup = (): void => {
    if (!running) return;
    running = false;
    if (timer) clearTimeout(timer);
    console.log('\n🛑 Shutting down...');
    process.exit(0);
  };

  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  // Run immediately on startup
  try {
    await runOnce();
  } catch (err) {
    console.error(`Run failed: ${err instanceof Error ? err.message : err}`);
  }

  if (!running) return;

  // Schedule subsequent runs
  const scheduleNext = (): void => {
    if (!running) return;
    const delay = getNextCronDelay(CRON_SCHEDULE);
    const next = new Date(Date.now() + delay);
    console.log(`\n⏰ Next run at ${next.toISOString()} (in ${Math.round(delay / 60000)} min)\n`);

    timer = setTimeout(async () => {
      if (!running) return;
      try {
        await runOnce();
      } catch (err) {
        console.error(`Run failed: ${err instanceof Error ? err.message : err}`);
      }
      scheduleNext();
    }, delay);
  };

  scheduleNext();
}

// ── CLI ─────────────────────────────────────────────────────
function printUsage(): void {
  console.log(`Usage: bun run src/index.ts <command>

Commands:
  fetch    Fetch new videos and gather data (writes JSON to output dir)
  render   Render JSON data files to HTML
  run      Fetch + render + git push (one-shot)
  daemon   Run on a CRON_SCHEDULE, fetch + render + push each cycle
  (none)   Same as 'run'

Environment variables:
  CRON_SCHEDULE        Cron expression for daemon mode (e.g. "0 */6 * * *")
  VIDEO_CONCURRENCY    Max parallel videos (default: 3)
  PROJECT_CONCURRENCY  Max parallel project fetches (default: 5)
  LLM_CONCURRENCY      Max parallel LLM calls (default: 3)`);
}

async function main(): Promise<void> {
  const command = process.argv[2];

  switch (command) {
    case 'fetch':
      await fetch();
      break;
    case 'render':
      await render();
      break;
    case 'run':
      await runOnce();
      break;
    case 'daemon':
      await daemon();
      break;
    case undefined:
      await runOnce();
      break;
    case '--help':
    case '-h':
      printUsage();
      break;
    default:
      console.error(`Unknown command: "${command}"\n`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
