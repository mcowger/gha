import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { generateRepoFeedHtml } from './html.js';
import type { RepoStateFile } from './types.js';

const LAST_CHECKED_FILENAME = 'last-checked.json';

/**
 * Record the time the app last checked sources for new videos.
 */
export function writeLastChecked(outputDir: string, checkedAt: string = new Date().toISOString()): void {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, LAST_CHECKED_FILENAME), JSON.stringify({ checkedAt }), 'utf-8');
}

export function readLastChecked(outputDir: string): string | null {
  try {
    const raw = readFileSync(join(outputDir, LAST_CHECKED_FILENAME), 'utf-8');
    return (JSON.parse(raw) as { checkedAt: string }).checkedAt;
  } catch {
    return null;
  }
}

/**
 * Render the repo feed (index.html) from repo state, newest discoveries
 * first, excluding repos already marked viewed. Returns the path of the
 * written file.
 */
export function renderRepoFeed(outputDir: string, state: RepoStateFile): string {
  mkdirSync(outputDir, { recursive: true });

  const sorted = [...state.repos]
    .filter((r) => !r.viewed)
    .sort((a, b) => b.firstDiscoveredAt.localeCompare(a.firstDiscoveredAt));
  const html = generateRepoFeedHtml(sorted, readLastChecked(outputDir), false);

  const indexPath = join(outputDir, 'index.html');
  writeFileSync(indexPath, html, 'utf-8');
  return indexPath;
}
