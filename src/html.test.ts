import { describe, expect, test } from 'bun:test';
import { generateHtml, generateIndexHtml } from './html.js';
import type { VideoReport } from './types.js';

const baseReport: VideoReport = {
  videoId: 'vid1',
  title: 'Test Video <script>alert(1)</script>',
  publishedAt: '2026-01-01T00:00:00.000Z',
  uploadDate: '2026-01-01T00:00:00.000Z',
  thumbnailUrl: 'https://example.com/thumb.jpg',
  videoUrl: 'https://www.youtube.com/watch?v=vid1',
  projects: [
    {
      owner: 'owner',
      repo: 'repo',
      url: 'https://github.com/owner/repo',
      readme: 'some readme',
      summary: 'a summary',
      description: 'a description',
      stars: 4200,
      language: 'TypeScript',
    },
  ],
  source: { label: 'GithubAwesome', type: 'channel', id: 'UC123' },
};

describe('generateHtml', () => {
  test('escapes the video title in the page', () => {
    const html = generateHtml(baseReport);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('embeds project data as JSON and prevents script-tag breakout', () => {
    const report: VideoReport = {
      ...baseReport,
      projects: [
        { ...baseReport.projects[0], summary: 'contains </script> literally' },
      ],
    };
    const html = generateHtml(report);
    expect(html).toContain('<\\/script');
    expect(html).toContain('"owner":"owner"');
    expect(html).toContain('"repo":"repo"');
  });

  test('includes the source tag when present', () => {
    const html = generateHtml(baseReport);
    expect(html).toContain('GithubAwesome');
  });

  test('links back to the video', () => {
    const html = generateHtml(baseReport);
    expect(html).toContain('https://www.youtube.com/watch?v=vid1');
  });
});

describe('generateIndexHtml', () => {
  test('renders a link per report with title, date, and project count', () => {
    const html = generateIndexHtml([
      { filename: 'a.html', title: 'Report A', date: 'Jan 1, 2026', projectCount: 3, videoUrl: 'https://youtu.be/a' },
      { filename: 'b.html', title: 'Report B', date: 'Jan 2, 2026', projectCount: 5, videoUrl: 'https://youtu.be/b', sourceLabel: 'Playlist X' },
    ]);
    expect(html).toContain('href="a.html"');
    expect(html).toContain('Report A');
    expect(html).toContain('3 projects');
    expect(html).toContain('href="b.html"');
    expect(html).toContain('Playlist X');
  });

  test('escapes report titles', () => {
    const html = generateIndexHtml([
      { filename: 'a.html', title: '<img src=x onerror=alert(1)>', date: 'Jan 1, 2026', projectCount: 1, videoUrl: 'https://youtu.be/a' },
    ]);
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });
});
