import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GitHubProject, RepoEntry, RepoMention, RepoStateFile } from './types.js';

const DEFAULT_STATE: RepoStateFile = { repos: [] };

export function loadRepoState(filePath: string): RepoStateFile {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as RepoStateFile;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveRepoState(filePath: string, state: RepoStateFile): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

export function findRepo(state: RepoStateFile, owner: string, repo: string): RepoEntry | undefined {
  return state.repos.find((r) => r.owner === owner && r.repo === repo);
}

/**
 * Insert or update a repo entry: creates a new entry on first sighting,
 * refreshes description/stars/language/summary from the latest fetch, and
 * appends a mention for each mentioning video (deduped by videoId).
 */
export function upsertRepo(
  state: RepoStateFile,
  project: GitHubProject,
  mention: RepoMention,
  discoveredAt: string = new Date().toISOString(),
): RepoStateFile {
  const existing = findRepo(state, project.owner, project.repo);

  if (!existing) {
    state.repos.push({
      owner: project.owner,
      repo: project.repo,
      url: project.url,
      description: project.description,
      stars: project.stars,
      language: project.language,
      summary: project.summary,
      firstDiscoveredAt: discoveredAt,
      mentions: [mention],
    });
    return state;
  }

  existing.description = project.description ?? existing.description;
  existing.stars = project.stars ?? existing.stars;
  existing.language = project.language ?? existing.language;
  existing.summary = project.summary ?? existing.summary;

  if (!existing.mentions.some((m) => m.videoId === mention.videoId)) {
    existing.mentions.push(mention);
  }

  return state;
}

/**
 * Mark a repo as viewed/unviewed. Returns false if the repo isn't tracked.
 */
export function markViewed(state: RepoStateFile, owner: string, repo: string, viewed: boolean): boolean {
  const entry = findRepo(state, owner, repo);
  if (!entry) return false;
  entry.viewed = viewed;
  return true;
}

/**
 * Mark a repo as starred/unstarred. Returns false if the repo isn't tracked.
 */
export function markStarred(state: RepoStateFile, owner: string, repo: string, starred: boolean): boolean {
  const entry = findRepo(state, owner, repo);
  if (!entry) return false;
  entry.starred = starred;
  return true;
}
