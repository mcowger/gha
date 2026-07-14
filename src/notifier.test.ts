import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  _resetForTesting,
  enqueueNotifications,
  flushPendingNotifications,
  getPendingCount,
} from './notifier.js';
import type { RepoEntry } from './types.js';

describe('notifier', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; options?: RequestInit }>;

  const mockRepos: RepoEntry[] = [
    {
      owner: 'awesome-owner',
      repo: 'cool-project',
      url: 'https://github.com/awesome-owner/cool-project',
      description: 'A very cool project indeed',
      stars: 1337,
      language: 'TypeScript',
      summary: 'An LLM summary of the cool project',
      firstDiscoveredAt: '2026-07-05T12:00:00.000Z',
      mentions: [],
    },
  ];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchCalls = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: input.toString(), options: init });
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    delete process.env.DISCORD_WEBHOOK_URL;
    delete process.env.NTFY_TOPIC;
    delete process.env.NTFY_URL;
    delete process.env.PUBLIC_FEED_URL;
    delete process.env.NOTIFICATION_DEBOUNCE_MS;
    _resetForTesting();
  });

  afterEach(() => {
    _resetForTesting();
    globalThis.fetch = originalFetch;
    delete process.env.DISCORD_WEBHOOK_URL;
    delete process.env.NTFY_TOPIC;
    delete process.env.NTFY_URL;
    delete process.env.PUBLIC_FEED_URL;
    delete process.env.NOTIFICATION_DEBOUNCE_MS;
  });

  test('does not send or queue an empty batch', async () => {
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123';
    enqueueNotifications([]);
    expect(getPendingCount()).toBe(0);
    await flushPendingNotifications();
    expect(fetchCalls).toHaveLength(0);
  });

  test('sends one Discord summary with the configured feed URL', async () => {
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123';
    process.env.PUBLIC_FEED_URL = 'https://gha.home.cowger.us';

    enqueueNotifications(mockRepos);
    await flushPendingNotifications();

    expect(fetchCalls).toHaveLength(1);
    const call = fetchCalls[0];
    expect(call.url).toBe('https://discord.com/api/webhooks/123');
    expect(call.options?.method).toBe('POST');
    expect(call.options?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(call.options?.body as string)).toEqual({
      content: '📋 **1 new repo to review** — https://gha.home.cowger.us',
    });
  });

  test('sends one Discord message even for more than ten repos', async () => {
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123';
    const repos = Array.from({ length: 20 }, (_, i) => ({
      ...mockRepos[0],
      repo: `repo-${i}`,
    }));

    enqueueNotifications(repos);
    await flushPendingNotifications();

    expect(fetchCalls).toHaveLength(1);
    expect(JSON.parse(fetchCalls[0].options?.body as string).content).toBe('📋 **20 new repos to review** — https://gha.home.cowger.us');
  });

  test('sends one ntfy summary that opens the feed URL', async () => {
    process.env.NTFY_TOPIC = 'test-topic';
    process.env.NTFY_URL = 'https://ntfy.example.com';
    process.env.PUBLIC_FEED_URL = 'https://gha.home.cowger.us';

    enqueueNotifications([...mockRepos, { ...mockRepos[0], repo: 'another-project' }]);
    await flushPendingNotifications();

    expect(fetchCalls).toHaveLength(1);
    const call = fetchCalls[0];
    expect(call.url).toBe('https://ntfy.example.com/test-topic');
    expect(call.options?.method).toBe('POST');
    expect(call.options?.headers).toEqual({
      'Title': '2 new repos to review',
      'Tags': 'rocket,bell',
      'Click': 'https://gha.home.cowger.us',
    });
    expect(call.options?.body).toBe('2 new repos to review. Review them at https://gha.home.cowger.us');
    expect(() => new Headers(call.options?.headers)).not.toThrow();
  });

  test('sends once to each configured channel', async () => {
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123';
    process.env.NTFY_TOPIC = 'test-topic';

    enqueueNotifications(mockRepos);
    await flushPendingNotifications();

    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls.map((call) => call.url)).toEqual([
      'https://discord.com/api/webhooks/123',
      'https://ntfy.sh/test-topic',
    ]);
  });

  test('deduplicates repos queued more than once', async () => {
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123';
    enqueueNotifications(mockRepos);
    enqueueNotifications([...mockRepos, { ...mockRepos[0], repo: 'another-project' }]);

    expect(getPendingCount()).toBe(2);
    await flushPendingNotifications();
    expect(JSON.parse(fetchCalls[0].options?.body as string).content).toBe('📋 **2 new repos to review** — https://gha.home.cowger.us');
  });

  test('resets the timer on each enqueue (pure debounce)', async () => {
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123';
    process.env.NOTIFICATION_DEBOUNCE_MS = '30';

    enqueueNotifications(mockRepos);
    await Bun.sleep(20);
    enqueueNotifications([{ ...mockRepos[0], repo: 'another-project' }]);
    await Bun.sleep(20);

    expect(fetchCalls).toHaveLength(0);
    expect(getPendingCount()).toBe(2);

    await Bun.sleep(20);
    expect(fetchCalls).toHaveLength(1);
    expect(JSON.parse(fetchCalls[0].options?.body as string).content).toBe('📋 **2 new repos to review** — https://gha.home.cowger.us');
  });

  test('handles a failed channel without rejecting the flush', async () => {
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123';
    globalThis.fetch = (async () => new Response('Unauthorized', { status: 401 })) as unknown as typeof fetch;

    enqueueNotifications(mockRepos);
    await expect(flushPendingNotifications()).resolves.toBeUndefined();
    expect(getPendingCount()).toBe(0);
  });
});
