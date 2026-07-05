import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isReviewed, loadState, markReviewed, saveState } from './state.js';
import type { ReviewedVideo } from './types.js';

let dir: string;
let stateFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gha-state-test-'));
  stateFile = join(dir, 'nested', 'reviewed.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const video: ReviewedVideo = {
  videoId: 'abc123',
  title: 'Test Video',
  publishedAt: '2026-01-01T00:00:00.000Z',
  retrievedAt: '2026-01-01T00:00:00.000Z',
  projectCount: 2,
};

describe('loadState', () => {
  test('returns an empty state when the file does not exist', () => {
    expect(loadState(stateFile)).toEqual({ videos: [] });
  });

  test('loads a previously saved state', () => {
    saveState(stateFile, { videos: [video] });
    expect(loadState(stateFile)).toEqual({ videos: [video] });
  });
});

describe('saveState', () => {
  test('creates parent directories as needed', () => {
    saveState(stateFile, { videos: [video] });
    expect(loadState(stateFile).videos).toHaveLength(1);
  });
});

describe('isReviewed', () => {
  test('is false for an unknown video id', () => {
    expect(isReviewed({ videos: [video] }, 'unknown')).toBe(false);
  });

  test('is true for a known video id', () => {
    expect(isReviewed({ videos: [video] }, 'abc123')).toBe(true);
  });
});

describe('markReviewed', () => {
  test('returns a new state with the video appended', () => {
    const initial = { videos: [] };
    const updated = markReviewed(initial, video);
    expect(updated.videos).toEqual([video]);
    expect(initial.videos).toEqual([]); // original untouched
  });
});
