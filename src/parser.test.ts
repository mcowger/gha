import { describe, expect, test } from 'bun:test';
import { parseGitHubUrls, parseGitHubUrlsFromComment } from './parser.js';

describe('parseGitHubUrls', () => {
  test('extracts owner/repo from a plain URL', () => {
    const projects = parseGitHubUrls('00:12 - agentic-inbox https://github.com/cloudflare/agentic-inbox');
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      owner: 'cloudflare',
      repo: 'agentic-inbox',
      url: 'https://github.com/cloudflare/agentic-inbox',
    });
  });

  test('extracts multiple projects from a multi-line description', () => {
    const desc = [
      '00:12 - agentic-inbox https://github.com/cloudflare/agentic-inbox',
      '00:40 - Dawarich https://github.com/Freika/dawarich',
    ].join('\n');
    const projects = parseGitHubUrls(desc);
    expect(projects.map((p) => `${p.owner}/${p.repo}`)).toEqual([
      'cloudflare/agentic-inbox',
      'Freika/dawarich',
    ]);
  });

  test('works without a protocol prefix', () => {
    const projects = parseGitHubUrls('check out github.com/owner/repo');
    expect(projects).toHaveLength(1);
    expect(projects[0].owner).toBe('owner');
    expect(projects[0].repo).toBe('repo');
  });

  test('strips trailing punctuation and query params from repo names', () => {
    const projects = parseGitHubUrls('link: https://github.com/owner/repo?tab=readme, more text');
    expect(projects).toHaveLength(1);
    expect(projects[0].repo).toBe('repo');
  });

  test('deduplicates repeated owner/repo pairs', () => {
    const desc = 'https://github.com/owner/repo and again https://github.com/owner/repo';
    const projects = parseGitHubUrls(desc);
    expect(projects).toHaveLength(1);
  });

  test('skips non-repo GitHub pages', () => {
    const desc = [
      'https://github.com/features/copilot',
      'https://github.com/pricing',
      'https://github.com/owner/repo',
    ].join('\n');
    const projects = parseGitHubUrls(desc);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ owner: 'owner', repo: 'repo' });
  });

  test('returns an empty array when there are no GitHub links', () => {
    expect(parseGitHubUrls('just some text, no links here')).toEqual([]);
  });

  test('initializes new project fields to null', () => {
    const [project] = parseGitHubUrls('https://github.com/owner/repo');
    expect(project.readme).toBeNull();
    expect(project.summary).toBeNull();
    expect(project.description).toBeNull();
    expect(project.stars).toBeNull();
    expect(project.language).toBeNull();
  });
});

describe('parseGitHubUrlsFromComment', () => {
  test('delegates to parseGitHubUrls', () => {
    const projects = parseGitHubUrlsFromComment('pinned comment: https://github.com/owner/repo');
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ owner: 'owner', repo: 'repo' });
  });
});
