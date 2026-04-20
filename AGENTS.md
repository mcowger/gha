# Notes for AI Agents

## Project Overview

This is a Bun/TypeScript CLI tool that monitors the GithubAwesome YouTube channel. It fetches new videos, extracts GitHub project URLs from video descriptions, fetches READMEs via the GitHub API, summarizes them with an LLM, and generates HTML report pages.

## Running

```bash
bun install
bun run start          # fetch + render (default)
bun run start fetch    # fetch only (API + LLM)
bun run start render   # render existing JSON → HTML
```

Requires a `.env` file — copy from `.env.example` and fill in credentials. The only strictly required variable is `LLM_API_KEY`. A `GH_TOKEN` is strongly recommended (60 vs 5,000 requests/hour).

## Architecture

The pipeline has two phases, split by subcommand:

1. **`fetch`** — Fetches new videos, gathers GitHub data + LLM summaries, writes intermediate JSON data files (`ghawesome-{date}-{videoId}.json`) to the output directory. This is the expensive phase (API calls, LLM usage).
2. **`render`** — Reads those JSON data files and renders them to HTML. No API calls or LLM usage — can be re-run freely to tweak the HTML template.
3. **(default)** — Running with no subcommand runs both phases sequentially.

Within the `fetch` phase, projects within each video are processed in parallel using `p-limit`. There is no database; state is a JSON file at `STATE_FILE` (default `./state/reviewed.json`).

### Module Responsibilities

- **`src/index.ts`** — CLI entry point with subcommands (`fetch`, `render`, or both). Loads state, fetches videos, processes each one, saves state after each video. Uses `p-limit` to process up to `PROJECT_CONCURRENCY` projects in parallel (default 5), with `LLM_CONCURRENCY` (default 3) parallel LLM summarization calls.
- **`src/youtube.ts`** — Uses `youtubei.js` (YouTube InnerTube API). No API key required. Filters out Shorts by node type (`ReelItem`, `ShortsLockupView`) and duration (≤60s). The `duration` field from channel feed is `{text, seconds}` (not a plain number) — handled in `getChannelVideos`.
- **`src/parser.ts`** — Regex-based GitHub URL extraction from description text. Deduplicates by `owner/repo`. Skips non-repo GitHub pages (features, pricing, etc.).
- **`src/github.ts`** — Uses `@octokit/rest`. Reads `GH_TOKEN` (not `GITHUB_TOKEN`). Uses `repos.getReadme()` (not filename guessing) to fetch the default README. Only retries on 429, not 403. Uses `p-limit` with concurrency 5 for all API calls to avoid overwhelming GitHub's rate limits. Short-circuits README fetch if repo info returns 403.
- **`src/llm.ts`** — Uses `multi-llm-ts`. Configured via `LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`. Truncates READMEs to 4,000 chars. Asks for 3-4 sentence prose summaries.
- **`src/html.ts`** — Generates self-contained dark-themed HTML. Google Fonts (Inter) from CDN. Responsive card grid. Language badges with GitHub-style colors. Star counts.
- **`src/render.ts`** — Reads/writes JSON data files and renders them to HTML. `writeReportJson()` saves a `VideoReport` as JSON. `readReportJson()` loads one. `renderAllJson()` renders all JSON files in the output dir to HTML.
- **`src/dashboard.ts`** — Live terminal dashboard using ANSI escape codes. Shows progress bars, concurrency indicators (●/○ dots), queue sizes, current activity, and scrolling recent events. Repaints in-place every 200ms. No external TUI dependencies.
- **`src/state.ts`** — Simple JSON file read/write. State is saved **after each video** so interruptions don't lose progress.
- **`src/types.ts`** — Shared interfaces: `ReviewedVideo`, `StateFile`, `GitHubProject`, `VideoReport`.

## Key Design Decisions

### Two-Phase Pipeline (fetch + render)

The `fetch` and `render` phases are separated so you can iterate on HTML styling without re-running API calls or burning LLM credits. JSON data files in the output directory serve as the intermediate format between phases.

### No YouTube API Key

Uses `youtubei.js` (InnerTube client) instead of `googleapis`. This means:
- No API key, no quota management
- Channel ID for @GithubAwesome is `UC9Rrud-8CaHokDtK9FszvRg` (resolved via `yt.resolveURL`)
- Can resolve handles with `resolveChannelId()` in `youtube.ts`

### GitHub API Error Handling

- **403 is NOT a rate limit** — it means auth failure or permission denied. Do not retry 403s endlessly.
- The one exception: GitHub sometimes returns 403 with a message containing "rate limit" — that IS a rate limit and is retried.
- **429 is a rate limit** — retried with exponential backoff + jitter, up to 3 attempts.
- **404 is not found** — not retried, not an error.
- Unauthenticated limit is 60 requests/hour. With a token: 5,000/hr.

### State Persistence

State is saved after **each video**, not at the end of the run. This prevents losing all progress if the process is killed or times out. With parallelized processing, a full run is significantly faster than the previous serial implementation.

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

## GitHub Actions Deployment

The `.github/workflows/fetch.yml` workflow runs daily at 9am UTC (and on manual trigger):

1. **Fetches** new videos and generates JSON + HTML into `output/`
2. **Commits** output files back to the repo
3. **Deploys** to GitHub Pages via the `actions/deploy-pages` action

### Setup

1. Go to **Settings → Pages** and set the source to **GitHub Actions**
2. Add the following **repository secrets** (Settings → Secrets → Actions):
   - `LLM_API_KEY` (required)
   - `LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_MODEL` (optional, defaults to OpenAI)
   - `GH_TOKEN` (recommended, for higher GitHub API limits)
   - `YOUTUBE_CHANNEL_ID` (optional, defaults to GithubAwesome channel)
3. The `output/` directory is committed to the repo (not gitignored) so Pages can serve it
4. Reports are live at `https://{user}.github.io/gha/`

## Testing Individual Modules

```bash
# Test YouTube fetching
bun -e "import { getChannelVideos } from './src/youtube.js'; const v = await getChannelVideos('UC9Rrud-8CaHokDtK9FszvRg', 3); console.log(v);"

# Test URL parsing
bun -e "import { parseGitHubUrls } from './src/parser.js'; console.log(parseGitHubUrls('00:12 - test https://github.com/owner/repo'));"

# Test GitHub API (needs GH_TOKEN in env)
bun -e "import { fetchProjectDetails } from './src/github.js'; const p = await fetchProjectDetails({owner:'cloudflare',repo:'agentic-inbox',url:'',readme:null,summary:null,description:null,stars:null,language:null}); console.log(p.stars, p.language, p.readme?.length);"
```
