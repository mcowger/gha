# Notes for AI Agents

## Project Overview

This is a Bun/TypeScript tool that monitors the GithubAwesome YouTube channel (and other sources configured in `src/sources.ts`). It fetches new videos, extracts GitHub project URLs from video descriptions, fetches READMEs via the GitHub API, summarizes them with an LLM, upserts each repo into a per-repo state file (deduped by `owner/repo`, accumulating mentions across videos), and serves a single flat repo feed itself over HTTP.

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

1. **`fetch`** — Fetches new videos, gathers GitHub data + LLM summaries, upserts each discovered repo into the per-repo state file (`REPO_STATE_FILE`, default `OUTPUT_DIR/repos.json`) keyed by `owner/repo`. This is the expensive phase (API calls, LLM usage).
2. **`render`** — Reads `repos.json` and renders the flat repo feed to `OUTPUT_DIR/index.html`, newest discovery first. No API calls or LLM usage — can be re-run freely to tweak the HTML template.
3. **`run`** — Both phases sequentially, one-shot, no server.
4. **`daemon`** (default, no subcommand) — Starts the built-in HTTP server (serving whatever's already in `OUTPUT_DIR`) immediately, then runs `fetch` + `render` on `CRON_SCHEDULE`, updating the same directory the server reads from.
5. **`serve`** — Starts only the HTTP server, no fetching.

Within the `fetch` phase, projects within each video are processed in parallel using `p-limit`. There is no database and nothing is committed to git; all state is plain files on disk: `OUTPUT_DIR/repos.json` (canonical per-repo state, rendered to `index.html`) and `STATE_FILE` (default `./state/reviewed.json`, video-level dedup so a video's description isn't re-parsed on every run).

### Module Responsibilities

- **`src/index.ts`** — CLI entry point (`fetch`, `render`, `run`, `serve`, `daemon`). Loads state, fetches videos, processes each one, saves state after each video. Uses `p-limit` to process up to `PROJECT_CONCURRENCY` projects in parallel (default 5), with `LLM_CONCURRENCY` (default 3) parallel LLM summarization calls.
- **`src/server.ts`** — `Bun.serve()`-based HTTP server exposing `OUTPUT_DIR`. `/` and `/index.html` render the feed dynamically from `REPO_STATE_FILE` on every request (not a static file), filtering out `viewed` repos unless `?all=true` is passed, and fetching the user's GitHub Lists (`github.ts#getUserLists`, best-effort — degrades to `[]` if `GH_TOKEN` is unset or the call fails) to populate the "add to list" dropdown. `POST /api/viewed` and `POST /api/star` mutate repo state (mark viewed / star via `github.ts#starRepo`) and persist it; `POST /api/lists` adds a repo to a GitHub List via `github.ts#addRepoToList` (no local state change — GitHub is the source of truth for list membership); `POST /api/refresh` triggers a fetch+render cycle. Falls back to serving static files from `OUTPUT_DIR` for everything else, guarding against path traversal.
- **`src/youtube.ts`** — Uses the official **YouTube Data API v3** (plain `fetch`, requires `YOUTUBE_API_KEY`). `channels.list` resolves a channel's uploads playlist; `playlistItems.list` + `videos.list` (batched by 50 IDs) list videos and their snippet/duration; Shorts are filtered by parsing the ISO 8601 `contentDetails.duration` (≤60s). `commentThreads.list` provides the pinned/top-comment fallback. No scraping, no InnerTube — this is a stable, officially supported API.
- **`src/parser.ts`** — Regex-based GitHub URL extraction from description text. Deduplicates by `owner/repo`. Skips non-repo GitHub pages (features, pricing, etc.).
- **`src/github.ts`** — Uses `@octokit/rest`. Reads `GH_TOKEN` (not `GITHUB_TOKEN`). Uses `repos.getReadme()` (not filename guessing) to fetch the default README. Only retries on 429, not 403. Uses `p-limit` with concurrency 5 for all API calls to avoid overwhelming GitHub's rate limits. Short-circuits README fetch if repo info returns 403. `starRepo()` stars a repo for the authenticated user (`activity.starRepoForAuthenticatedUser`); throws immediately if `GH_TOKEN` is unset rather than letting an unauthenticated Octokit call fail. `getUserLists()`/`addRepoToList()` manage GitHub Lists via `octokit.graphql()` using undocumented GraphQL fields (`viewer.lists`, `updateUserListsForItem`) discovered via schema introspection — see "GitHub Lists Have No Official API" below. `addRepoToList()` fetches the repo's current list memberships first and merges the new list in, since the mutation overwrites the full membership set rather than adding to it.
- **`src/llm.ts`** — Uses `@earendil-works/pi-ai`'s `createModels()`/`createProvider()` API with the `openai-completions` wire protocol, configured via `LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` — this makes any OpenAI-compatible endpoint work without needing it in pi-ai's built-in model catalog. Truncates READMEs to 4,000 chars. Asks for 3-4 sentence prose summaries.
- **`src/notifier.ts`** — Queues newly discovered repos in memory and sends one summary notification per enabled Discord/ntfy channel after a pure-debounce quiet period (`NOTIFICATION_DEBOUNCE_MS`, default 10 minutes). Notifications link to `PUBLIC_FEED_URL`; the queue is deduped by `owner/repo` and flushed on graceful daemon shutdown.
- **`src/html.ts`** — Generates a single self-contained dark-themed repo feed page (`generateRepoFeedHtml(repos, lastCheckedAt, showingAll, lists)`). One row per repo (source icon, name, language badge, star count, summary/description, discovery date, mentioning video link, "Mark viewed"/"Star" controls, and a GitHub Lists dropdown + "+ Add to list" button when `lists` is non-empty), newest discovery first. Once `viewed`/`starred` is true, the corresponding button is replaced by a static badge — there's no UI path to reverse either flag. Adding to a list has no such badge state (a repo can belong to multiple lists), so the button just flashes "Added to &lt;list name&gt;" and reverts, staying usable for adding to further lists. A header toggle links to `/?all=true` (or back to `/`) to show/hide viewed repos.
- **`src/render.ts`** — `renderRepoFeed()` reads repo state and writes `output/index.html` for the `render` CLI subcommand, filtering out `viewed` repos and sorted newest-`firstDiscoveredAt`-first. `writeLastChecked()`/exported `readLastChecked()` track the last-checked timestamp shown on the page. Note: the live server (`server.ts`) renders on every request instead of reading this file, so this static file is mainly useful for the `render`-only CLI path and previewing output without a running server.
- **`src/repos.ts`** — Per-repo state file (`repos.json`) read/write. `upsertRepo()` creates a new `RepoEntry` on first sighting or, for a repo already known, refreshes `description`/`stars`/`language`/`summary` and appends a new `RepoMention` (deduped by `videoId`). `markViewed()`/`markStarred()` toggle the corresponding flag on an existing entry, returning `false` if the repo isn't found.
- **`src/state.ts`** — Reviewed-video state (`state/reviewed.json`) read/write, saved **after each video** so interruptions don't lose progress. `reconcileStateWithRepos()` backfills video-level state from `repos.json`'s mentions if the state file was lost (fresh volume/worktree) but repo state survived, avoiding mass reprocessing.
- **`src/sources.ts`** — List of YouTube channels/playlists to monitor.
- **`src/types.ts`** — Shared interfaces: `ReviewedVideo`, `StateFile`, `GitHubProject`, `VideoSource`, `RepoMention`, `RepoEntry`, `RepoStateFile`.

## Key Design Decisions

### Two-Phase Pipeline (fetch + render)

The `fetch` and `render` phases are separated so you can iterate on HTML styling without re-running API calls or burning LLM credits. `repos.json` in the output directory serves as the intermediate format between phases.

### Repo-Centric State, Not Video-Centric

Earlier versions stored one JSON+HTML report per video, each containing an array of projects. This duplicated/reprocessed the same repo every time it was mentioned in a second video, and the site was a list of video reports rather than a list of projects. The state is now keyed by `owner/repo` (`RepoEntry` in `src/repos.ts`), with each entry tracking every mentioning video (`RepoMention[]`). The site (`generateRepoFeedHtml()`) is a single flat feed of repos, newest discovery first — there are no more per-video HTML pages.

### Dynamic Server-Side Rendering for Viewed/Starred State

`viewed`/`starred` flags need to take effect immediately (a click should remove the card or swap the button for a badge without a separate fetch+render run). Because of this, `server.ts`'s `/` route renders the feed live from `repos.json` on every request instead of serving the static `index.html` written by `renderRepoFeed()`. The static file (produced by the `render` CLI subcommand) still exists for previewing output without a running server, but the actual served site is always freshly rendered.

### No Git-Based Publishing

Earlier versions of this app cloned/pulled/committed/pushed to its own git repo via `isomorphic-git` to publish reports to GitHub Pages. This was fragile (self-referential git operations, force-reset hacks for conflicts) and has been removed entirely. The app now just writes JSON/HTML to `OUTPUT_DIR` on disk and serves that directory itself via `src/server.ts`. Nothing is ever committed or pushed by the app. For Docker deployments, mount volumes over `OUTPUT_DIR`/`STATE_FILE` to persist data across restarts.

### Official YouTube Data API v3, Not Scraping

Earlier versions used `youtubei.js` (an unofficial InnerTube client) — no API key needed, but fragile: it required workarounds for shape inconsistencies (`duration` as `{text, seconds}` vs plain number, playlist pagination quirks, comment parser exceptions), the same class of fragility that has forced tools like `yt-dlp` to require an external JS runtime as YouTube's anti-scraping defenses evolved. The Data API v3 has a stable, officially documented schema and a generous free quota (10,000 units/day; this app uses a few dozen per run), at the cost of requiring a free Google Cloud API key (`YOUTUBE_API_KEY`).

### GitHub Lists Have No Official API

GitHub's "Lists" feature (organizing starred repos into named collections) has no documented REST endpoint and no documented GraphQL field — confirmed by introspecting GitHub's own GraphQL schema (`query { __type(name: "User") { fields { name } } }` does list `lists`, but it's undocumented). `getUserLists()` queries `viewer.lists`, and `addRepoToList()` calls the `updateUserListsForItem` mutation — both found by introspection, matching what the github.com web UI itself calls. This works with a normal `GH_TOKEN` PAT (verified live), but since it's unsupported, GitHub could change or remove it without notice. There's no automated test for `addRepoToList()` for the same reason `starRepo()` isn't tested live — it's a real, persistent mutation on the authenticated user's account. `getUserLists()` is read-only and is covered by the `RUN_LIVE_TESTS=1` suite.

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
- **`NOTIFICATION_DEBOUNCE_MS`** (env, default 600,000) — quiet period before one new-repo notification batch is sent
- **GitHub API limiter** (internal to `github.ts`, concurrency 5) — max simultaneous GitHub API calls

These are separate limiters so videos, GitHub API, and LLM calls are throttled independently. With authenticated GitHub API (5,000 req/hr), concurrency of 5 is safe. LLM concurrency depends on your provider's rate limits.

## Modifying the Output

HTML generation is in `src/html.ts` (`generateRepoFeedHtml()`). The page is fully self-contained (no local JS/CSS dependencies). To change the look, modify:

- `LANG_COLORS` — language-to-color map for badges
- `SOURCE_ICONS` — icon per `VideoSource.type` (channel/playlist)
- Card markup inside the `repos.map(...)` block
- Page layout CSS in the `<style>` block

After editing `html.ts`, re-run `bun run start render` to regenerate `index.html` from existing `repos.json` — no API calls needed.

## Deployment

No GitHub Actions deploy step is needed anymore — the app serves its own reports over HTTP (`src/server.ts`). `.github/workflows/docker.yml` still builds and pushes the Docker image on push to `main`; run that image wherever you like (a home server, NAS, VPS, etc.) with a mounted volume and an exposed port.

## Testing

`bun test` (Bun's built-in test runner, no extra dependency). Test files are colocated as `src/*.test.ts`:

- `parser.test.ts`, `state.test.ts`, `repos.test.ts`, `render.test.ts`, `html.test.ts` — unit tests, no network, always run.
- `youtube.test.ts`, `github.test.ts`, `llm.test.ts` — hit the real external APIs. Each is wrapped in `describe.skipIf(!liveEnabled)`, where `liveEnabled = process.env.RUN_LIVE_TESTS === '1' && process.env.X` (the credential it needs: `YOUTUBE_API_KEY`, `GH_TOKEN`, `LLM_API_KEY`) and `import 'dotenv/config'` so a populated `.env` is picked up automatically. These suites never run under plain `bun test`, even with valid credentials in `.env` — run `bun run test:live` to opt in explicitly, which still individually skips a suite if its credential is absent. Each live-API file also has one always-on test asserting the correct no-credential failure mode (throws for YouTube, resolves `null` for the LLM).
- When adding a new external API call, add both a live test (gated on `liveEnabled`) and, where practical, a no-credential-path test.
