import 'dotenv/config';
import pLimit from 'p-limit';

import { loadState, saveState, isReviewed } from './state.js';
import { getChannelVideos, getPlaylistVideos, getVideoDescription, getVideoUploadDate, getPinnedComment } from './youtube.js';
import { parseGitHubUrls, parseGitHubUrlsFromComment } from './parser.js';
import { fetchProjectDetails } from './github.js';
import { summarizeReadme } from './llm.js';
import { writeReportJson, writeLastChecked } from './render.js';
import { startServer, type RefreshTrigger } from './server.js';
import type { VideoReport, VideoSource, GitHubProject, ReviewedVideo } from './types.js';
import { SOURCES } from './sources.js';

// ── Configuration ──────────────────────────────────────────
const OUTPUT_DIR = process.env.OUTPUT_DIR || './output';
const STATE_FILE = process.env.STATE_FILE || './state/reviewed.json';
const VIDEO_CONCURRENCY = parseInt(process.env.VIDEO_CONCURRENCY || '3', 10);
const PROJECT_CONCURRENCY = parseInt(process.env.PROJECT_CONCURRENCY || '5', 10);
const LLM_CONCURRENCY = parseInt(process.env.LLM_CONCURRENCY || '3', 10);
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '';  // e.g. "0 */6 * * *"

/**
 * Parse CLI args into a command word and a --port option. The command may
 * appear before or after --port (e.g. both "serve --port 8080" and
 * "--port 8080" with no command, defaulting to daemon, are valid).
 */
function parseArgs(argv: string[]): { command?: string; port: number | null } {
  let port: number | null = null;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') {
      port = parseInt(argv[++i], 10);
    } else if (a.startsWith('--port=')) {
      port = parseInt(a.slice('--port='.length), 10);
    } else {
      rest.push(a);
    }
  }
  return { command: rest[0], port };
}

const { command: CLI_COMMAND, port: PORT_ARG } = parseArgs(process.argv.slice(2));
const PORT = PORT_ARG ?? parseInt(process.env.PORT || '8080', 10);

const REQUIRED_ENV_VARS = ['LLM_API_KEY', 'YOUTUBE_API_KEY'];

/**
 * Throws if required env vars are missing. Used inside the fetch pipeline so a
 * refresh triggered from the running server (missing credentials) fails that one
 * run instead of exiting the whole process.
 */
function validateEnv(): void {
  const missing = REQUIRED_ENV_VARS.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}. Check .env.example for required configuration.`);
  }
}

/**
 * Fails fast with a clear message and exit code when a CLI command can never
 * succeed without these vars (fetch/run/daemon).
 */
function validateEnvOrExit(): void {
  const missing = REQUIRED_ENV_VARS.filter((k) => !process.env[k]);
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

// ── Core pipeline ───────────────────────────────────────────

async function processProject(p: GitHubProject): Promise<GitHubProject> {
  const label = `${p.owner}/${p.repo}`;

  const detailed = await fetchProjectDetails(p);

  if (!detailed.readme) {
    console.log(`⚠️  No README found for ${label}`);
    detailed.error = 'No README found';
  } else {
    console.log(`📖 README fetched for ${label} (${detailed.readme.length} chars)`);
    const summary = await llmLimit(() => summarizeReadme(detailed.readme!, p.owner, p.repo));
    detailed.summary = summary;
    console.log(summary ? `✅ Summarized ${label}` : `⚠️  Summarization failed for ${label}`);
  }

  console.log(`⭐ ${detailed.stars ?? '?'} stars | ${detailed.language ?? 'unknown'} | ${label}`);
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
  source?: VideoSource,
): Promise<VideoResult> {
  let projects = parseGitHubUrls(description);

  if (projects.length === 0) {
    console.log(`No GitHub links in description for ${video.title}, checking pinned comment...`);
    const comment = await getPinnedComment(video.id);
    if (comment) {
      projects = parseGitHubUrlsFromComment(comment);
    }
  }

  if (projects.length === 0) {
    console.log(`⚠️  No projects found in ${video.title}`);
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
    ...(source ? { source } : {}),
  };

  const jsonPath = writeReportJson(report, OUTPUT_DIR);
  console.log(`💾 JSON → ${jsonPath}`);

  state.videos.push({
    videoId: video.id,
    title: video.title,
    publishedAt: video.publishedText || new Date().toISOString(),
    retrievedAt: new Date().toISOString(),
    projectCount: enrichedProjects.length,
  });
  saveState(STATE_FILE, state);

  return { reviewed: state.videos[state.videos.length - 1], report };
}

// ── Commands ────────────────────────────────────────────────

async function fetchReports(): Promise<void> {
  validateEnv();
  writeLastChecked(OUTPUT_DIR);

  const state = loadState(STATE_FILE);

  // ── Collect tagged videos from all sources ──────────────
  const taggedVideos: Array<{ video: Awaited<ReturnType<typeof getChannelVideos>>[number]; source: VideoSource }> = [];

  for (const { source, maxVideos = 10 } of SOURCES) {
    try {
      let videos: Awaited<ReturnType<typeof getChannelVideos>>;
      if (source.type === 'channel') {
        videos = await getChannelVideos(source.id, maxVideos);
      } else {
        videos = await getPlaylistVideos(source.id, maxVideos);
      }
      for (const v of videos) taggedVideos.push({ video: v, source });
      console.log(`  ${source.type === 'channel' ? '📺' : '📋'} ${source.label} (${source.type}): ${videos.length} videos fetched`);
    } catch (err) {
      console.error(`❌ Failed to fetch ${source.label}: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (taggedVideos.length === 0) {
    console.error('❌ No videos fetched from any source. Exiting.');
    return;
  }

  // Deduplicate by video ID (keep first occurrence, which preserves source tag)
  const seenIds = new Set<string>();
  const dedupedTagged = taggedVideos.filter(({ video }) => {
    if (seenIds.has(video.id)) return false;
    seenIds.add(video.id);
    return true;
  });

  const newTagged = dedupedTagged.filter(({ video }) => !isReviewed(state, video.id));
  if (newTagged.length === 0) {
    console.log('✅ No new videos since last run. Exiting.');
    return;
  }

  const videoDescriptions = new Map<string, string>();

  for (const { video } of newTagged) {
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

      // Fetch precise upload date for sorting
      video.uploadDate = await getVideoUploadDate(video.id);

      console.log(`  📋 ${video.title}: ${projects.length} projects`);
    } catch (err) {
      console.log(`  ❌ Pre-flight failed for ${video.title}: ${err instanceof Error ? err.message : err}`);
    }
  }

  const results = await Promise.all(
    newTagged.map(({ video, source }) => {
      const description = videoDescriptions.get(video.id) || '';
      return videoLimit(() => processVideoWithDescription(video, description, state, source));
    }),
  );

  const projectCount = results.reduce((sum, r) => sum + r.reviewed.projectCount, 0);
  console.log(`\n✨ Fetch complete! ${results.length} videos, ${projectCount} projects processed`);
}

async function render(): Promise<void> {
  console.log('🎨 GithubAwesome Monitor — render\n');

  const { renderAllJson } = await import('./render.js');
  renderAllJson(OUTPUT_DIR);

  console.log('\n✨ Render complete!');
}

let isRunning = false;

/**
 * Run fetch + render while tracking `isRunning`, so overlapping triggers
 * (scheduled cron run vs. manual refresh) can be detected and skipped.
 */
async function runOnceTracked(): Promise<void> {
  isRunning = true;
  try {
    await runOnce();
  } finally {
    isRunning = false;
  }
}

/**
 * Kick off a run in the background if one isn't already in progress.
 * Used by the "Refresh" button on the index page.
 */
function triggerRefresh(): 'started' | 'already_running' {
  if (isRunning) return 'already_running';
  runOnceTracked().catch((err) => console.error(`Run failed: ${err instanceof Error ? err.message : err}`));
  return 'started';
}

/**
 * Run fetch + render. Used by both the 'run' command and each daemon cycle.
 */
async function runOnce(): Promise<void> {
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  GithubAwesome Monitor — ${new Date().toISOString()}`);
  console.log(`${'═'.repeat(50)}\n`);

  await fetchReports();
  console.log();
  await render();
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
 * Daemon mode: starts the self-serving HTTP server immediately (serving whatever
 * reports already exist on disk), then fetches + renders on a CRON_SCHEDULE,
 * updating the same output directory the server reads from.
 */
async function daemon(): Promise<void> {
  if (!CRON_SCHEDULE) {
    console.error('CRON_SCHEDULE is required for daemon mode. e.g. "0 */6 * * *"');
    process.exit(1);
  }
  validateEnvOrExit();

  startServer(OUTPUT_DIR, PORT, triggerRefresh);

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
    await runOnceTracked();
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
      if (isRunning) {
        console.log('⏭  Skipping scheduled run — a refresh is already in progress');
      } else {
        try {
          await runOnceTracked();
        } catch (err) {
          console.error(`Run failed: ${err instanceof Error ? err.message : err}`);
        }
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
  run      Fetch + render (one-shot, no server)
  serve    Start the HTTP server only (serves existing output dir)
  daemon   Start the HTTP server and fetch + render on a CRON_SCHEDULE
  (none)   Same as 'daemon'

Options:
  --port <n>           Port for the built-in HTTP server (overrides PORT env var)

Environment variables:
  PORT                 Port for the built-in HTTP server (default: 8080)
  CRON_SCHEDULE        Cron expression for daemon mode (e.g. "0 */6 * * *")
  VIDEO_CONCURRENCY    Max parallel videos (default: 3)
  PROJECT_CONCURRENCY  Max parallel project fetches (default: 5)
  LLM_CONCURRENCY      Max parallel LLM calls (default: 3)`);
}

async function main(): Promise<void> {
  const command = CLI_COMMAND;

  switch (command) {
    case 'fetch':
      validateEnvOrExit();
      await fetchReports();
      break;
    case 'render':
      await render();
      break;
    case 'run':
      validateEnvOrExit();
      await runOnce();
      break;
    case 'serve':
      startServer(OUTPUT_DIR, PORT, triggerRefresh);
      break;
    case 'daemon':
    case undefined:
      await daemon();
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
