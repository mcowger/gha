import 'dotenv/config';
import { describe, expect, test } from 'bun:test';
import { fetchProjectDetails, fetchReadme, fetchRepoInfo } from './github.js';

// octocat/Hello-World is GitHub's own long-lived test fixture repo.
const OWNER = 'octocat';
const REPO = 'Hello-World';

const hasToken = !!process.env.GH_TOKEN;
const liveEnabled = process.env.RUN_LIVE_TESTS === '1' && hasToken;

describe.skipIf(!liveEnabled)('github.ts (live GitHub API)', () => {
  test('fetchReadme returns README content for a known public repo', async () => {
    const readme = await fetchReadme(OWNER, REPO);
    expect(readme).toBeTruthy();
    expect(readme!.length).toBeGreaterThan(0);
  });

  test('fetchReadme returns null for a nonexistent repo (404)', async () => {
    const readme = await fetchReadme(OWNER, 'this-repo-should-not-exist-xyz-123');
    expect(readme).toBeNull();
  });

  test('fetchRepoInfo returns stars/language/description for a known repo', async () => {
    const info = await fetchRepoInfo(OWNER, REPO);
    expect(typeof info.stars).toBe('number');
    expect(info.stars).toBeGreaterThan(0);
  });

  test('fetchRepoInfo returns nulls for a nonexistent repo (404)', async () => {
    const info = await fetchRepoInfo(OWNER, 'this-repo-should-not-exist-xyz-123');
    expect(info).toEqual({ description: null, stars: null, language: null });
  });

  test('fetchProjectDetails enriches a parsed project with README and metadata', async () => {
    const project = await fetchProjectDetails({
      owner: OWNER,
      repo: REPO,
      url: `https://github.com/${OWNER}/${REPO}`,
      readme: null,
      summary: null,
      description: null,
      stars: null,
      language: null,
    });
    expect(project.readme).toBeTruthy();
    expect(project.stars).toBeGreaterThan(0);
    expect(project.error).toBeUndefined();
  });
});
