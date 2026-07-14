import type { RepoEntry } from './types.js';

/**
 * Debounced notification queue. New repos discovered during a fetch are
 * enqueued (deduped by owner/repo) and a single batched notification is
 * sent per enabled channel after NOTIFICATION_DEBOUNCE_MS of no further
 * enqueues — collapsing the "20+ messages per new video" flurry into one
 * "📋 N new repos to review — <PUBLIC_FEED_URL>" ping.
 *
 * Pure debounce: every enqueue resets the timer, so during a sustained
 * burst the notification is held until activity stops.
 */

const DEFAULT_DEBOUNCE_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_PUBLIC_FEED_URL = 'https://gha.home.cowger.us';

/**
 * Reads the configured debounce window. Read fresh on each call so tests
 * can change the env var between enqueues without re-importing the module.
 */
function getDebounceMs(): number {
  const raw = process.env.NOTIFICATION_DEBOUNCE_MS;
  if (!raw) return DEFAULT_DEBOUNCE_MS;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_DEBOUNCE_MS;
  return parsed;
}

function getPublicFeedUrl(): string {
  const url = process.env.PUBLIC_FEED_URL;
  return url && url.trim() ? url.trim() : DEFAULT_PUBLIC_FEED_URL;
}

/** Module-level pending queue + timer. */
let pending: RepoEntry[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let activeFlush: Promise<void> | null = null;

/** Number of repos currently waiting in the debounce queue. */
export function getPendingCount(): number {
  return pending.length;
}

/**
 * Clear the pending queue and cancel any scheduled flush. Intended for
 * tests; not part of the runtime API.
 */
export function _resetForTesting(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  pending = [];
  flushing = false;
  activeFlush = null;
}

/**
 * Add repos to the pending queue and reset the debounce timer. After
 * NOTIFICATION_DEBOUNCE_MS of no further enqueues, the queue is flushed
 * as a single notification per enabled channel.
 *
 * Repos are deduplicated by owner/repo within the pending queue.
 */
export function enqueueNotifications(repos: RepoEntry[]): void {
  if (repos.length === 0) return;

  const existingKeys = new Set(pending.map((r) => `${r.owner}/${r.repo}`));
  let added = false;
  for (const r of repos) {
    const key = `${r.owner}/${r.repo}`;
    if (!existingKeys.has(key)) {
      pending.push(r);
      existingKeys.add(key);
      added = true;
    }
  }
  // A duplicate does not represent newly discovered work, so it must not
  // extend the quiet period for the already-pending batch.
  if (!added) return;

  if (timer !== null) clearTimeout(timer);
  const ms = getDebounceMs();
  timer = setTimeout(() => {
    timer = null;
    flushPendingNotifications().catch((err) =>
      console.error(`Notification flush failed: ${err instanceof Error ? err.message : err}`),
    );
  }, ms);
}

/**
 * Send a single batched notification for all currently-pending repos,
 * then clear the queue. Called when the debounce window elapses, when
 * triggered explicitly (graceful shutdown, end of one-shot `fetch`/`run`).
 * No-op if the queue is empty or another flush is already running.
 */
export function flushPendingNotifications(): Promise<void> {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (flushing) return activeFlush ?? Promise.resolve();
  if (pending.length === 0) return Promise.resolve();

  flushing = true;
  const toSend = pending;
  pending = [];
  activeFlush = Promise.allSettled([
    sendDiscordBatch(toSend),
    sendNtfyBatch(toSend),
  ])
    .then(() => undefined)
    .finally(() => {
      flushing = false;
      activeFlush = null;
    });
  return activeFlush;
}

/**
 * Compose the headline fragment for a debounced notification. Discord
 * uses the emoji + markdown link freely; ntfy strips them since HTTP
 * headers must be ASCII (Bun rejects non-ASCII in header values).
 */
function headline(count: number): string {
  const noun = count === 1 ? 'repo' : 'repos';
  return `${count} new ${noun} to review`;
}

/**
 * Sends one Discord message for the entire pending batch — deliberately no
 * per-repo embeds, so a video with dozens of links still produces one ping.
 */
async function sendDiscordBatch(repos: RepoEntry[]): Promise<void> {
  const webhook = process.env.DISCORD_WEBHOOK_URL;
  if (!webhook) return;

  const feedUrl = getPublicFeedUrl();
  const content = `📋 **${headline(repos.length)}** — ${feedUrl}`;

  try {
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!response.ok) {
      console.error(`Discord notification failed: ${response.status} ${await response.text()}`);
    }
  } catch (err) {
    console.error(`Discord webhook request failed: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Sends one batched ntfy push. ntfy HTTP headers must be ASCII, so the
 * title is the plain count and the feed URL goes in the Click header.
 */
async function sendNtfyBatch(repos: RepoEntry[]): Promise<void> {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;

  const ntfyUrl = process.env.NTFY_URL || 'https://ntfy.sh';
  const feedUrl = getPublicFeedUrl();
  const title = headline(repos.length);

  const body = `${headline(repos.length)}. Review them at ${feedUrl}`;

  const headers: Record<string, string> = {
    'Title': title,
    'Tags': 'rocket,bell',
  };
  headers['Click'] = feedUrl;

  try {
    const response = await fetch(`${ntfyUrl}/${topic}`, {
      method: 'POST',
      headers,
      body,
    });
    if (!response.ok) {
      console.error(`ntfy notification failed: ${response.status} ${await response.text()}`);
    }
  } catch (err) {
    console.error(`ntfy publish request failed: ${err instanceof Error ? err.message : err}`);
  }
}
