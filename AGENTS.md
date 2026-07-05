# Notes for AI Agents

## Project Overview

This is a Bun/TypeScript tool that monitors the GithubAwesome YouTube channel (and other sources configured in `src/sources.ts`). It fetches new videos, extracts GitHub project URLs from video descriptions, fetches READMEs via the GitHub API, summarizes them with an LLM, and serves the resulting HTML reports itself over HTTP.

## Running

```bash
bun install
bun run start          # daemon (default): serve output/ over HTTP + fetch/render on CRON_SCHEDULE
bun run start fetch    # fetch only (API + LLM)
bun run start render   # render existing JSON → HTML
bun run start run      # fetch + render once, no server
bun run start serve    # serve the existing output/ dir only, no fetching
bun run start --port 3000   # override PORT for this run

bun run dev --port 8080         # like 'start', but restarts on source changes (bun --watch)
bun run dev serve --port 8080   # e.g. iterate on server.ts/html.ts without needing API keys
```

Or via Docker:

```bash
docker build -t gha .
docker run -d --name gha -p 8080:8080 \
  -v gha-output:/app/output -v gha-state:/app/state \
  --env-file .env gha
```

Requires a `.env` file — copy from `.env.example` and fill in credentials. Strictly required: `LLM_API_KEY` and `YOUTUBE_API_KEY`. A `GH_TOKEN` is strongly recommended (60 vs 5,000 requests/hour).

## Architecture

The pipeline has two phases, split by subcommand:

1. **`fetch`** — Fetches new videos, gathers GitHub data + LLM summaries, writes intermediate JSON data files (`ghawesome-{date}-{videoId}.json`) to `OUTPUT_DIR`. This is the expensive phase (API calls, LLM usage).
2. **`render`** — Reads those JSON data files and renders them to HTML in the same `OUTPUT_DIR`. No API calls or LLM usage — can be re-run freely to tweak the HTML template.
3. **`run`** — Both phases sequentially, one-shot, no server.
4. **`daemon`** (default, no subcommand) — Starts the built-in HTTP server (serving whatever's already in `OUTPUT_DIR`) immediately, then runs `fetch` + `render` on `CRON_SCHEDULE`, updating the same directory the server reads from.
5. **`serve`** — Starts only the HTTP server, no fetching.

Within the `fetch` phase, projects within each video are processed in parallel using `p-limit`. There is no database and nothing is committed to git; all state is plain files on disk: `OUTPUT_DIR` (JSON + HTML reports) and `STATE_FILE` (default `./state/reviewed.json`).

### Module Responsibilities

- **`src/index.ts`** — CLI entry point (`fetch`, `render`, `run`, `serve`, `daemon`). Loads state, fetches videos, processes each one, saves state after each video. Uses `p-limit` to process up to `PROJECT_CONCURRENCY` projects in parallel (default 5), with `LLM_CONCURRENCY` (default 3) parallel LLM summarization calls.
- **`src/server.ts`** — `Bun.serve()`-based static file server exposing `OUTPUT_DIR` over HTTP. Serves `index.html` at `/`, guards against path traversal outside the output directory.
- **`src/youtube.ts`** — Uses the official **YouTube Data API v3** (plain `fetch`, requires `YOUTUBE_API_KEY`). `channels.list` resolves a channel's uploads playlist; `playlistItems.list` + `videos.list` (batched by 50 IDs) list videos and their snippet/duration; Shorts are filtered by parsing the ISO 8601 `contentDetails.duration` (≤60s). `commentThreads.list` provides the pinned/top-comment fallback. No scraping, no InnerTube — this is a stable, officially supported API.
- **`src/parser.ts`** — Regex-based GitHub URL extraction from description text. Deduplicates by `owner/repo`. Skips non-repo GitHub pages (features, pricing, etc.).
- **`src/github.ts`** — Uses `@octokit/rest`. Reads `GH_TOKEN` (not `GITHUB_TOKEN`). Uses `repos.getReadme()` (not filename guessing) to fetch the default README. Only retries on 429, not 403. Uses `p-limit` with concurrency 5 for all API calls to avoid overwhelming GitHub's rate limits. Short-circuits README fetch if repo info returns 403.
- **`src/llm.ts`** — Uses `@earendil-works/pi-ai`'s `createModels()`/`createProvider()` API with the `openai-completions` wire protocol, configured via `LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` — this makes any OpenAI-compatible endpoint work without needing it in pi-ai's built-in model catalog. Truncates READMEs to 4,000 chars. Asks for 3-4 sentence prose summaries.
- **`src/html.ts`** — Generates self-contained dark-themed HTML. Google Fonts (Inter) from CDN. Responsive card grid. Language badges with GitHub-style colors. Star counts.
- **`src/render.ts`** — Reads/writes JSON data files and renders them to HTML. `writeReportJson()` saves a `VideoReport` as JSON. `readReportJson()` loads one. `renderAllJson()` renders all JSON files in the output dir to HTML, plus `index.html`.
- **`src/state.ts`** — Simple JSON file read/write. State is saved **after each video** so interruptions don't lose progress.
- **`src/sources.ts`** — List of YouTube channels/playlists to monitor.
- **`src/types.ts`** — Shared interfaces: `ReviewedVideo`, `StateFile`, `GitHubProject`, `VideoSource`, `VideoReport`.

## Key Design Decisions

### Two-Phase Pipeline (fetch + render)

The `fetch` and `render` phases are separated so you can iterate on HTML styling without re-running API calls or burning LLM credits. JSON data files in the output directory serve as the intermediate format between phases.

### No Git-Based Publishing

Earlier versions of this app cloned/pulled/committed/pushed to its own git repo via `isomorphic-git` to publish reports to GitHub Pages. This was fragile (self-referential git operations, force-reset hacks for conflicts) and has been removed entirely. The app now just writes JSON/HTML to `OUTPUT_DIR` on disk and serves that directory itself via `src/server.ts`. Nothing is ever committed or pushed by the app. For Docker deployments, mount volumes over `OUTPUT_DIR`/`STATE_FILE` to persist data across restarts.

### Official YouTube Data API v3, Not Scraping

Earlier versions used `youtubei.js` (an unofficial InnerTube client) — no API key needed, but fragile: it required workarounds for shape inconsistencies (`duration` as `{text, seconds}` vs plain number, playlist pagination quirks, comment parser exceptions), the same class of fragility that has forced tools like `yt-dlp` to require an external JS runtime as YouTube's anti-scraping defenses evolved. The Data API v3 has a stable, officially documented schema and a generous free quota (10,000 units/day; this app uses a few dozen per run), at the cost of requiring a free Google Cloud API key (`YOUTUBE_API_KEY`).

### GitHub API Error Handling

- **403 is NOT a rate limit** — it means auth failure or permission denied. Do not retry 403s endlessly.
- The one exception: GitHub sometimes returns 403 with a message containing "rate limit" — that IS a rate limit and is retried.
- **429 is a rate limit** — retried with exponential backoff + jitter, up to 3 attempts.
- **404 is not found** — not retried, not an error.
- Unauthenticated limit is 60 requests/hour. With a token: 5,000/hr.

### State Persistence

State is saved after **each video**, not at the end of the run. This prevents losing all progress if the process is killed or times out.

### Concurrency Control

Three `p-limit` instances control parallelism:
- **`VIDEO_CONCURRENCY`** (env, default 3) — max videos processed simultaneously
- **`PROJECT_CONCURRENCY`** (env, default 5) — max projects processed simultaneously (GitHub fetch + LLM summarize)
- **`LLM_CONCURRENCY`** (env, default 3) — max LLM summarization calls in flight
- **GitHub API limiter** (internal to `github.ts`, concurrency 5) — max simultaneous GitHub API calls

These are separate limiters so videos, GitHub API, and LLM calls are throttled independently. With authenticated GitHub API (5,000 req/hr), concurrency of 5 is safe. LLM concurrency depends on your provider's rate limits.

## Modifying the Output

HTML generation is in `src/html.ts`. The page is fully self-contained (no local JS/CSS dependencies). Google Fonts are loaded from CDN. The design uses inline styles on cards and CSS classes for layout. To change the look, modify:

- `LANG_COLORS` — language-to-color map for badges
- Card markup in `projectCard()`
- Page layout CSS in the `<style>` block inside `generateHtml()`

After editing `html.ts`, re-run `bun run start render` to regenerate HTML from existing JSON data — no API calls needed.

## Deployment

No GitHub Actions deploy step is needed anymore — the app serves its own reports over HTTP (`src/server.ts`). `.github/workflows/docker.yml` still builds and pushes the Docker image on push to `main`; run that image wherever you like (a home server, NAS, VPS, etc.) with a mounted volume and an exposed port.

## Testing

`bun test` (Bun's built-in test runner, no extra dependency). Test files are colocated as `src/*.test.ts`:

- `parser.test.ts`, `state.test.ts`, `render.test.ts`, `html.test.ts` — unit tests, no network, always run.
- `youtube.test.ts`, `github.test.ts`, `llm.test.ts` — hit the real external APIs. Each is wrapped in `describe.skipIf(!liveEnabled)`, where `liveEnabled = process.env.RUN_LIVE_TESTS === '1' && process.env.X` (the credential it needs: `YOUTUBE_API_KEY`, `GH_TOKEN`, `LLM_API_KEY`) and `import 'dotenv/config'` so a populated `.env` is picked up automatically. These suites never run under plain `bun test`, even with valid credentials in `.env` — run `bun run test:live` to opt in explicitly, which still individually skips a suite if its credential is absent. Each live-API file also has one always-on test asserting the correct no-credential failure mode (throws for YouTube, resolves `null` for the LLM).
- When adding a new external API call, add both a live test (gated on `liveEnabled`) and, where practical, a no-credential-path test.
