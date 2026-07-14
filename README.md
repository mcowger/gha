# GithubAwesome Monitor

A Bun/TypeScript tool that monitors the [GithubAwesome](https://www.youtube.com/@GithubAwesome) YouTube channel (and other configured sources) for new videos, extracts the GitHub projects mentioned in each video description, fetches each project's README via the GitHub API, summarizes it with an LLM, and serves a static HTML feed of its own — no external hosting or git commits required.

## How It Works

```
YouTube Data API v3 → New Video IDs → Video Descriptions → Parse GitHub URLs
                                                              ↓
HTML Feed ← LLM Summaries ← README Content ← GitHub API (Octokit)
                                                              ↓
                                     Repo state + reviewed-video state (disk only)
                                                              ↓
                                          Built-in HTTP server serves output/
```

1. **Check each source** (YouTube channel or playlist) for new videos, excluding Shorts, via the official **YouTube Data API v3**
2. **Parse GitHub project URLs** from each video's description (falls back to the top comment if none found)
3. **Fetch each project's README and metadata** via the GitHub API using Octokit
4. **Summarize each README** using an LLM via `@earendil-works/pi-ai` (any OpenAI-compatible provider)
5. **Upsert each repo** into a per-repo state file, keyed by `owner/repo` — a repo mentioned in multiple videos accumulates mentions rather than being reprocessed as a duplicate
6. **Generate a static HTML feed**: a flat, newest-discovery-first list of repos with a source icon, language badge, star count, AI summary, and a link to the mentioning video(s)
7. **Track processed videos** in a JSON state file so they aren't repeated on subsequent runs
8. **Serve the feed itself** over HTTP — the same process that fetches/renders also serves `output/`

## Prerequisites

- [Bun](https://bun.sh/) runtime
- A **YouTube Data API v3 key** (free — [console.cloud.google.com](https://console.cloud.google.com/apis/credentials), enable "YouTube Data API v3" on the project)
- A GitHub Personal Access Token (for the GitHub API — 5,000 requests/hour vs 60 unauthenticated)
- An LLM API key and endpoint (any OpenAI-compatible provider)

## Setup

```bash
# Install dependencies
bun install

# Copy and configure environment
cp .env.example .env
# Edit .env with your credentials
```

## Configuration

All configuration is via environment variables (set in `.env` or exported). YouTube sources (channels/playlists) are configured in `src/sources.ts`, not env vars.

| Variable | Required | Default | Description |
|---|---|---|---|
| `YOUTUBE_API_KEY` | **Yes** | — | YouTube Data API v3 key |
| `GH_TOKEN` | Recommended | — | GitHub PAT for API auth (5K vs 60 req/hr); required to use the "Star" button |
| `LLM_PROVIDER` | No | `openai` | Provider ID (any OpenAI-compatible API) |
| `LLM_BASE_URL` | No | OpenAI's API | Base URL for the LLM API |
| `LLM_API_KEY` | **Yes** | — | API key for the LLM provider |
| `LLM_MODEL` | No | `gpt-4o-mini` | Model name to use |
| `OUTPUT_DIR` | No | `./output` | Directory for the repo state, feed HTML, served over HTTP |
| `STATE_FILE` | No | `./state/reviewed.json` | Path to the reviewed-videos state file |
| `REPO_STATE_FILE` | No | `${OUTPUT_DIR}/repos.json` | Path to the per-repo state file |
| `PORT` | No | `8080` | Port for the built-in HTTP server |
| `CRON_SCHEDULE` | No | — | Cron expression for daemon mode, e.g. `0 */6 * * *` |
| `DISCORD_WEBHOOK_URL` | No | — | Discord webhook to receive new-repo notifications |
| `NTFY_TOPIC` | No | — | ntfy topic to receive new-repo notifications |
| `NTFY_URL` | No | `https://ntfy.sh` | Base URL for ntfy (supports self-hosted instances) |
| `NOTIFICATION_DEBOUNCE_MS` | No | `600000` | Wait time in milliseconds after the last newly discovered repo before sending one notification (10 minutes) |
| `PUBLIC_FEED_URL` | No | `https://gha.home.cowger.us` | Public feed URL included in notifications |

## Usage

```bash
bun run start           # daemon: serve output/ over HTTP + fetch/render on CRON_SCHEDULE
bun run start fetch     # fetch only (API + LLM), updates the repo state
bun run start render    # render the repo feed HTML from existing repo state
bun run start run       # fetch + render once, no server
bun run start serve     # just serve the existing output/ dir, no fetching
bun run start --port 3000       # override the PORT env var for this run
```

Reports are available at `http://localhost:8080/` (or your configured `PORT`) once the server is running.

### Development

```bash
bun run dev --port 8080         # same as 'start', but restarts on source changes (bun --watch)
bun run dev serve --port 8080   # e.g. iterate on server.ts/html.ts without needing API keys
```

## Output

Each run upserts discovered repos into a single canonical state file, then renders one flat feed page:

```
output/
├── index.html    # rendered feed — newest discovered repo first
├── repos.json     # canonical per-repo state (source of truth for the feed)
└── last-checked.json
```

Everything lives on disk under `OUTPUT_DIR`/`STATE_FILE` — nothing is committed back to this repository. In Docker, mount volumes over those paths to persist data across restarts.

The feed page features a dark GitHub-themed design with one row per repo, newest discovery first, each showing:
- Source icon (📺 channel / 📋 playlist), repo name (linked), language badge, star count
- Repo description / AI-generated summary
- A link to the (most recent) mentioning video, plus a "+N more videos" count if the repo was mentioned more than once
- The date the repo was first discovered
- A "✓ Mark viewed" button, a "☆ Star" button, and (if `GH_TOKEN` is set) a dropdown to add the repo to one of your GitHub Lists

The index page is rendered dynamically on every request (not a static file), so these actions take effect immediately:
- **Mark viewed** — `POST /api/viewed` sets `viewed: true` on the repo in `repos.json`; viewed repos are hidden from the default feed. Click "👁 Show all" in the header (`/?all=true`) to see them again.
- **Star** — `POST /api/star` calls the GitHub API (via `GH_TOKEN`) to star the repo for the authenticated user and sets `starred: true` in `repos.json`. Both actions are one-directional from the UI — there's no "unview"/"unstar" control.
- **Add to list** — pick one of your [GitHub Lists](https://github.com/stars) from the dropdown and click "+ Add to list"; `POST /api/lists` calls the GitHub API (via `GH_TOKEN`) to add the repo to that list without removing it from any list it's already in. GitHub Lists have no official public API, so this relies on the same undocumented GraphQL fields the github.com web UI itself uses — it could stop working if GitHub changes them. If `GH_TOKEN` is unset or the API call fails, the dropdown is simply omitted rather than erroring out.

### Notifications

Configure `DISCORD_WEBHOOK_URL`, `NTFY_TOPIC`, or both to receive one summary notification per batch of newly discovered repos. Notifications use a **pure debounce**: each newly discovered repo resets the `NOTIFICATION_DEBOUNCE_MS` timer, and after no new repos arrive for the configured window (10 minutes by default), each enabled channel receives one message such as "20 new repos to review". Set `PUBLIC_FEED_URL=https://gha.home.cowger.us` so the notification links directly to the feed. Pending notifications are held in memory and are flushed immediately on a graceful daemon shutdown.

## Project Structure

```
src/
├── index.ts    # Main entry point — CLI + daemon loop
├── server.ts   # Self-contained HTTP server serving OUTPUT_DIR
├── youtube.ts  # YouTube Data API v3 client
├── parser.ts   # Parse GitHub URLs from video descriptions
├── github.ts   # GitHub API via Octokit — README + repo metadata
├── llm.ts      # LLM summarization via @earendil-works/pi-ai
├── html.ts     # Repo feed HTML page generation
├── render.ts   # Renders the repo feed to output/index.html
├── repos.ts    # Per-repo state file management (load/save/upsert)
├── state.ts    # Reviewed-video state file management
├── sources.ts  # Configured YouTube channels/playlists to monitor
└── types.ts    # Shared TypeScript interfaces
```

## Key Libraries

| Library | Purpose |
|---|---|
| YouTube Data API v3 (plain `fetch`) | Official, stable YouTube API — no scraping, generous free quota |
| [`@octokit/rest`](https://github.com/octokit/rest.js) | Official GitHub REST API client |
| [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi) | Unified LLM API for multiple providers |
| [`dotenv`](https://github.com/motdotla/dotenv) | Environment variable loading from `.env` |
| Bun's built-in `Bun.serve()` | Self-contained static file server for reports |

## State File

The state file (`state/reviewed.json` by default) tracks which videos have been processed:

```json
{
  "videos": [
    {
      "videoId": "a-6VY0i9C3Q",
      "title": "34 Trending Self-Hosted Projects on Github",
      "publishedAt": "2026-04-18T20:15:00.000Z",
      "retrievedAt": "2026-04-18T20:15:00.000Z",
      "projectCount": 34
    }
  ]
}
```

State is saved **after each video** is processed, so progress is preserved even if the run is interrupted.

## Repo State File

`OUTPUT_DIR/repos.json` (default `./output/repos.json`) is the canonical, per-repo store the feed is rendered from:

```json
{
  "repos": [
    {
      "owner": "cloudflare",
      "repo": "agentic-inbox",
      "url": "https://github.com/cloudflare/agentic-inbox",
      "description": "...",
      "stars": 1234,
      "language": "TypeScript",
      "summary": "...",
      "firstDiscoveredAt": "2026-04-18T20:15:00.000Z",
      "mentions": [
        { "videoId": "a-6VY0i9C3Q", "videoTitle": "...", "videoUrl": "...", "mentionedAt": "...", "source": { "label": "GithubAwesome", "type": "channel", "id": "UC..." } }
      ],
      "viewed": false,
      "starred": false
    }
  ]
}
```

A repo mentioned in more than one video accumulates additional entries in `mentions` instead of being reprocessed as a duplicate; its `description`/`stars`/`language`/`summary` are refreshed from the most recent fetch.

`viewed` and `starred` are set via the "Mark viewed" / "Star" buttons in the UI (`POST /api/viewed`, `POST /api/star`) and default to unset/`false` for newly discovered repos.

## Rate Limiting

- **YouTube**: Data API v3, 1 unit per list call — a full run costs a few dozen units against the default 10,000/day free quota
- **GitHub**: Sequential requests with 500ms/300ms delays between calls. Only retries on HTTP 429 (rate limit) with exponential backoff. HTTP 403 (auth failure) fails immediately rather than retrying pointlessly
- **LLM**: One summary request per project; no special rate limiting

## OpenCode GitHub Automation

OpenCode provides automatic PR reviews and an interactive assistant:

- `.github/workflows/opencode-review.yml` reviews non-draft PRs, including PRs from forks, when
  they are opened, updated, reopened, or marked ready for review. Reviews are read-only and focus
  on correctness, security, failure modes, tests, and concrete maintainability risks. A minimal
  trusted dispatcher forwards only the PR number and immutable head SHA to an isolated
  default-branch run. That run creates an inert patch before model secrets are exposed, and
  OpenCode can read only that patch.
- On an issue, PR conversation, or inline PR comment, include `@opencode`, `/opencode`, or `/oc`
  to ask a question, request an explanation, or explicitly request a code change. Interactive runs
  are restricted to trusted collaborators. OpenCode can create a branch and PR for issue requests
  or commit to an existing same-repository PR branch; repository tokens cannot push to fork-owned
  PR branches.

The workflows use the built-in `GITHUB_TOKEN` and require these Actions secrets:

- `LLM_API_KEY`: API credential for the OpenAI-compatible model endpoint
- `LLM_BASE_URL`: base URL for that endpoint
- `LLM_MODEL`: model ID used by OpenCode

Session sharing is disabled. Fork reviews never execute PR code or expose model credentials to it.

## Testing

```bash
bun test
```

Uses Bun's built-in test runner. Tests fall into two groups:

- **Unit tests** (`parser`, `state`, `repos`, `render`, `html`, `server`) — pure logic, no network, always run. `server.test.ts` deliberately doesn't exercise the real GitHub star/list-add APIs (it only asserts the 404/400/405 paths); starring and adding to a list are verified manually.
- **Live API tests** (`youtube`, `github`, `llm`) — exercise the real YouTube Data API v3, GitHub API, and LLM provider. `github.test.ts` includes a read-only `getUserLists()` check but not `addRepoToList()`/`starRepo()` (real, persistent account mutations). These never run under plain `bun test`, even if `.env` has valid credentials. Opt in explicitly with:

  ```bash
  bun run test:live
  ```

  Each live suite still individually requires its credential to be set (`YOUTUBE_API_KEY`, `GH_TOKEN`, `LLM_API_KEY` respectively; reads the same `.env` file as the app) and is skipped if missing, even under `test:live`.

## Docker

```bash
docker build -t gha .
docker run -d --name gha \
  -p 8080:8080 \
  -v gha-output:/app/output \
  -v gha-state:/app/state \
  --env-file .env gha
```

The container runs in daemon mode by default: it serves `output/` over HTTP immediately and fetches/renders on `CRON_SCHEDULE`. Named volumes persist `output/` and `state/` across restarts (and are seeded from the image's baked-in report history on first creation).
