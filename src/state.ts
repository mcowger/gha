import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { StateFile, ReviewedVideo, RepoStateFile } from './types.js';

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
 * Reconcile state with mentions already recorded in the repo state (e.g. a
 * state file lost to a fresh volume/worktree, while output/repos.json
 * survived). Any video mentioned in repoState but not yet tracked in state is
 * marked reviewed so it isn't reprocessed.
 */
export function reconcileStateWithRepos(state: StateFile, repoState: RepoStateFile): StateFile {
  const known = new Set(state.videos.map((v) => v.videoId));
  const mentionsByVideo = new Map<string, { title: string; publishedAt: string; count: number }>();

  for (const repo of repoState.repos) {
    for (const m of repo.mentions) {
      const entry = mentionsByVideo.get(m.videoId);
      if (entry) {
        entry.count += 1;
      } else {
        mentionsByVideo.set(m.videoId, { title: m.videoTitle, publishedAt: m.mentionedAt, count: 1 });
      }
    }
  }

  for (const [videoId, info] of mentionsByVideo) {
    if (known.has(videoId)) continue;
    known.add(videoId);
    state.videos.push({
      videoId,
      title: info.title,
      publishedAt: info.publishedAt,
      retrievedAt: new Date().toISOString(),
      projectCount: info.count,
    });
  }

  return state;
}
