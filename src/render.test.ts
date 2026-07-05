import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readReportJson, renderAllJson, renderReportToJson, writeReportJson } from './render.js';
import type { VideoReport } from './types.js';

let outputDir: string;

beforeEach(() => {
  outputDir = mkdtempSync(join(tmpdir(), 'gha-render-test-'));
});

afterEach(() => {
  rmSync(outputDir, { recursive: true, force: true });
});

function makeReport(overrides: Partial<VideoReport> = {}): VideoReport {
  return {
    videoId: 'vid1',
    title: 'Test Video',
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
        stars: 42,
        language: 'TypeScript',
      },
    ],
    ...overrides,
  };
}

describe('writeReportJson / readReportJson', () => {
  test('round-trips a report through disk', () => {
    const report = makeReport();
    const jsonPath = writeReportJson(report, outputDir);
    expect(existsSync(jsonPath)).toBe(true);
    expect(readReportJson(jsonPath)).toEqual(report);
  });

  test('names the file after the video id and today\'s date', () => {
    const jsonPath = writeReportJson(makeReport({ videoId: 'xyz' }), outputDir);
    const dateStr = new Date().toISOString().slice(0, 10);
    expect(jsonPath.endsWith(`ghawesome-${dateStr}-xyz.json`)).toBe(true);
  });
});

describe('renderReportToJson', () => {
  test('renders HTML alongside the JSON with a matching basename', () => {
    const jsonPath = writeReportJson(makeReport(), outputDir);
    const htmlPath = renderReportToJson(jsonPath, outputDir);
    expect(htmlPath).toBe(jsonPath.replace(/\.json$/, '.html'));
    const html = readFileSync(htmlPath, 'utf-8');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('owner/repo');
  });
});

describe('renderAllJson', () => {
  test('renders every JSON report plus an index.html', () => {
    writeReportJson(makeReport({ videoId: 'vid1', title: 'First' }), outputDir);
    writeReportJson(makeReport({ videoId: 'vid2', title: 'Second' }), outputDir);

    const written = renderAllJson(outputDir);
    expect(written).toHaveLength(2);

    const indexPath = join(outputDir, 'index.html');
    expect(existsSync(indexPath)).toBe(true);
    const index = readFileSync(indexPath, 'utf-8');
    expect(index).toContain('First');
    expect(index).toContain('Second');
  });

  test('returns an empty array when there are no JSON files', () => {
    expect(renderAllJson(outputDir)).toEqual([]);
  });
});
