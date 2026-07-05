import { createModels, createProvider, type Model } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

const SYSTEM_PROMPT = `You are a technical writer who summarizes open-source GitHub projects.
Given a project's README content, write a concise summary in 3-4 sentences.
Focus on:
1. What the project does (its core purpose)
2. Key features or capabilities
3. Who would benefit from using it
Be informative but brief. Do not use bullet points or headings — write prose.`;

const MAX_README_LENGTH = 4000;

let _model: Model<'openai-completions'> | null = null;
let _models: ReturnType<typeof createModels> | null = null;

function getModel(): { models: ReturnType<typeof createModels>; model: Model<'openai-completions'> } {
  if (_model && _models) return { models: _models, model: _model };

  const providerId = process.env.LLM_PROVIDER || 'openai';
  const apiKey = process.env.LLM_API_KEY;
  const baseUrl = process.env.LLM_BASE_URL || 'https://api.openai.com/v1';
  const modelName = process.env.LLM_MODEL || 'gpt-4o-mini';

  if (!apiKey) {
    throw new Error('LLM_API_KEY environment variable is required');
  }

  const model: Model<'openai-completions'> = {
    id: modelName,
    name: modelName,
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };

  const provider = createProvider({
    id: providerId,
    baseUrl,
    auth: {
      apiKey: {
        name: 'LLM_API_KEY',
        resolve: async () => ({ auth: { apiKey } }),
      },
    },
    models: [model],
    api: openAICompletionsApi(),
  });

  const models = createModels();
  models.setProvider(provider);

  console.log(`  LLM: Using provider "${providerId}", model "${modelName}"`);

  _models = models;
  _model = model;
  return { models, model };
}

/**
 * Summarize a GitHub project's README using an LLM.
 */
export async function summarizeReadme(
  readme: string,
  owner: string,
  repo: string,
): Promise<string | null> {
  try {
    const { models, model } = getModel();

    const truncated =
      readme.length > MAX_README_LENGTH
        ? readme.slice(0, MAX_README_LENGTH) + '\n\n[... README truncated ...]'
        : readme;

    const response = await models.complete(model, {
      systemPrompt: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: `Project: ${owner}/${repo}\n\n${truncated}`, timestamp: Date.now() },
      ],
    });

    const text = response.content.find((b) => b.type === 'text')?.text;
    return text || null;
  } catch (err) {
    console.warn(
      `  LLM summarization failed for ${owner}/${repo}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}
