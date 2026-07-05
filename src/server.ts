import { existsSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function contentTypeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.'));
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

export type RefreshTrigger = () => 'started' | 'already_running';

/**
 * Start a static file server exposing the report output directory.
 * Serves index.html at "/", and each report at its filename.
 * If `onRefresh` is provided, POST /api/refresh triggers it.
 */
export function startServer(outputDir: string, port: number, onRefresh?: RefreshTrigger): void {
  Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === '/api/refresh') {
        if (req.method !== 'POST') {
          return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (!onRefresh) {
          return new Response(JSON.stringify({ error: 'Refresh not available' }), {
            status: 501,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        const status = onRefresh();
        return new Response(JSON.stringify({ status }), {
          status: status === 'started' ? 202 : 409,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      let pathname = decodeURIComponent(url.pathname);
      if (pathname === '/') pathname = '/index.html';

      // Guard against path traversal outside outputDir.
      const filePath = normalize(join(outputDir, pathname));
      if (!filePath.startsWith(normalize(outputDir))) {
        return new Response('Forbidden', { status: 403 });
      }

      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        return new Response('Not found', { status: 404 });
      }

      const file = Bun.file(filePath);
      return new Response(file, {
        headers: { 'Content-Type': contentTypeFor(filePath) },
      });
    },
  });

  console.log(`🌐 Serving reports from ${outputDir} on http://0.0.0.0:${port}`);
}
