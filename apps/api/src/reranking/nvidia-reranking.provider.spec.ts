import { describe, expect, jest, test } from '@jest/globals';
import { RerankingProviderError } from './reranking-provider.js';
import {
  NvidiaRerankingProvider,
  nvidiaHostedRerankingUrl,
} from './nvidia-reranking.provider.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('NvidiaRerankingProvider', () => {
  test('sends the NeMo Retriever ranking request shape and normalizes logits', async () => {
    const fetchImpl = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        model: 'nvidia/test-reranker',
        query: { text: 'ground robotics' },
        passages: [{ text: 'alpha' }, { text: 'beta' }],
        truncate: 'END',
      });
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer secret-key');
      return jsonResponse({
        rankings: [
          { index: 1, logit: 4.2 },
          { index: 0, logit: 1.1 },
        ],
        usage: { prompt_tokens: 12, total_tokens: 12 },
      });
    }) as unknown as typeof fetch;

    const provider = new NvidiaRerankingProvider({
      baseUrl: 'https://example.test/v1/',
      apiKey: 'secret-key',
      model: 'nvidia/test-reranker',
      fetchImpl,
    });

    await expect(
      provider.rerank({ query: 'ground robotics', passages: ['alpha', 'beta'] }),
    ).resolves.toEqual({
      rankings: [
        { index: 1, score: 4.2 },
        { index: 0, score: 1.1 },
      ],
      usage: { promptTokens: 12, totalTokens: 12 },
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.test/v1/ranking',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('uses NVIDIA Build model-specific hosted endpoint when no self-hosted base URL is supplied', async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({ rankings: [{ index: 0, logit: 0.75 }] }),
    ) as unknown as typeof fetch;
    const provider = new NvidiaRerankingProvider({
      apiKey: 'secret-key',
      model: 'nvidia/test-reranker',
      fetchImpl,
    });

    await provider.rerank({ query: 'q', passages: ['p'] });

    expect(nvidiaHostedRerankingUrl('nvidia/test-reranker')).toBe(
      'https://ai.api.nvidia.com/v1/retrieval/nvidia/test-reranker/reranking',
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://ai.api.nvidia.com/v1/retrieval/nvidia/test-reranker/reranking',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('supports a self-hosted NIM without an Authorization header', async () => {
    const fetchImpl = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
      return jsonResponse({ rankings: [{ index: 0, logit: 0.5 }] });
    }) as unknown as typeof fetch;
    const provider = new NvidiaRerankingProvider({
      baseUrl: 'http://reranker.internal:8000/v1',
      model: 'nvidia/test-reranker',
      fetchImpl,
    });

    await expect(provider.rerank({ query: 'q', passages: ['p'] })).resolves.toMatchObject({
      rankings: [{ index: 0, score: 0.5 }],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://reranker.internal:8000/v1/ranking',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('fails closed when the response drops, duplicates, or invents candidates', async () => {
    const provider = new NvidiaRerankingProvider({
      model: 'nvidia/test-reranker',
      fetchImpl: jest.fn(async () =>
        jsonResponse({
          rankings: [
            { index: 0, logit: 1 },
            { index: 0, logit: 0.5 },
          ],
        }),
      ) as unknown as typeof fetch,
    });

    await expect(provider.rerank({ query: 'q', passages: ['a', 'b'] })).rejects.toMatchObject({
      code: 'invalid_provider_response',
      retryable: false,
    });
  });

  test('normalizes HTTP failures without leaking query or passage text', async () => {
    const provider = new NvidiaRerankingProvider({
      model: 'nvidia/test-reranker',
      fetchImpl: jest.fn(async () => jsonResponse({ secret: 'provider body' }, 503)) as unknown as typeof fetch,
    });

    try {
      await provider.rerank({ query: 'private query', passages: ['private client passage'] });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(RerankingProviderError);
      expect(error).toMatchObject({ code: 'provider_request_failed', retryable: true });
      expect((error as Error).message).not.toContain('private query');
      expect((error as Error).message).not.toContain('private client passage');
      expect((error as Error).message).not.toContain('provider body');
    }
  });
});
