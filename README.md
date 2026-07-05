# GithubAwesome Monitor

A Bun/TypeScript tool that monitors the [GithubAwesome](https://www.youtube.com/@GithubAwesome) YouTube channel (and other configured sources) for new videos, extracts the GitHub projects mentioned in each video description, fetches each project's README via the GitHub API, summarizes it with an LLM, and serves a static HTML report of its own — no external hosting or git commits required.

## How It Works

```
YouTube Data API v3 → New Video IDs → Video Descriptions → Parse GitHub URLs
                                                              ↓
HTML Page ← LLM Summaries ← README Content ← GitHub API (Octokit)
                                                              ↓
                                            State file + report JSON (disk only)
                                                              ↓
                                          Built-in HTTP server serves output/
```

1. **Check each source** (YouTube channel or playlist) for new videos, excluding Shorts, via the official **YouTube Data API v3**
2. **Parse GitHub project URLs** from each video's description (falls back to the top comment if none found)
3. **Fetch each project's README and metadata** via the GitHub API using Octokit
4. **Summarize each README** using an LLM via `@earendil-works/pi-ai` (any OpenAI-compatible provider)
5. **Generate a static HTML page** with project cards showing name, stars, language, and AI summary
6. **Track processed videos** in a JSON state file so they aren't repeated on subsequent runs
7. **Serve the reports itself** over HTTP — the same process that fetches/renders also serves `output/`

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
| `GH_TOKEN` | Recommended | — | GitHub PAT for API auth (5K vs 60 req/hr) |
| `LLM_PROVIDER` | No | `openai` | Provider ID (any OpenAI-compatible API) |
| `LLM_BASE_URL` | No | OpenAI's API | Base URL for the LLM API |
| `LLM_API_KEY` | **Yes** | — | API key for the LLM provider |
| `LLM_MODEL` | No | `gpt-4o-mini` | Model name to use |
| `OUTPUT_DIR` | No | `./output` | Directory for generated JSON/HTML files, served over HTTP |
| `STATE_FILE` | No | `./state/reviewed.json` | Path to the reviewed-videos state file |
| `PORT` | No | `8080` | Port for the built-in HTTP server |
| `CRON_SCHEDULE` | No | — | Cron expression for daemon mode, e.g. `0 */6 * * *` |

## Usage

```bash
bun run start           # daemon: serve output/ over HTTP + fetch/render on CRON_SCHEDULE
bun run start fetch     # fetch only (API + LLM), writes JSON to output/
bun run start render    # render existing JSON → HTML
bun run start run       # fetch + render once, no server
bun run start serve     # just serve the existing output/ dir, no fetching
```

Reports are available at `http://localhost:8080/` (or your configured `PORT`) once the server is running.

## Output

Each run produces one JSON + HTML file per new video in `OUTPUT_DIR`, plus an `index.html` listing all reports:

```
output/
├── index.html
├── ghawesome-2026-04-18-a-6VY0i9C3Q.json    # intermediate data
├── ghawesome-2026-04-18-a-6VY0i9C3Q.html    # rendered report
└── ...
```

Everything lives on disk under `OUTPUT_DIR`/`STATE_FILE` — nothing is committed back to this repository. In Docker, mount volumes over those paths to persist data across restarts.

Each report page features a dark GitHub-themed design with:
- Video title and link back to YouTube
- Responsive card grid (1–3 columns) — one card per project
- Each card shows: repo name (linked), language badge, star count, repo description, and AI-generated summary

## Project Structure

```
src/
├── index.ts    # Main entry point — CLI + daemon loop
├── server.ts   # Self-contained HTTP server serving OUTPUT_DIR
├── youtube.ts  # YouTube Data API v3 client
├── parser.ts   # Parse GitHub URLs from video descriptions
├── github.ts   # GitHub API via Octokit — README + repo metadata
├── llm.ts      # LLM summarization via @earendil-works/pi-ai
├── html.ts     # HTML page generation
├── render.ts   # JSON ↔ HTML rendering, index page generation
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

## Rate Limiting

- **YouTube**: Data API v3, 1 unit per list call — a full run costs a few dozen units against the default 10,000/day free quota
- **GitHub**: Sequential requests with 500ms/300ms delays between calls. Only retries on HTTP 429 (rate limit) with exponential backoff. HTTP 403 (auth failure) fails immediately rather than retrying pointlessly
- **LLM**: One summary request per project; no special rate limiting

## Testing

```bash
bun test
```

Uses Bun's built-in test runner. Tests fall into two groups:

- **Unit tests** (`parser`, `state`, `render`, `html`) — pure logic, no network, always run.
- **Live API tests** (`youtube`, `github`, `llm`) — exercise the real YouTube Data API v3, GitHub API, and LLM provider. These never run under plain `bun test`, even if `.env` has valid credentials. Opt in explicitly with:

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
