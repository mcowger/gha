import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { generateHtml, generateIndexHtml } from './html.js';
import type { VideoReport } from './types.js';

/**
 * Write a VideoReport to a JSON data file in the output directory.
 * Returns the path of the written file.
 */
export function writeReportJson(
  report: VideoReport,
  outputDir: string,
): string {
  mkdirSync(outputDir, { recursive: true });

  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `ghawesome-${dateStr}-${report.videoId}.json`;
  const filepath = join(outputDir, filename);

  writeFileSync(filepath, JSON.stringify(report, null, 2), 'utf-8');
  return filepath;
}

/**
 * Generate an index.html listing all reports in the output directory.
 * Returns the path of the written file, or null if no reports exist.
 */
function generateIndex(outputDir: string, htmlFiles: string[]): string | null {
  if (htmlFiles.length === 0) return null;

  const reports: Array<{ filename: string; title: string; date: string; projectCount: number; videoUrl: string }> = [];

  for (const htmlPath of htmlFiles) {
    // Find matching JSON file
    const jsonName = basename(htmlPath, '.html') + '.json';
    const jsonPath = join(outputDir, jsonName);
    try {
      const report = readReportJson(jsonPath);
      reports.push({
        filename: basename(htmlPath),
        title: report.title,
        date: report.publishedAt,
        projectCount: report.projects.length,
        videoUrl: report.videoUrl,
      });
    } catch {
      // Skip if JSON not readable
    }
  }

  const html = generateIndexHtml(reports);
  const indexPath = join(outputDir, 'index.html');
  writeFileSync(indexPath, html, 'utf-8');
  return indexPath;
}

export function readReportJson(filepath: string): VideoReport {
  const raw = readFileSync(filepath, 'utf-8');
  return JSON.parse(raw) as VideoReport;
}

/**
 * Render a single JSON data file to HTML.
 * Returns the path of the written HTML file.
 */
export function renderReportToJson(
  jsonPath: string,
  outputDir: string,
): string {
  const report = readReportJson(jsonPath);
  const html = generateHtml(report);

  mkdirSync(outputDir, { recursive: true });

  // Derive HTML filename from the JSON filename: same prefix, different extension
  const jsonName = basename(jsonPath, '.json');
  const filepath = join(outputDir, `${jsonName}.html`);

  writeFileSync(filepath, html, 'utf-8');
  return filepath;
}

/**
 * Render all JSON data files in a directory to HTML.
 * Returns an array of written HTML file paths.
 */
export function renderAllJson(outputDir: string): string[] {
  mkdirSync(outputDir, { recursive: true });

  const jsonFiles = readdirSync(outputDir)
    .filter((f) => f.startsWith('ghawesome-') && f.endsWith('.json'))
    .sort();

  if (jsonFiles.length === 0) {
    console.log('No JSON data files found to render.');
    return [];
  }

  console.log(`🎨 Rendering ${jsonFiles.length} data file(s) to HTML...\n`);

  const written: string[] = [];
  for (const f of jsonFiles) {
    const jsonPath = join(outputDir, f);
    const htmlPath = renderReportToJson(jsonPath, outputDir);
    console.log(`  📄 ${basename(htmlPath)}`);
    written.push(htmlPath);
  }

  console.log(`\n✅ Rendered ${written.length} report(s)`);

  // Generate index.html
  const indexPath = generateIndex(outputDir, written);
  if (indexPath) {
    console.log(`  📄 index.html`);
  }

  return written;
}
