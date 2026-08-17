import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { createDefaultRerankingProvider } from './reranking-provider.factory.js';
import { NVIDIA_RERANK_MODEL } from './nvidia-reranking.provider.js';

const KEYS = [
  'NVIDIA_RERANK_URL',
  'NVIDIA_RERANK_BASE_URL',
  'NVIDIA_API_KEY',
  'NVIDIA_RERANK_MODEL',
  'NVIDIA_RERANK_TIMEOUT_MS',
] as const;
const prior = new Map(KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  for (const key of KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of KEYS) {
    const value = prior.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('createDefaultRerankingProvider', () => {
  test('returns null when no NVIDIA endpoint or credential is configured', () => {
    expect(createDefaultRerankingProvider()).toBeNull();
  });

  test('selects hosted NVIDIA when only an API key is configured', () => {
    process.env.NVIDIA_API_KEY = 'nvapi-test';
    const provider = createDefaultRerankingProvider();

    expect(provider?.metadata).toEqual({
      provider: 'nvidia-nim',
      model: NVIDIA_RERANK_MODEL,
      apiVersion: 'v1/reranking',
    });
  });

  test('allows a private self-hosted NIM without a bearer key', () => {
    process.env.NVIDIA_RERANK_BASE_URL = 'http://reranker.internal:8000/v1';
    const provider = createDefaultRerankingProvider();

    expect(provider?.metadata.provider).toBe('nvidia-nim');
  });

  test('refuses an explicitly hosted NVIDIA URL without a bearer key', () => {
    process.env.NVIDIA_RERANK_URL =
      'https://ai.api.nvidia.com/v1/retrieval/nvidia/llama-nemotron-rerank-vl-1b-v2/reranking';

    expect(createDefaultRerankingProvider()).toBeNull();
  });

  test('keeps model selection at the shared factory seam', () => {
    process.env.NVIDIA_API_KEY = 'nvapi-test';
    process.env.NVIDIA_RERANK_MODEL = 'nvidia/custom-reranker';

    expect(createDefaultRerankingProvider()?.metadata.model).toBe('nvidia/custom-reranker');
  });
});
