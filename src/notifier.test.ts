import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { sendNotifications } from './notifier.js';
import type { RepoEntry } from './types.js';

describe('notifier', () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; options?: RequestInit }> = [];
  let mockFetchResponse: Response;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchCalls = [];
    mockFetchResponse = new Response('ok', { status: 200 });

    // Mock fetch globally
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls.push({ url: input.toString(), options: init });
      return mockFetchResponse;
    };

    // Clean env
    delete process.env.DISCORD_WEBHOOK_URL;
    delete process.env.NTFY_TOPIC;
    delete process.env.NTFY_URL;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.DISCORD_WEBHOOK_URL;
    delete process.env.NTFY_TOPIC;
    delete process.env.NTFY_URL;
  });

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
      mentions: [
        {
          videoId: 'vid-abc',
          videoTitle: 'Awesome JS/TS Repos',
          videoUrl: 'https://www.youtube.com/watch?v=vid-abc',
          mentionedAt: '2026-07-05T12:00:00.000Z',
        },
      ],
    },
  ];

  test('does not call fetch if no notifications are configured', async () => {
    await sendNotifications(mockRepos);
    expect(fetchCalls).toHaveLength(0);
  });

  test('does not call fetch if the repos array is empty', async () => {
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123';
    process.env.NTFY_TOPIC = 'my-topic';

    await sendNotifications([]);
    expect(fetchCalls).toHaveLength(0);
  });

  describe('Discord Driver', () => {
    test('sends a formatted payload to the webhook', async () => {
      process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123';

      await sendNotifications(mockRepos);

      expect(fetchCalls).toHaveLength(1);
      const call = fetchCalls[0];
      expect(call.url).toBe('https://discord.com/api/webhooks/123');
      expect(call.options?.method).toBe('POST');
      expect(call.options?.headers).toEqual({ 'Content-Type': 'application/json' });

      const payload = JSON.parse(call.options?.body as string);
      expect(payload.content).toContain('1 new GitHub repo(s) discovered!');
      expect(payload.embeds).toHaveLength(1);

      const embed = payload.embeds[0];
      expect(embed.title).toBe('awesome-owner/cool-project');
      expect(embed.url).toBe('https://github.com/awesome-owner/cool-project');
      expect(embed.description).toBe('An LLM summary of the cool project');
      expect(embed.color).toBe(0x5865F2);
      expect(embed.timestamp).toBe('2026-07-05T12:00:00.000Z');

      expect(embed.fields).toContainEqual({ name: '⭐ Stars', value: '1,337', inline: true });
      expect(embed.fields).toContainEqual({ name: '🌐 Language', value: 'TypeScript', inline: true });
      expect(embed.fields).toContainEqual({
        name: '📺 Mentioned in',
        value: '[Awesome JS/TS Repos](https://www.youtube.com/watch?v=vid-abc)',
        inline: false,
      });
    });

    test('chunks Discord embeds in batches of 10', async () => {
      process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123';

      // Create 15 mock repositories
      const largeRepoList: RepoEntry[] = Array.from({ length: 15 }, (_, i) => ({
        owner: 'owner',
        repo: `repo-${i}`,
        url: `https://github.com/owner/repo-${i}`,
        description: `Description ${i}`,
        stars: i,
        language: 'TypeScript',
        summary: `Summary ${i}`,
        firstDiscoveredAt: '2026-07-05T12:00:00.000Z',
        mentions: [],
      }));

      await sendNotifications(largeRepoList);

      // Should result in 2 fetch requests (10 in first, 5 in second)
      expect(fetchCalls).toHaveLength(2);

      const payload1 = JSON.parse(fetchCalls[0].options?.body as string);
      expect(payload1.embeds).toHaveLength(10);
      expect(payload1.content).toContain('10 new GitHub repo(s) discovered!');

      const payload2 = JSON.parse(fetchCalls[1].options?.body as string);
      expect(payload2.embeds).toHaveLength(5);
      expect(payload2.content).toContain('5 new GitHub repo(s) discovered!');
    });

    test('gracefully handles non-ok response from Discord', async () => {
      process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123';
      mockFetchResponse = new Response('Unauthorized', { status: 401 });

      // Should not throw/reject
      await expect(sendNotifications(mockRepos)).resolves.toBeUndefined();
    });

    test('gracefully handles connection errors', async () => {
      process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123';
      globalThis.fetch = async () => {
        throw new Error('Connection refused');
      };

      // Should not throw/reject
      await expect(sendNotifications(mockRepos)).resolves.toBeUndefined();
    });
  });

  describe('ntfy Driver', () => {
    test('sends formatted pushes to the topic', async () => {
      process.env.NTFY_TOPIC = 'test-topic';

      await sendNotifications(mockRepos);

      expect(fetchCalls).toHaveLength(1);
      const call = fetchCalls[0];
      expect(call.url).toBe('https://ntfy.sh/test-topic');
      expect(call.options?.method).toBe('POST');
      expect(call.options?.headers).toEqual({
        'Title': 'awesome-owner/cool-project (⭐1,337)',
        'Click': 'https://github.com/awesome-owner/cool-project',
        'Tags': 'star,rocket',
      });
      expect(call.options?.body).toBe('An LLM summary of the cool project');
    });

    test('sends pushes to custom ntfy URL if configured', async () => {
      process.env.NTFY_TOPIC = 'custom-topic';
      process.env.NTFY_URL = 'https://ntfy.example.com';

      await sendNotifications(mockRepos);

      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].url).toBe('https://ntfy.example.com/custom-topic');
    });

    test('sends one notification per repository', async () => {
      process.env.NTFY_TOPIC = 'test-topic';
      const repos = [
        ...mockRepos,
        {
          owner: 'another-owner',
          repo: 'another-project',
          url: 'https://github.com/another-owner/another-project',
          description: 'Another project description',
          stars: 100,
          language: 'Go',
          summary: 'Another project summary',
          firstDiscoveredAt: '2026-07-05T12:00:00.000Z',
          mentions: [],
        },
      ];

      await sendNotifications(repos);

      expect(fetchCalls).toHaveLength(2);
      expect(fetchCalls[0].url).toBe('https://ntfy.sh/test-topic');
      expect(fetchCalls[0].options?.headers).toMatchObject({
        'Title': 'awesome-owner/cool-project (⭐1,337)',
      });

      expect(fetchCalls[1].url).toBe('https://ntfy.sh/test-topic');
      expect(fetchCalls[1].options?.headers).toMatchObject({
        'Title': 'another-owner/another-project (⭐100)',
      });
    });

    test('gracefully handles non-ok response from ntfy', async () => {
      process.env.NTFY_TOPIC = 'test-topic';
      mockFetchResponse = new Response('Bad Request', { status: 400 });

      // Should not throw/reject
      await expect(sendNotifications(mockRepos)).resolves.toBeUndefined();
    });

    test('gracefully handles connection errors', async () => {
      process.env.NTFY_TOPIC = 'test-topic';
      globalThis.fetch = async () => {
        throw new Error('DNS resolution failed');
      };

      // Should not throw/reject
      await expect(sendNotifications(mockRepos)).resolves.toBeUndefined();
    });
  });

  describe('Multiple Drivers Simultaneous', () => {
    test('sends to both Discord and ntfy when both are configured', async () => {
      process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/123';
      process.env.NTFY_TOPIC = 'test-topic';

      await sendNotifications(mockRepos);

      // 1 to Discord, 1 to ntfy
      expect(fetchCalls).toHaveLength(2);

      const urls = fetchCalls.map((c) => c.url);
      expect(urls).toContain('https://discord.com/api/webhooks/123');
      expect(urls).toContain('https://ntfy.sh/test-topic');
    });
  });
});
