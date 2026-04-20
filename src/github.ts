import { Octokit } from '@octokit/rest';
import pLimit from 'p-limit';
import type { GitHubProject } from './types.js';

/** Concurrency limiter for GitHub API calls — keeps us under rate limits. */
export const githubLimit = pLimit({ concurrency: 5 });

let _octokit: Octokit | null = null;
let _authed: boolean | null = null;

function getOctokit(): Octokit {
  if (!_octokit) {
    const token = process.env.GH_TOKEN;
    _authed = !!token;
    if (!token) {
      console.warn('⚠️  No GH_TOKEN set. Unauthenticated API limit is 60 requests/hour — likely insufficient for a full run.');
    }
    _octokit = new Octokit(token ? { auth: token } : {});
  }
  return _octokit;
}

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Execute an Octokit API call with automatic retry on rate-limit (429) responses.
 * Uses exponential backoff with jitter.
 * Throws immediately on 403 (forbidden/auth) — no point retrying those.
 */
async function withRetry<T>(fn: () => Promise<T>, retries: number = 3): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.status || err?.response?.status;

      // 403 = forbidden (no auth, or auth lacks scope). Don't retry — throw immediately.
      if (status === 403) {
        const msg = err?.response?.data?.message || err.message || '';
        // GitHub sometimes wraps rate limit in 403 with a specific message
        if (msg.includes('rate limit') || msg.includes('API rate limit')) {
          // This IS a rate limit in disguise — retry it
          if (attempt < retries) {
            const retryAfter = err?.response?.headers?.['retry-after'];
            const resetTime = err?.response?.headers?.['x-ratelimit-reset'];
            let waitMs: number;
            if (retryAfter) {
              waitMs = parseInt(retryAfter, 10) * 1000;
            } else if (resetTime) {
              // Wait until the reset timestamp
              waitMs = Math.max(parseInt(resetTime, 10) * 1000 - Date.now(), 2000);
            } else {
              const base = Math.pow(2, attempt + 1) * 1000;
              const jitter = Math.random() * 1000;
              waitMs = base + jitter;
            }
            console.warn(`    ⏳ Rate limited (403 rate limit), retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${retries})`);
            await sleep(waitMs);
            continue;
          }
        }
        // Genuine 403 — no point retrying
        throw err;
      }

      // 429 = explicit rate limit. Retry with backoff.
      if (status === 429 && attempt < retries) {
        const retryAfter = err?.response?.headers?.['retry-after'];
        let waitMs: number;
        if (retryAfter) {
          waitMs = parseInt(retryAfter, 10) * 1000;
        } else {
          const base = Math.pow(2, attempt + 1) * 1000;
          const jitter = Math.random() * 1000;
          waitMs = base + jitter;
        }
        console.warn(`    ⏳ Rate limited (429), retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${retries})`);
        await sleep(waitMs);
        continue;
      }

      // 404 = not found. Not an error worth retrying.
      // Anything else — just throw.
      throw err;
    }
  }
  throw new Error('Max retries exceeded');
}

/**
 * Fetch the README content for a GitHub repository.
 * Uses the GitHub API's built-in getReadme() which automatically
 * resolves the default README file regardless of casing.
 */
export async function fetchReadme(
  owner: string,
  repo: string,
): Promise<string | null> {
  const octokit = getOctokit();
  try {
    const { data } = await withRetry(() =>
      octokit.rest.repos.getReadme({ owner, repo }),
    );
    return Buffer.from(data.content, 'base64').toString('utf-8');
  } catch (err: any) {
    const status = err?.status;
    // 404 = no README, that's fine
    if (status === 404) return null;
    // 403 = auth issue, log a clear warning
    if (status === 403) {
      console.warn(`    🔒 403 Forbidden for ${owner}/${repo} README — GitHub token may be missing or rate limited`);
      return null;
    }
    // Other errors — log but don't crash
    console.warn(`    ❌ Error fetching README for ${owner}/${repo}: ${err.message}`);
    return null;
  }
}

/**
 * Fetch repository metadata (description, stars, language).
 */
export async function fetchRepoInfo(
  owner: string,
  repo: string,
): Promise<Pick<GitHubProject, 'description' | 'stars' | 'language'>> {
  const octokit = getOctokit();
  try {
    const { data } = await withRetry(() =>
      octokit.rest.repos.get({ owner, repo }),
    );
    return {
      description: data.description,
      stars: data.stargazers_count,
      language: data.language,
    };
  } catch (err: any) {
    const status = err?.status;
    if (status === 403) {
      console.warn(`    🔒 403 Forbidden for ${owner}/${repo} info — GitHub token may be missing or rate limited`);
    } else if (status !== 404) {
      console.warn(`    ❌ Error fetching info for ${owner}/${repo}: ${err.message}`);
    }
    return { description: null, stars: null, language: null };
  }
}

/**
 * Fetch both README and repo metadata concurrently (within the GitHub rate limiter).
 * If repo info returns a 403 (rate limit hit), skips the README call too.
 */
export async function fetchProjectDetails(
  project: GitHubProject,
): Promise<GitHubProject> {
  // Fetch repo info first (through the concurrency limiter)
  const repoInfo = await githubLimit(() => fetchRepoInfo(project.owner, project.repo));

  // If we got a 403 on repo info (no data), skip the README call too
  if (repoInfo.description === null && repoInfo.stars === null && repoInfo.language === null) {
    return {
      ...project,
      readme: null,
      description: null,
      stars: null,
      language: null,
      error: 'GitHub API unavailable (rate limited or auth required)',
    };
  }

  // Fetch README concurrently with other projects' API calls (through the limiter)
  const readme = await githubLimit(() => fetchReadme(project.owner, project.repo));

  return {
    ...project,
    readme,
    description: repoInfo.description,
    stars: repoInfo.stars,
    language: repoInfo.language,
  };
}
