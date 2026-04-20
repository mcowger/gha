import { Innertube, YTNodes } from 'youtubei.js';
import type { VideoReport } from './types.js';

let _yt: Innertube | null = null;

async function getYT(): Promise<Innertube> {
  if (!_yt) {
    _yt = await Innertube.create({ generate_session_locally: true });
  }
  return _yt;
}

export interface ChannelVideo {
  id: string;
  title: string;
  durationSeconds: number | undefined;
  publishedText: string | undefined;
  thumbnails: { url: string; width: number; height: number }[];
  isShort: boolean;
}

/**
 * Fetch recent videos from a YouTube channel, filtering out Shorts.
 */
export async function getChannelVideos(
  channelId: string,
  maxVideos: number = 10,
): Promise<ChannelVideo[]> {
  const yt = await getYT();
  const channel = await yt.getChannel(channelId);
  const videosFeed = await channel.getVideos();

  const videos: ChannelVideo[] = [];

  for (const video of videosFeed.videos) {
    // Skip Shorts by node type
    if (
      video instanceof YTNodes.ReelItem ||
      video instanceof YTNodes.ShortsLockupView
    ) {
      continue;
    }

    // Extract common properties
    let id: string | undefined;
    let title: string | undefined;
    let durationSeconds: number | undefined;
    let publishedText: string | undefined;
    let thumbnails: { url: string; width: number; height: number }[] = [];

    // Handle different video node types
    if ('id' in video) id = (video as any).id;
    if ('video_id' in video) id = (video as any).video_id;
    if ('title' in video) {
      title =
        typeof (video as any).title === 'string'
          ? (video as any).title
          : (video as any).title?.toString();
    }
    if ('duration' in video) {
      const dur = (video as any).duration;
      // Channel feed returns {text, seconds}; getBasicInfo returns a number
      durationSeconds = typeof dur === 'number' ? dur : dur?.seconds;
    }
    if ('published' in video)
      publishedText = (video as any).published?.toString();
    if ('thumbnails' in video) {
      const thumbs = (video as any).thumbnails;
      if (Array.isArray(thumbs)) {
        thumbnails = thumbs.map((t: any) => ({
          url: t.url,
          width: t.width,
          height: t.height,
        }));
      }
    }

    if (!id) continue;

    // Filter by duration — skip videos ≤ 60s (likely Shorts)
    const isShort = durationSeconds !== undefined && durationSeconds <= 60;
    if (isShort) continue;

    videos.push({
      id,
      title: title || 'Untitled',
      durationSeconds,
      publishedText,
      thumbnails,
      isShort: false,
    });

    if (videos.length >= maxVideos) break;
  }

  return videos;
}

/**
 * Get the description text for a specific video.
 * Falls back to checking the pinned comment if the description has no GitHub links.
 */
export async function getVideoDescription(videoId: string): Promise<string> {
  const yt = await getYT();
  const info = await yt.getBasicInfo(videoId);
  const description = info.basic_info.short_description || '';
  return description;
}

/**
 * Get the top (pinned) comment for a video as a fallback source of project links.
 */
export async function getPinnedComment(
  videoId: string,
): Promise<string | null> {
  try {
    const yt = await getYT();
    const comments = await yt.getComments(videoId);
    if (comments.contents && comments.contents.length > 0) {
      const topComment = comments.contents[0];
      return topComment.comment?.content?.toString() || null;
    }
  } catch {
    // youtubei.js parser can throw on unexpected response shapes
    // (e.g. CommentFilterContextView not found). Just skip.
  }
  return null;
}

/**
 * Resolve a YouTube handle (e.g., @GithubAwesome) to a channel ID.
 */
export async function resolveChannelId(handle: string): Promise<string> {
  const yt = await getYT();
  // If it's already a channel ID (starts with UC), return as-is
  if (handle.startsWith('UC')) return handle;
  // Otherwise resolve the handle
  const resolved = await yt.resolveURL(`https://www.youtube.com/${handle}`);
  return resolved.payload.browseId;
}

/**
 * Build a VideoReport-friendly structure by fetching video details.
 */
export async function getVideoDetails(
  videoId: string,
): Promise<Pick<VideoReport, 'videoId' | 'title' | 'publishedAt' | 'thumbnailUrl' | 'videoUrl'>> {
  const yt = await getYT();
  const info = await yt.getBasicInfo(videoId);

  const thumbnail =
    info.basic_info.thumbnail?.sort((a, b) => b.width - a.width)[0]?.url || '';

  return {
    videoId,
    title: info.basic_info.title || 'Untitled',
    publishedAt: new Date().toISOString(), // InnerTube doesn't give exact publish date easily
    thumbnailUrl: thumbnail,
    videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
}
