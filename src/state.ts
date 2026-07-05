import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { StateFile, ReviewedVideo, VideoReport } from './types.js';

const DEFAULT_STATE: StateFile = { videos: [] };

export function loadState(filePath: string): StateFile {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as StateFile;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(filePath: string, state: StateFile): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

export function isReviewed(state: StateFile, videoId: string): boolean {
  return state.videos.some((v) => v.videoId === videoId);
}

export function markReviewed(
  state: StateFile,
  video: ReviewedVideo,
): StateFile {
  return {
    videos: [...state.videos, video],
  };
}

/**
 * Reconcile state with report JSON files already present in OUTPUT_DIR (e.g.
 * seed data shipped without a matching state file, or a state file lost to a
 * fresh volume/worktree). Any report not yet tracked in state is marked
 * reviewed so it isn't reprocessed. Duplicate reports for the same video
 * (created by re-running before this reconciliation existed) are collapsed,
 * keeping the earliest dated file and deleting the rest from disk.
 */
export function reconcileStateWithOutput(state: StateFile, outputDir: string): StateFile {
  let jsonFiles: string[];
  try {
    jsonFiles = readdirSync(outputDir)
      .filter((f) => f.startsWith('ghawesome-') && f.endsWith('.json'))
      .sort();
  } catch {
    return state;
  }

  const known = new Set(state.videos.map((v) => v.videoId));
  const keptFileByVideoId = new Map<string, string>();

  for (const filename of jsonFiles) {
    let report: VideoReport;
    try {
      report = JSON.parse(readFileSync(join(outputDir, filename), 'utf-8')) as VideoReport;
    } catch {
      continue;
    }

    if (keptFileByVideoId.has(report.videoId)) {
      unlinkSync(join(outputDir, filename));
      try {
        unlinkSync(join(outputDir, filename.replace(/\.json$/, '.html')));
      } catch {
        // No matching .html to remove; ignore.
      }
      continue;
    }
    keptFileByVideoId.set(report.videoId, filename);

    if (!known.has(report.videoId)) {
      known.add(report.videoId);
      state.videos.push({
        videoId: report.videoId,
        title: report.title,
        publishedAt: report.publishedAt,
        retrievedAt: new Date().toISOString(),
        projectCount: report.projects.length,
      });
    }
  }

  return state;
}
