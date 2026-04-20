import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { StateFile, ReviewedVideo } from './types.js';

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
