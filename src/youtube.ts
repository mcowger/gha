import type { VideoReport } from './types.js';

const API_BASE = 'https://www.googleapis.com/youtube/v3';

function getApiKey(): string {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error('YOUTUBE_API_KEY environment variable is required');
  return key;
}

async function ytGet<T = any>(endpoint: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${API_BASE}/${endpoint}`);
  url.searchParams.set('key', getApiKey());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const resp = await fetch(url.toString());
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`YouTube API ${endpoint} failed (${resp.status}): ${body.slice(0, 300)}`);
  }
  return resp.json() as Promise<T>;
}

/** Parse an ISO 8601 duration (e.g. "PT1M30S") into seconds. */
function parseIsoDuration(iso: string): number {
  const match = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return 0;
  const [, h, m, s] = match;
  return (parseInt(h || '0', 10) * 3600) + (parseInt(m || '0', 10) * 60) + parseInt(s || '0', 10);
}

export interface ChannelVideo {
  id: string;
  title: string;
  durationSeconds: number | undefined;
  publishedText: string | undefined;
  uploadDate: string | null;
  thumbnails: { url: string; width: number; height: number }[];
  isShort: boolean;
}

/**
 * Resolve a channel ID to its "uploads" playlist ID (contentDetails.relatedPlaylists.uploads).
 */
async function getUploadsPlaylistId(channelId: string): Promise<string> {
  const data = await ytGet('channels', { part: 'contentDetails', id: channelId });
  const uploads = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error(`Could not resolve uploads playlist for channel ${channelId}`);
  return uploads;
}

/**
 * Fetch full video details (snippet + duration) for a batch of video IDs (max 50 per call).
 */
async function getVideosByIds(ids: string[]): Promise<ChannelVideo[]> {
  const videos: ChannelVideo[] = [];

  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const data = await ytGet('videos', { part: 'snippet,contentDetails', id: batch.join(',') });

    for (const item of data.items ?? []) {
      const durationSeconds = parseIsoDuration(item.contentDetails?.duration ?? 'PT0S');
      const isShort = durationSeconds > 0 && durationSeconds <= 60;
      if (isShort) continue;

      const thumbs = item.snippet?.thumbnails ?? {};
      const thumbnails = Object.values(thumbs).map((t: any) => ({
        url: t.url,
        width: t.width ?? 0,
        height: t.height ?? 0,
      })).sort((a: any, b: any) => b.width - a.width);

      videos.push({
        id: item.id,
        title: item.snippet?.title || 'Untitled',
        durationSeconds,
        publishedText: item.snippet?.publishedAt,
        uploadDate: item.snippet?.publishedAt ?? null,
        thumbnails,
        isShort: false,
      });
    }
  }

  return videos;
}

/**
 * Fetch recent videos from a YouTube playlist (or a channel's uploads playlist),
 * newest first, filtering out Shorts (duration <= 60s).
 */
export async function getPlaylistVideos(
  playlistId: string,
  maxVideos: number = 10,
): Promise<ChannelVideo[]> {
  const videoIds: string[] = [];
  let pageToken: string | undefined;

  // Pull a bit more than requested since some entries will be filtered as Shorts.
  const fetchTarget = maxVideos * 3;

  do {
    const data = await ytGet('playlistItems', {
      part: 'contentDetails',
      playlistId,
      maxResults: '50',
      ...(pageToken ? { pageToken } : {}),
    });

    for (const item of data.items ?? []) {
      const id = item.contentDetails?.videoId;
      if (id) videoIds.push(id);
    }

    pageToken = data.nextPageToken;
  } while (pageToken && videoIds.length < fetchTarget);

  const videos = await getVideosByIds(videoIds);
  videos.sort((a, b) => (b.uploadDate ?? '').localeCompare(a.uploadDate ?? ''));
  return videos.slice(0, maxVideos);
}

/**
 * Fetch recent videos from a YouTube channel, filtering out Shorts.
 */
export async function getChannelVideos(
  channelId: string,
  maxVideos: number = 10,
): Promise<ChannelVideo[]> {
  const uploadsPlaylistId = await getUploadsPlaylistId(channelId);
  return getPlaylistVideos(uploadsPlaylistId, maxVideos);
}

/**
 * Get the description text for a specific video.
 */
export async function getVideoDescription(videoId: string): Promise<string> {
  const data = await ytGet('videos', { part: 'snippet', id: videoId });
  return data.items?.[0]?.snippet?.description || '';
}

/**
 * Get the precise upload date (ISO 8601) for a video.
 */
export async function getVideoUploadDate(videoId: string): Promise<string | null> {
  const data = await ytGet('videos', { part: 'snippet', id: videoId });
  return data.items?.[0]?.snippet?.publishedAt ?? null;
}

/**
 * Get the top comment for a video as a fallback source of project links.
 * Returns null if comments are disabled or the video has none.
 */
export async function getPinnedComment(videoId: string): Promise<string | null> {
  try {
    const data = await ytGet('commentThreads', {
      part: 'snippet',
      videoId,
      order: 'relevance',
      maxResults: '1',
      textFormat: 'plainText',
    });
    const top = data.items?.[0]?.snippet?.topLevelComment?.snippet?.textDisplay;
    return top || null;
  } catch {
    // Comments disabled, or any other API error — just skip.
    return null;
  }
}

/**
 * Resolve a YouTube handle (e.g., @GithubAwesome) to a channel ID.
 */
export async function resolveChannelId(handle: string): Promise<string> {
  if (handle.startsWith('UC')) return handle;
  const cleanHandle = handle.startsWith('@') ? handle : `@${handle}`;
  const data = await ytGet('channels', { part: 'id', forHandle: cleanHandle });
  const id = data.items?.[0]?.id;
  if (!id) throw new Error(`Could not resolve channel handle ${handle}`);
  return id;
}

/**
 * Build a VideoReport-friendly structure by fetching video details.
 */
export async function getVideoDetails(
  videoId: string,
): Promise<Pick<VideoReport, 'videoId' | 'title' | 'publishedAt' | 'thumbnailUrl' | 'videoUrl'>> {
  const data = await ytGet('videos', { part: 'snippet', id: videoId });
  const item = data.items?.[0];
  const thumbs = item?.snippet?.thumbnails ?? {};
  const thumbnail = Object.values(thumbs).map((t: any) => t)
    .sort((a: any, b: any) => b.width - a.width)[0]?.url || '';

  return {
    videoId,
    title: item?.snippet?.title || 'Untitled',
    publishedAt: item?.snippet?.publishedAt || new Date().toISOString(),
    thumbnailUrl: thumbnail,
    videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
}
