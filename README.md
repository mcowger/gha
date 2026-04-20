# GithubAwesome Monitor

A Bun/TypeScript CLI tool that monitors the [GithubAwesome](https://www.youtube.com/@GithubAwesome) YouTube channel for new videos, extracts the GitHub projects mentioned in each video description, fetches each project's README via the GitHub API, summarizes it with an LLM, and produces a polished static HTML page.

## How It Works

```
YouTube (youtubei.js) → New Video IDs → Video Descriptions → Parse GitHub URLs
                                                              ↓
HTML Page ← LLM Summaries ← README Content ← GitHub API (Octokit)
                                                              ↓
                                                  State File (reviewed videos)
```

1. **Check the channel** for new videos (excluding Shorts) using YouTube's InnerTube API — **no YouTube API key required**
2. **Parse GitHub project URLs** from each video's description (falls back to the pinned comment if none found)
3. **Fetch each project's README and metadata** via the GitHub API using Octokit
4. **Summarize each README** using an LLM via `multi-llm-ts` (any OpenAI-compatible provider)
5. **Generate a static HTML page** with project cards showing name, stars, language, and AI summary
6. **Track processed videos** in a JSON state file so they aren't repeated on subsequent runs

## Prerequisites

- [Bun](https://bun.sh/) runtime
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

All configuration is via environment variables (set in `.env` or exported):

| Variable | Required | Default | Description |
|---|---|---|---|
| `YOUTUBE_CHANNEL_ID` | No | `UC9Rrud-8CaHokDtK9FszvRg` | YouTube channel ID to monitor |
| `GH_TOKEN` | Recommended | — | GitHub PAT for API auth (5K vs 60 req/hr) |
| `LLM_PROVIDER` | No | `openai` | Provider ID for multi-llm-ts |
| `LLM_BASE_URL` | No | — | Base URL for the LLM API |
| `LLM_API_KEY` | **Yes** | — | API key for the LLM provider |
| `LLM_MODEL` | No | Provider default | Model name to use |
| `OUTPUT_DIR` | No | `./output` | Directory for generated HTML files |
| `STATE_FILE` | No | `./state/reviewed.json` | Path to the reviewed-videos state file |

## Usage

```bash
bun run start
```

Run it periodically (cron, launchd, etc.) to pick up new videos. Previously processed videos are tracked in the state file and skipped automatically.

## Output

Each run produces one HTML file per new video in `OUTPUT_DIR`:

```
output/
├── ghawesome-2026-04-18-a-6VY0i9C3Q.html    # 34 Trending Self-Hosted Projects
├── ghawesome-2026-04-18-3DvmnCKlxdQ.html    # GitHub Trending Today #31
└── ...
```

Each page features a dark GitHub-themed design with:
- Video title and link back to YouTube
- Responsive card grid (1–3 columns) — one card per project
- Each card shows: repo name (linked), language badge, star count, repo description, and AI-generated summary

## Project Structure

```
src/
├── index.ts    # Main entry point — orchestrates the pipeline
├── youtube.ts  # YouTube integration via youtubei.js (no API key)
├── parser.ts   # Parse GitHub URLs from video descriptions
├── github.ts   # GitHub API via Octokit — README + repo metadata
├── llm.ts      # LLM summarization via multi-llm-ts
├── html.ts     # HTML page generation
├── state.ts    # Reviewed-video state file management
└── types.ts    # Shared TypeScript interfaces
```

## Key Libraries

| Library | Purpose |
|---|---|
| [`youtubei.js`](https://github.com/LuanRT/YouTube.js) | YouTube InnerTube API client — no API key needed, no quotas |
| [`@octokit/rest`](https://github.com/octokit/rest.js) | Official GitHub REST API client |
| [`multi-llm-ts`](https://github.com/nbonamy/multi-llm-ts) | Unified interface for multiple LLM providers |
| [`dotenv`](https://github.com/motdotla/dotenv) | Environment variable loading from `.env` |

## State File

The state file (`state/reviewed.json` by default) tracks which videos have been processed:

```json
{
  "videos": [
    {
      "videoId": "a-6VY0i9C3Q",
      "title": "34 Trending Self-Hosted Projects on Github",
      "publishedAt": "2 days ago",
      "retrievedAt": "2026-04-18T20:15:00.000Z",
      "projectCount": 34
    }
  ]
}
```

State is saved **after each video** is processed, so progress is preserved even if the run is interrupted.

## Rate Limiting

- **YouTube**: Uses InnerTube (private API) — no key, no quotas, but be respectful
- **GitHub**: Sequential requests with 500ms/300ms delays between calls. Only retries on HTTP 429 (rate limit) with exponential backoff. HTTP 403 (auth failure) fails immediately rather than retrying pointlessly
- **LLM**: One summary request per project; no special rate limiting
