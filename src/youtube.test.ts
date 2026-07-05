import 'dotenv/config';
import { beforeAll, describe, expect, test } from 'bun:test';
import {
  getChannelVideos,
  getPinnedComment,
  getPlaylistVideos,
  getVideoDescription,
  getVideoDetails,
  getVideoUploadDate,
  resolveChannelId,
} from './youtube.js';

// Real, stable sources already used in production (see src/sources.ts).
const CHANNEL_ID = 'UC9Rrud-8CaHokDtK9FszvRg'; // GithubAwesome
const PLAYLIST_ID = 'PLqPLI-F0UkmdvkuMYjrp1yCNdIk-0NShN'; // ManuAGI – GitHub Projects

const hasKey = !!process.env.YOUTUBE_API_KEY;
const liveEnabled = process.env.RUN_LIVE_TESTS === '1' && hasKey;

describe.skipIf(!liveEnabled)('youtube.ts (live YouTube Data API v3)', () => {
  let sampleVideoId: string;

  beforeAll(async () => {
    const videos = await getChannelVideos(CHANNEL_ID, 3);
    expect(videos.length).toBeGreaterThan(0);
    sampleVideoId = videos[0].id;
  });

  test('getChannelVideos returns non-short videos with required fields', async () => {
    const videos = await getChannelVideos(CHANNEL_ID, 5);
    expect(videos.length).toBeGreaterThan(0);
    expect(videos.length).toBeLessThanOrEqual(5);
    for (const v of videos) {
      expect(v.id).toBeTruthy();
      expect(v.title).toBeTruthy();
      expect(v.isShort).toBe(false);
      if (v.durationSeconds !== undefined) {
        expect(v.durationSeconds).toBeGreaterThan(60);
      }
    }
  });

  test('getPlaylistVideos returns videos sorted newest first', async () => {
    const videos = await getPlaylistVideos(PLAYLIST_ID, 5);
    expect(videos.length).toBeGreaterThan(0);
    const dates = videos.map((v) => v.uploadDate).filter((d): d is string => !!d);
    const sorted = [...dates].sort().reverse();
    expect(dates).toEqual(sorted);
  });

  test('getVideoDescription returns non-empty text for a real video', async () => {
    const desc = await getVideoDescription(sampleVideoId);
    expect(typeof desc).toBe('string');
    expect(desc.length).toBeGreaterThan(0);
  });

  test('getVideoUploadDate returns a valid ISO 8601 date', async () => {
    const date = await getVideoUploadDate(sampleVideoId);
    expect(date).not.toBeNull();
    expect(new Date(date!).toString()).not.toBe('Invalid Date');
  });

  test('getPinnedComment returns a string or null', async () => {
    const comment = await getPinnedComment(sampleVideoId);
    expect(comment === null || typeof comment === 'string').toBe(true);
  });

  test('resolveChannelId resolves a @handle to a UC... channel id', async () => {
    const id = await resolveChannelId('@GithubAwesome');
    expect(id).toMatch(/^UC/);
  });

  test('resolveChannelId passes through an existing channel id unchanged', async () => {
    const id = await resolveChannelId(CHANNEL_ID);
    expect(id).toBe(CHANNEL_ID);
  });

  test('getVideoDetails returns a report-shaped object', async () => {
    const details = await getVideoDetails(sampleVideoId);
    expect(details.videoId).toBe(sampleVideoId);
    expect(details.title).toBeTruthy();
    expect(details.videoUrl).toBe(`https://www.youtube.com/watch?v=${sampleVideoId}`);
  });
});

test.skipIf(liveEnabled)('youtube.ts throws a clear error when YOUTUBE_API_KEY is missing', async () => {
  await expect(getChannelVideos(CHANNEL_ID, 1)).rejects.toThrow('YOUTUBE_API_KEY');
});
