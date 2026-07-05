import 'dotenv/config';
import { describe, expect, test } from 'bun:test';
import { summarizeReadme } from './llm.js';

const SAMPLE_README = `# Demo Project

Demo Project is a small command-line tool that converts CSV files to JSON.
It supports custom delimiters and streams large files without loading them
fully into memory. It is written in TypeScript and requires Node 18+.`;

const hasKey = !!process.env.LLM_API_KEY;
const liveEnabled = process.env.RUN_LIVE_TESTS === '1' && hasKey;

describe.skipIf(!liveEnabled)('llm.ts (live LLM summarization)', () => {
  test('summarizes a short README into non-empty prose', async () => {
    const summary = await summarizeReadme(SAMPLE_README, 'example', 'demo-project');
    expect(summary).toBeTruthy();
    expect(summary!.length).toBeGreaterThan(0);
  }, 30000);
});

test.skipIf(hasKey)('llm.ts resolves to null (not a throw) when LLM_API_KEY is missing', async () => {
  await expect(summarizeReadme(SAMPLE_README, 'example', 'demo-project')).resolves.toBeNull();
});
