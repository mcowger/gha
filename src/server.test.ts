import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './server.js';
import { loadRepoState, saveRepoState, upsertRepo } from './repos.js';
import type { GitHubProject, RepoMention, RepoStateFile } from './types.js';

let outputDir: string;
let repoStateFile: string;
let port: number;
let baseUrl: string;

function makeProject(overrides: Partial<GitHubProject> = {}): GitHubProject {
  return {
    owner: 'owner',
    repo: 'repo',
    url: 'https://github.com/owner/repo',
    readme: null,
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

beforeEach(() => {
  outputDir = mkdtempSync(join(tmpdir(), 'gha-server-test-'));
  repoStateFile = join(outputDir, 'repos.json');
  port = 20000 + Math.floor(Math.random() * 10000);
  baseUrl = `http://localhost:${port}`;
  startServer(outputDir, port, repoStateFile);
});

afterEach(() => {
  rmSync(outputDir, { recursive: true, force: true });
});

describe('GET /', () => {
  test('excludes repos marked viewed by default', async () => {
    const state: RepoStateFile = { repos: [] };
    upsertRepo(state, makeProject({ owner: 'a', repo: 'unviewed' }), makeMention(), '2026-01-01T00:00:00.000Z');
    upsertRepo(state, makeProject({ owner: 'b', repo: 'seen' }), makeMention(), '2026-01-01T00:00:00.000Z');
    state.repos[1].viewed = true;
    saveRepoState(repoStateFile, state);

    const html = await (await fetch(baseUrl + '/')).text();
    expect(html).toContain('a/unviewed');
    expect(html).not.toContain('b/seen');
  });

  test('includes viewed repos when ?all=true is passed', async () => {
    const state: RepoStateFile = { repos: [] };
    upsertRepo(state, makeProject({ owner: 'b', repo: 'seen' }), makeMention(), '2026-01-01T00:00:00.000Z');
    state.repos[0].viewed = true;
    saveRepoState(repoStateFile, state);

    const html = await (await fetch(baseUrl + '/?all=true')).text();
    expect(html).toContain('b/seen');
  });
});

describe('POST /api/viewed', () => {
  test('marks a known repo as viewed and persists it', async () => {
    const state: RepoStateFile = { repos: [] };
    upsertRepo(state, makeProject(), makeMention(), '2026-01-01T00:00:00.000Z');
    saveRepoState(repoStateFile, state);

    const res = await fetch(baseUrl + '/api/viewed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'owner', repo: 'repo' }),
    });
    expect(res.status).toBe(200);

    const updated = loadRepoState(repoStateFile);
    expect(updated.repos[0].viewed).toBe(true);
  });

  test('returns 404 for an unknown repo', async () => {
    saveRepoState(repoStateFile, { repos: [] });

    const res = await fetch(baseUrl + '/api/viewed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'nope', repo: 'nope' }),
    });
    expect(res.status).toBe(404);
  });

  test('returns 400 when owner/repo are missing', async () => {
    const res = await fetch(baseUrl + '/api/viewed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test('returns 405 for non-POST requests', async () => {
    const res = await fetch(baseUrl + '/api/viewed');
    expect(res.status).toBe(405);
  });
});

describe('POST /api/star', () => {
  test('returns 404 for an unknown repo (never reaches the GitHub API)', async () => {
    saveRepoState(repoStateFile, { repos: [] });

    const res = await fetch(baseUrl + '/api/star', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'nope', repo: 'nope' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/lists', () => {
  test('returns 404 for an unknown repo (never reaches the GitHub API)', async () => {
    saveRepoState(repoStateFile, { repos: [] });

    const res = await fetch(baseUrl + '/api/lists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'nope', repo: 'nope', listId: 'UL_1' }),
    });
    expect(res.status).toBe(404);
  });

  test('returns 400 when listId is missing', async () => {
    const res = await fetch(baseUrl + '/api/lists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'owner', repo: 'repo' }),
    });
    expect(res.status).toBe(400);
  });

  test('returns 405 for non-POST requests', async () => {
    const res = await fetch(baseUrl + '/api/lists');
    expect(res.status).toBe(405);
  });
});
