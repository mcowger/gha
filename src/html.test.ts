import { describe, expect, test } from 'bun:test';
import { generateRepoFeedHtml } from './html.js';
import type { RepoEntry } from './types.js';

function makeRepo(overrides: Partial<RepoEntry> = {}): RepoEntry {
  return {
    owner: 'owner',
    repo: 'repo',
    url: 'https://github.com/owner/repo',
    description: 'a description',
    stars: 4200,
    language: 'TypeScript',
    summary: 'a summary',
    firstDiscoveredAt: '2026-01-01T00:00:00.000Z',
    mentions: [
      {
        videoId: 'vid1',
        videoTitle: 'Test Video <script>alert(1)</script>',
        videoUrl: 'https://www.youtube.com/watch?v=vid1',
        mentionedAt: '2026-01-01T00:00:00.000Z',
        source: { label: 'GithubAwesome', type: 'channel', id: 'UC123' },
      },
    ],
    ...overrides,
  };
}

describe('generateRepoFeedHtml', () => {
  test('escapes the video title in the page', () => {
    const html = generateRepoFeedHtml([makeRepo()]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('links to the repo and the mentioning video', () => {
    const html = generateRepoFeedHtml([makeRepo()]);
    expect(html).toContain('href="https://github.com/owner/repo"');
    expect(html).toContain('owner/repo');
    expect(html).toContain('href="https://www.youtube.com/watch?v=vid1"');
  });

  test('includes the retrieval date as a data attribute for client-side formatting', () => {
    const html = generateRepoFeedHtml([makeRepo({ firstDiscoveredAt: '2026-03-15T00:00:00.000Z' })]);
    expect(html).toContain('data-discovered-at="2026-03-15T00:00:00.000Z"');
  });

  test('shows a mention count when a repo has more than one mention', () => {
    const html = generateRepoFeedHtml([
      makeRepo({
        mentions: [
          { videoId: 'vid1', videoTitle: 'First', videoUrl: 'https://youtu.be/vid1', mentionedAt: '2026-01-01T00:00:00.000Z' },
          { videoId: 'vid2', videoTitle: 'Second', videoUrl: 'https://youtu.be/vid2', mentionedAt: '2026-01-02T00:00:00.000Z' },
        ],
      }),
    ]);
    expect(html).toContain('+1 more video');
  });

  test('includes the last-checked timestamp as a data attribute for client-side formatting', () => {
    const html = generateRepoFeedHtml([], '2026-01-01T12:00:00.000Z');
    expect(html).toContain('data-checked-at="2026-01-01T12:00:00.000Z"');
  });

  test('renders no last-checked element when omitted', () => {
    const html = generateRepoFeedHtml([]);
    expect(html).not.toContain('id="last-checked"');
  });

  test('shows a clickable "mark viewed" button for an unviewed repo', () => {
    const html = generateRepoFeedHtml([makeRepo()]);
    const markup = html.split('<script>')[0];
    expect(markup).toContain('class="viewed-btn"');
    expect(markup).toContain('data-owner="owner"');
    expect(markup).toContain('data-repo="repo"');
    expect(markup).not.toContain('class="viewed-badge"');
  });

  test('shows a read-only "viewed" badge instead of a button for a viewed repo', () => {
    const html = generateRepoFeedHtml([makeRepo({ viewed: true })]);
    const markup = html.split('<script>')[0];
    expect(markup).toContain('class="viewed-badge"');
    expect(markup).not.toContain('class="viewed-btn"');
  });

  test('shows a clickable "star" button for an unstarred repo', () => {
    const html = generateRepoFeedHtml([makeRepo()]);
    const markup = html.split('<script>')[0];
    expect(markup).toContain('class="star-btn"');
    expect(markup).not.toContain('class="starred-badge"');
  });

  test('shows a read-only "starred" badge instead of a button for a starred repo', () => {
    const html = generateRepoFeedHtml([makeRepo({ starred: true })]);
    const markup = html.split('<script>')[0];
    expect(markup).toContain('class="starred-badge"');
    expect(markup).not.toContain('class="star-btn"');
  });

  test('links the "show all" toggle to ?all=true when not already showing all', () => {
    const html = generateRepoFeedHtml([], null, false);
    expect(html).toContain('href="/?all=true"');
  });

  test('links the "show all" toggle back to "/" when already showing all', () => {
    const html = generateRepoFeedHtml([], null, true);
    expect(html).toContain('href="/"');
  });

  test('omits the "add to list" control when no lists are provided', () => {
    const html = generateRepoFeedHtml([makeRepo()]);
    expect(html).not.toContain('class="list-select"');
    expect(html).not.toContain('class="list-add-btn"');
  });

  test('shows a list dropdown and add button when lists are provided', () => {
    const html = generateRepoFeedHtml([makeRepo()], null, false, [
      { id: 'UL_1', name: 'Sandboxes' },
      { id: 'UL_2', name: '🚀 My stack' },
    ]);
    const markup = html.split('<script>')[0];
    expect(markup).toContain('class="list-select"');
    expect(markup).toContain('class="list-add-btn"');
    expect(markup).toContain('<option value="UL_1">Sandboxes</option>');
    expect(markup).toContain('<option value="UL_2">🚀 My stack</option>');
  });
});
