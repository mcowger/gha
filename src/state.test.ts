import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isReviewed, loadState, markReviewed, reconcileStateWithOutput, saveState } from './state.js';
import type { ReviewedVideo, VideoReport } from './types.js';

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

describe('reconcileStateWithOutput', () => {
  function makeReport(overrides: Partial<VideoReport> = {}): VideoReport {
    return {
      videoId: 'vid1',
      title: 'Test Video',
      publishedAt: '2026-01-01T00:00:00.000Z',
      uploadDate: '2026-01-01T00:00:00.000Z',
      thumbnailUrl: 'https://example.com/thumb.jpg',
      videoUrl: 'https://www.youtube.com/watch?v=vid1',
      projects: [],
      ...overrides,
    };
  }

  test('marks reports already on disk as reviewed without touching known ones', () => {
    writeFileSync(join(dir, 'ghawesome-2026-01-01-vid1.json'), JSON.stringify(makeReport()));
    const state = reconcileStateWithOutput({ videos: [] }, dir);
    expect(state.videos).toHaveLength(1);
    expect(state.videos[0].videoId).toBe('vid1');
  });

  test('does not duplicate an entry already tracked in state', () => {
    writeFileSync(join(dir, 'ghawesome-2026-01-01-vid1.json'), JSON.stringify(makeReport()));
    const state = reconcileStateWithOutput({ videos: [video] }, dir);
    expect(state.videos.filter((v) => v.videoId === video.videoId)).toHaveLength(1);
  });

  test('collapses duplicate reports for the same video, keeping the earliest and deleting the rest', () => {
    writeFileSync(join(dir, 'ghawesome-2026-01-01-vid1.json'), JSON.stringify(makeReport()));
    writeFileSync(join(dir, 'ghawesome-2026-02-01-vid1.json'), JSON.stringify(makeReport()));
    writeFileSync(join(dir, 'ghawesome-2026-02-01-vid1.html'), '<html></html>');

    const state = reconcileStateWithOutput({ videos: [] }, dir);

    expect(state.videos).toHaveLength(1);
    expect(existsSync(join(dir, 'ghawesome-2026-01-01-vid1.json'))).toBe(true);
    expect(existsSync(join(dir, 'ghawesome-2026-02-01-vid1.json'))).toBe(false);
    expect(existsSync(join(dir, 'ghawesome-2026-02-01-vid1.html'))).toBe(false);
  });

  test('returns state unchanged when outputDir does not exist', () => {
    const state = reconcileStateWithOutput({ videos: [video] }, join(dir, 'nonexistent'));
    expect(state.videos).toEqual([video]);
  });

  test('ignores unrelated and malformed files', () => {
    writeFileSync(join(dir, 'not-a-report.json'), '{}');
    writeFileSync(join(dir, 'ghawesome-2026-01-01-vidbad.json'), 'not json');
    const files = readdirSync(dir);
    expect(files.length).toBe(2);
    expect(() => reconcileStateWithOutput({ videos: [] }, dir)).not.toThrow();
  });
});
