import 'dotenv/config';
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

/**
 * Process a single GitHub project: fetch details from GitHub API,
 * then summarize the README via LLM.
 */
async function processProject(p: GitHubProject): Promise<GitHubProject> {
  const label = `${p.owner}/${p.repo}`;

  setCurrentProject(label);

  // Fetch README + repo metadata (rate-limited by github.ts internal limiter)
  const detailed = await fetchProjectDetails(p);

  if (!detailed.readme) {
    logLine(`⚠️  No README found for ${label}`);
    detailed.error = 'No README found';
  } else {
    logLine(`📖 README fetched for ${label} (${detailed.readme.length} chars)`);
    // Summarize (rate-limited independently)
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

/**
 * Result of processing a single video.
 */
interface VideoResult {
  reviewed: ReviewedVideo;
  report: VideoReport | null;
}

/**
 * Process a single video with a pre-fetched description.
 * Used when we pre-flight descriptions to count projects before starting.
 */
async function processVideoWithDescription(
  video: { id: string; title: string; publishedText?: string; thumbnails: { url: string }[] },
  description: string,
  state: { videos: ReviewedVideo[] },
): Promise<VideoResult> {
  setCurrentVideo(video.title);

  // Parse GitHub URLs from description
  let projects = parseGitHubUrls(description);

  // Fallback: check pinned comment if no projects found in description
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

  // Fetch GitHub details & summarize each project in parallel
  const enrichedProjects = await Promise.all(
    projects.map((p) => projectLimit(() => processProject(p))),
  );

  // Build report
  const report: VideoReport = {
    videoId: video.id,
    title: video.title,
    publishedAt: video.publishedText || new Date().toISOString(),
    thumbnailUrl: video.thumbnails[0]?.url || '',
    videoUrl: `https://www.youtube.com/watch?v=${video.id}`,
    projects: enrichedProjects,
  };

  // Write intermediate JSON data file
  const jsonPath = writeReportJson(report, OUTPUT_DIR);
  logLine(`💾 JSON → ${jsonPath}`);
  incReportsWritten();

  // Persist state
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

// ── Fetch command ───────────────────────────────────────────
async function fetch(): Promise<void> {
  validateEnv();

  // 1. Load state
  const state = loadState(STATE_FILE);

  // 2. Fetch channel videos
  let videos;
  try {
    videos = await getChannelVideos(CHANNEL_ID, 10);
  } catch (err) {
    console.error(`❌ Failed to fetch channel videos: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // 3. Filter out already-reviewed videos
  const newVideos = videos.filter((v) => !isReviewed(state, v.id));
  if (newVideos.length === 0) {
    console.log('✅ No new videos since last run. Exiting.');
    return;
  }

  // 4. Pre-fetch descriptions to discover total project count for progress bars
  const videoDescriptions = new Map<string, string>();
  const videoProjectCounts = new Map<string, number>();
  let totalProjects = 0;

  for (const video of newVideos) {
    try {
      const desc = await getVideoDescription(video.id);
      videoDescriptions.set(video.id, desc);
      let projects = parseGitHubUrls(desc);
      if (projects.length === 0) {
        const comment = await getPinnedComment(video.id);
        if (comment) projects = parseGitHubUrlsFromComment(comment);
      }
      videoProjectCounts.set(video.id, projects.length);
      totalProjects += projects.length;
    } catch {
      videoProjectCounts.set(video.id, 0);
    }
  }

  initDashboard(videoLimit, projectLimit, llmLimit, githubLimit);
  setVideoTotal(newVideos.length);
  setProjectTotal(totalProjects);

  // 5. Process all new videos in parallel
  const results = await Promise.all(
    newVideos.map((video) =>
      videoLimit(() => processVideoWithDescription(video, videoDescriptions.get(video.id)!, state)),
    ),
  );

  stopDashboard();

  const projectCount = results.reduce((sum, r) => sum + r.reviewed.projectCount, 0);
  console.log(`\n✨ Fetch complete! ${results.length} videos, ${projectCount} projects processed`);
}

// ── Render command ──────────────────────────────────────────
async function render(): Promise<void> {
  console.log('🎨 GithubAwesome Monitor — render\n');

  const { renderAllJson } = await import('./render.js');
  renderAllJson(OUTPUT_DIR);

  console.log('\n✨ Render complete!');
}

// ── CLI ─────────────────────────────────────────────────────
function printUsage(): void {
  console.log(`Usage: bun run src/index.ts <command>

Commands:
  fetch    Fetch new videos and gather data (writes JSON to output dir)
  render   Render JSON data files to HTML
  (none)   Run both fetch and render

Environment variables:
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
    case undefined:
      await fetch();
      console.log();
      await render();
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
