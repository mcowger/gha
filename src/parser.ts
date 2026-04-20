import type { GitHubProject } from './types.js';

/**
 * Parse GitHub project URLs from a YouTube video description.
 *
 * The GithubAwesome channel uses a format like:
 *   00:12 - agentic-inbox https://github.com/cloudflare/agentic-inbox
 *   00:40 - Dawarich https://github.com/Freika/dawarich
 *
 * We also try to extract the project label from the timestamp line.
 */
export function parseGitHubUrls(text: string): GitHubProject[] {
  const seen = new Set<string>();
  const projects: GitHubProject[] = [];

  // Match github.com URLs — capture owner and repo
  const urlRegex =
    /(?:https?:\/\/)?github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)/g;

  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(text)) !== null) {
    let owner = match[1];
    let repo = match[2];

    // Clean trailing punctuation or query params from repo name
    repo = repo.split(/[?#\s,;\])}>]/)[0];

    // Skip if owner looks like a page, not a repo URL
    if (['features', 'pricing', 'security', 'topics', 'trending', 'explore', 'marketplace', 'sponsors', 'orgs', 'users', 'settings', 'notifications', 'new', 'login', 'signup', 'join', 'about', 'blog'].includes(owner.toLowerCase())) {
      continue;
    }

    const key = `${owner}/${repo}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Try to find the label from the line containing this URL
    const lineIdx = text.lastIndexOf('\n', match.index);
    const lineEnd = text.indexOf('\n', match.index);
    const line = text.slice(
      lineIdx === -1 ? 0 : lineIdx,
      lineEnd === -1 ? text.length : lineEnd,
    ).trim();

    projects.push({
      owner,
      repo,
      url: `https://github.com/${owner}/${repo}`,
      readme: null,
      summary: null,
      description: null,
      stars: null,
      language: null,
    });
  }

  return projects;
}

/**
 * Parse GitHub URLs from a comment (fallback if description has none).
 */
export function parseGitHubUrlsFromComment(commentText: string): GitHubProject[] {
  return parseGitHubUrls(commentText);
}
