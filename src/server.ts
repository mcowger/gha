import { generateRepoFeedHtml } from './html.js';
import { readLastChecked } from './render.js';
import { loadRepoState, saveRepoState, findRepo, markViewed, markStarred } from './repos.js';
import { starRepo, getUserLists, addRepoToList } from './github.js';
import type { GitHubList } from './types.js';

function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function readRepoBody(req: Request): Promise<{ owner: string; repo: string } | null> {
  const body = await req.json().catch(() => null) as { owner?: string; repo?: string } | null;
  if (!body?.owner || !body?.repo) return null;
  return { owner: body.owner, repo: body.repo };
}

async function readListBody(req: Request): Promise<{ owner: string; repo: string; listId: string } | null> {
  const body = await req.json().catch(() => null) as { owner?: string; repo?: string; listId?: string } | null;
  if (!body?.owner || !body?.repo || !body?.listId) return null;
  return { owner: body.owner, repo: body.repo, listId: body.listId };
}

/** Best-effort fetch of the user's GitHub Lists — degrades to no dropdown if GH_TOKEN is unset or the API call fails. */
async function getUserListsSafe(): Promise<GitHubList[]> {
  try {
    return await getUserLists();
  } catch {
    return [];
  }
}

export type RefreshTrigger = () => 'started' | 'already_running';

/**
 * Start the HTTP server. The repo feed ("/" and "/index.html") is rendered
 * dynamically from `repoStateFile` on every request — so marking a repo
 * viewed/starred, adding it to a GitHub List, or toggling `?all=true`, shows
 * up immediately without a fetch/render cycle. Everything else under
 * `outputDir` is served as a static file. If `onRefresh` is provided,
 * POST /api/refresh triggers it.
 */
export function startServer(
  outputDir: string,
  port: number,
  repoStateFile: string,
  onRefresh?: RefreshTrigger,
): void {
  Bun.serve({
    port,
    routes: {
      '/': (req) => renderFeed(req, outputDir, repoStateFile),
      '/index.html': (req) => renderFeed(req, outputDir, repoStateFile),
      '/api/refresh': (req) => {
        if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
        if (!onRefresh) return jsonResponse({ error: 'Refresh not available' }, 501);
        const status = onRefresh();
        return jsonResponse({ status }, status === 'started' ? 202 : 409);
      },
      '/api/viewed': async (req) => {
        if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
        const target = await readRepoBody(req);
        if (!target) return jsonResponse({ error: 'owner and repo are required' }, 400);
        const state = loadRepoState(repoStateFile);
        if (!markViewed(state, target.owner, target.repo, true)) return jsonResponse({ error: 'Repo not found' }, 404);
        saveRepoState(repoStateFile, state);
        return jsonResponse({ status: 'ok' });
      },
      '/api/star': async (req) => {
        if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
        const target = await readRepoBody(req);
        if (!target) return jsonResponse({ error: 'owner and repo are required' }, 400);
        const state = loadRepoState(repoStateFile);
        if (!findRepo(state, target.owner, target.repo)) return jsonResponse({ error: 'Repo not found' }, 404);
        try {
          await starRepo(target.owner, target.repo);
        } catch (err) {
          return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 502);
        }
        markStarred(state, target.owner, target.repo, true);
        saveRepoState(repoStateFile, state);
        return jsonResponse({ status: 'ok' });
      },
      '/api/lists': async (req) => {
        if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
        const target = await readListBody(req);
        if (!target) return jsonResponse({ error: 'owner, repo, and listId are required' }, 400);
        const state = loadRepoState(repoStateFile);
        if (!findRepo(state, target.owner, target.repo)) return jsonResponse({ error: 'Repo not found' }, 404);
        try {
          await addRepoToList(target.owner, target.repo, target.listId);
        } catch (err) {
          return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 502);
        }
        return jsonResponse({ status: 'ok' });
      },
      '/*': { dir: outputDir },
    },
    async fetch(req) {
      return new Response('Not found', { status: 404 });
    },
  });

  console.log(`🌐 Serving reports from ${outputDir} on http://0.0.0.0:${port}`);
}

async function renderFeed(req: Request, outputDir: string, repoStateFile: string): Promise<Response> {
  const url = new URL(req.url);
  const state = loadRepoState(repoStateFile);
  const showingAll = url.searchParams.get('all') === 'true';
  const repos = state.repos
    .filter((r) => showingAll || !r.viewed)
    .sort((a, b) => b.firstDiscoveredAt.localeCompare(a.firstDiscoveredAt));
  const lists = await getUserListsSafe();
  const html = generateRepoFeedHtml(repos, readLastChecked(outputDir), showingAll, lists);
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
