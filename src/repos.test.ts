import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRepo, loadRepoState, markStarred, markViewed, saveRepoState, upsertRepo } from './repos.js';
import type { GitHubProject, RepoMention } from './types.js';

let dir: string;
let stateFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gha-repos-test-'));
  stateFile = join(dir, 'nested', 'repos.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeProject(overrides: Partial<GitHubProject> = {}): GitHubProject {
  return {
    owner: 'owner',
    repo: 'repo',
    url: 'https://github.com/owner/repo',
    readme: 'some readme',
    summary: 'a summary',
    description: 'a description',
    stars: 42,
    language: 'TypeScript',
    ...overrides,
  };
}

function makeMention(overrides: Partial<RepoMention> = {}): RepoMention {
  return {
    videoId: 'vid1',
    videoTitle: 'Test Video',
    videoUrl: 'https://www.youtube.com/watch?v=vid1',
    mentionedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('loadRepoState / saveRepoState', () => {
  test('returns an empty state when the file does not exist', () => {
    expect(loadRepoState(stateFile)).toEqual({ repos: [] });
  });

  test('round-trips state through disk, creating parent directories', () => {
    const state = { repos: [] };
    upsertRepo(state, makeProject(), makeMention(), '2026-01-01T00:00:00.000Z');
    saveRepoState(stateFile, state);
    expect(loadRepoState(stateFile)).toEqual(state);
  });
});

describe('upsertRepo', () => {
  test('creates a new entry on first sighting', () => {
    const state = { repos: [] };
    upsertRepo(state, makeProject(), makeMention(), '2026-01-01T00:00:00.000Z');

    const entry = findRepo(state, 'owner', 'repo');
    expect(entry).toBeDefined();
    expect(entry!.firstDiscoveredAt).toBe('2026-01-01T00:00:00.000Z');
    expect(entry!.mentions).toHaveLength(1);
  });

  test('refreshes description/stars/language/summary on a later sighting', () => {
    const state = { repos: [] };
    upsertRepo(state, makeProject({ stars: 10 }), makeMention(), '2026-01-01T00:00:00.000Z');
    upsertRepo(
      state,
      makeProject({ stars: 20, summary: 'updated summary' }),
      makeMention({ videoId: 'vid2' }),
      '2026-02-01T00:00:00.000Z',
    );

    const entry = findRepo(state, 'owner', 'repo');
    expect(entry!.stars).toBe(20);
    expect(entry!.summary).toBe('updated summary');
    expect(entry!.firstDiscoveredAt).toBe('2026-01-01T00:00:00.000Z'); // unchanged
  });

  test('appends a new mention for a different video', () => {
    const state = { repos: [] };
    upsertRepo(state, makeProject(), makeMention({ videoId: 'vid1' }), '2026-01-01T00:00:00.000Z');
    upsertRepo(state, makeProject(), makeMention({ videoId: 'vid2' }), '2026-02-01T00:00:00.000Z');

    const entry = findRepo(state, 'owner', 'repo');
    expect(entry!.mentions).toHaveLength(2);
  });

  test('does not duplicate a mention from the same video', () => {
    const state = { repos: [] };
    upsertRepo(state, makeProject(), makeMention({ videoId: 'vid1' }), '2026-01-01T00:00:00.000Z');
    upsertRepo(state, makeProject(), makeMention({ videoId: 'vid1' }), '2026-01-01T00:00:00.000Z');

    const entry = findRepo(state, 'owner', 'repo');
    expect(entry!.mentions).toHaveLength(1);
  });
});

describe('markViewed', () => {
  test('marks a known repo as viewed and returns true', () => {
    const state = { repos: [] };
    upsertRepo(state, makeProject(), makeMention(), '2026-01-01T00:00:00.000Z');

    expect(markViewed(state, 'owner', 'repo', true)).toBe(true);
    expect(findRepo(state, 'owner', 'repo')!.viewed).toBe(true);
  });

  test('returns false for an unknown repo', () => {
    const state = { repos: [] };
    expect(markViewed(state, 'nope', 'nope', true)).toBe(false);
  });
});

describe('markStarred', () => {
  test('marks a known repo as starred and returns true', () => {
    const state = { repos: [] };
    upsertRepo(state, makeProject(), makeMention(), '2026-01-01T00:00:00.000Z');

    expect(markStarred(state, 'owner', 'repo', true)).toBe(true);
    expect(findRepo(state, 'owner', 'repo')!.starred).toBe(true);
  });

  test('returns false for an unknown repo', () => {
    const state = { repos: [] };
    expect(markStarred(state, 'nope', 'nope', true)).toBe(false);
  });
});
