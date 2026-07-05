import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isReviewed, loadState, markReviewed, reconcileStateWithRepos, saveState } from './state.js';
import type { ReviewedVideo, RepoStateFile } from './types.js';

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

describe('reconcileStateWithRepos', () => {
  function makeRepoState(videoId: string, videoTitle: string, mentionedAt: string): RepoStateFile {
    return {
      repos: [
        {
          owner: 'owner',
          repo: 'repo',
          url: 'https://github.com/owner/repo',
          description: null,
          stars: null,
          language: null,
          summary: null,
          firstDiscoveredAt: mentionedAt,
          mentions: [{ videoId, videoTitle, videoUrl: `https://youtu.be/${videoId}`, mentionedAt }],
        },
      ],
    };
  }

  test('marks videos mentioned in repo state as reviewed without touching known ones', () => {
    const repoState = makeRepoState('vid1', 'Video One', '2026-01-01T00:00:00.000Z');
    const state = reconcileStateWithRepos({ videos: [] }, repoState);
    expect(state.videos).toHaveLength(1);
    expect(state.videos[0].videoId).toBe('vid1');
  });

  test('does not duplicate an entry already tracked in state', () => {
    const repoState = makeRepoState('abc123', 'Test Video', '2026-01-01T00:00:00.000Z');
    const state = reconcileStateWithRepos({ videos: [video] }, repoState);
    expect(state.videos.filter((v) => v.videoId === video.videoId)).toHaveLength(1);
  });

  test('counts multiple mentions of the same video as its project count', () => {
    const repoState: RepoStateFile = {
      repos: [
        {
          owner: 'a', repo: 'first', url: 'https://github.com/a/first',
          description: null, stars: null, language: null, summary: null,
          firstDiscoveredAt: '2026-01-01T00:00:00.000Z',
          mentions: [{ videoId: 'vid1', videoTitle: 'Video', videoUrl: 'https://youtu.be/vid1', mentionedAt: '2026-01-01T00:00:00.000Z' }],
        },
        {
          owner: 'b', repo: 'second', url: 'https://github.com/b/second',
          description: null, stars: null, language: null, summary: null,
          firstDiscoveredAt: '2026-01-01T00:00:00.000Z',
          mentions: [{ videoId: 'vid1', videoTitle: 'Video', videoUrl: 'https://youtu.be/vid1', mentionedAt: '2026-01-01T00:00:00.000Z' }],
        },
      ],
    };
    const state = reconcileStateWithRepos({ videos: [] }, repoState);
    expect(state.videos).toHaveLength(1);
    expect(state.videos[0].projectCount).toBe(2);
  });

  test('returns state unchanged when repo state is empty', () => {
    const state = reconcileStateWithRepos({ videos: [video] }, { repos: [] });
    expect(state.videos).toEqual([video]);
  });
});
