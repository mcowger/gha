import 'dotenv/config';
import { execSync } from 'node:child_process';
import pLimit from 'p-limit';

import { loadState, saveState, isReviewed } from './state.js';
import { getChannelVideos, getVideoDescription, getPinnedComment } from './youtube.js';
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

function gitCommitAndPush(message: string): void {
  try {
    execSync('git add output/ state/', { stdio: 'pipe' });
    // Only commit if there are changes
    const status = execSync('git status --porcelain output/ state/', { encoding: 'utf-8' }).trim();
    if (!status) {
      console.log('  📭 No changes to commit');
      return;
    }
    execSync(`git commit -m "${message}"`, { stdio: 'pipe' });
    execSync('git push', { stdio: 'pipe' });
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
  video: { id: string; title: string; publishedText?: string; thumbnails: { url: string }[] },
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

  await fetch();
  console.log();
  await render();

  // Commit and push output
  const dateStr = new Date().toISOString().slice(0, 10);
  gitCommitAndPush(`📡 update reports ${dateStr}`);
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

  // Run immediately on startup
  try {
    await runOnce();
  } catch (err) {
    console.error(`Run failed: ${err instanceof Error ? err.message : err}`);
  }

  // Schedule subsequent runs
  const scheduleNext = (): void => {
    const delay = getNextCronDelay(CRON_SCHEDULE);
    const next = new Date(Date.now() + delay);
    console.log(`\n⏰ Next run at ${next.toISOString()} (in ${Math.round(delay / 60000)} min)\n`);

    setTimeout(async () => {
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
