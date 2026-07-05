import type { RepoEntry } from './types.js';

/**
 * Dispatches notifications to enabled channels for newly discovered repositories.
 */
export async function sendNotifications(repos: RepoEntry[]): Promise<void> {
  if (repos.length === 0) return;

  await Promise.allSettled([
    sendDiscord(repos),
    sendNtfy(repos),
  ]);
}

/**
 * Sends rich embed notifications for new repositories to Discord.
 */
async function sendDiscord(repos: RepoEntry[]): Promise<void> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;

  // Discord supports up to 10 embeds per webhook payload.
  // We chunk the list of repositories into batches of 10.
  for (let i = 0; i < repos.length; i += 10) {
    const batch = repos.slice(i, i + 10);
    const embeds = batch.map((r) => {
      const mentionText = r.mentions.map((m) => `[${m.videoTitle}](${m.videoUrl})`).join(', ');
      return {
        title: `${r.owner}/${r.repo}`,
        url: r.url,
        description: r.summary || r.description || 'No description available',
        color: 0x5865F2, // Discord Blurple
        fields: [
          { name: '⭐ Stars', value: r.stars?.toLocaleString() || '0', inline: true },
          { name: '🌐 Language', value: r.language || 'Unknown', inline: true },
          { name: '📺 Mentioned in', value: mentionText || 'N/A', inline: false },
        ],
        timestamp: r.firstDiscoveredAt || new Date().toISOString(),
      };
    });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `🆕 **${batch.length} new GitHub repo(s) discovered!**`,
          embeds,
        }),
      });

      if (!response.ok) {
        console.error(`❌ Failed to send Discord notification: ${response.status} ${await response.text()}`);
      }
    } catch (err) {
      console.error(`❌ Discord webhook request failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/**
 * Sends push notifications for each new repository to ntfy.sh (or a self-hosted instance).
 */
async function sendNtfy(repos: RepoEntry[]): Promise<void> {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;

  const ntfyUrl = process.env.NTFY_URL || 'https://ntfy.sh';

  for (const r of repos) {
    try {
      const title = `${r.owner}/${r.repo} (⭐${r.stars?.toLocaleString() || 0})`;
      const body = r.summary || r.description || 'No description available';

      const response = await fetch(`${ntfyUrl}/${topic}`, {
        method: 'POST',
        headers: {
          'Title': title,
          'Click': r.url,
          'Tags': 'star,rocket',
        },
        body,
      });

      if (!response.ok) {
        console.error(`❌ Failed to send ntfy notification: ${response.status} ${await response.text()}`);
      }
    } catch (err) {
      console.error(`❌ ntfy publish request failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
