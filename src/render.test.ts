import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderRepoFeed, writeLastChecked } from './render.js';
import type { RepoEntry, RepoStateFile } from './types.js';

let outputDir: string;

beforeEach(() => {
  outputDir = mkdtempSync(join(tmpdir(), 'gha-render-test-'));
});

afterEach(() => {
  rmSync(outputDir, { recursive: true, force: true });
});

function makeRepo(overrides: Partial<RepoEntry> = {}): RepoEntry {
  return {
    owner: 'owner',
    repo: 'repo',
    url: 'https://github.com/owner/repo',
    description: 'a description',
    stars: 42,
    language: 'TypeScript',
    summary: 'a summary',
    firstDiscoveredAt: '2026-01-01T00:00:00.000Z',
    mentions: [
      {
        videoId: 'vid1',
        videoTitle: 'Test Video',
        videoUrl: 'https://www.youtube.com/watch?v=vid1',
        mentionedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

describe('renderRepoFeed', () => {
  test('writes index.html containing every repo, newest discovery first', () => {
    const state: RepoStateFile = {
      repos: [
        makeRepo({ owner: 'a', repo: 'first', firstDiscoveredAt: '2026-01-01T00:00:00.000Z' }),
        makeRepo({ owner: 'b', repo: 'second', firstDiscoveredAt: '2026-02-01T00:00:00.000Z' }),
      ],
    };

    const indexPath = renderRepoFeed(outputDir, state);
    expect(existsSync(indexPath)).toBe(true);

    const html = readFileSync(indexPath, 'utf-8');
    expect(html.indexOf('b/second')).toBeLessThan(html.indexOf('a/first'));
  });

  test('renders an empty list without throwing', () => {
    const indexPath = renderRepoFeed(outputDir, { repos: [] });
    expect(existsSync(indexPath)).toBe(true);
  });

  test('excludes repos marked viewed', () => {
    const state: RepoStateFile = {
      repos: [
        makeRepo({ owner: 'a', repo: 'unviewed' }),
        makeRepo({ owner: 'b', repo: 'seen', viewed: true }),
      ],
    };

    const indexPath = renderRepoFeed(outputDir, state);
    const html = readFileSync(indexPath, 'utf-8');
    expect(html).toContain('a/unviewed');
    expect(html).not.toContain('b/seen');
  });
});

describe('writeLastChecked', () => {
  test('is picked up by a subsequent renderRepoFeed call', () => {
    writeLastChecked(outputDir, '2026-01-01T12:00:00.000Z');
    const indexPath = renderRepoFeed(outputDir, { repos: [] });
    const html = readFileSync(indexPath, 'utf-8');
    expect(html).toContain('data-checked-at="2026-01-01T12:00:00.000Z"');
  });
});
