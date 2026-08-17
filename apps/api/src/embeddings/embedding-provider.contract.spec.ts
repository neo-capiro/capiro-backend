import { describe, expect, test } from '@jest/globals';
import { EmbeddingProviderError } from './embedding-provider.js';
import { TitanEmbeddingProvider } from './titan-embedding.provider.js';

function response(vector: number[]): { body: Uint8Array } {
  return {
    body: new TextEncoder().encode(JSON.stringify({ embedding: vector })),
  };
}

describe('EmbeddingProvider contract — Titan adapter', () => {
  test('exposes stable provider/model/version/dimension metadata', () => {
    const provider = new TitanEmbeddingProvider({
      model: 'test-model',
      modelVersion: 'test-v1',
      dimensions: 3,
      invoker: async () => response([0.1, 0.2, 0.3]),
    });

    expect(provider.metadata).toEqual({
      provider: 'aws-bedrock',
      model: 'test-model',
      modelVersion: 'test-v1',
      dimensions: 3,
    });
  });

  test('preserves the existing Titan request shape behind the provider seam', async () => {
    let seenModel: string | undefined;
    let seenBody: string | undefined;
    const provider = new TitanEmbeddingProvider({
      model: 'test-model',
      dimensions: 3,
      invoker: async (command) => {
        seenModel = command.input.modelId;
        const body = command.input.body;
        seenBody =
          typeof body === 'string'
            ? body
            : new TextDecoder().decode(body as Uint8Array);
        return response([0.1, 0.2, 0.3]);
      },
    });

    await expect(provider.embed('alpha beta')).resolves.toEqual([0.1, 0.2, 0.3]);
    expect(seenModel).toBe('test-model');
    expect(JSON.parse(seenBody ?? '{}')).toEqual({
      inputText: 'alpha beta',
      dimensions: 3,
      normalize: true,
    });
  });

  test('embedBatch preserves input order', async () => {
    const provider = new TitanEmbeddingProvider({
      model: 'test-model',
      dimensions: 2,
      invoker: async (command) => {
        const body = command.input.body;
        const raw =
          typeof body === 'string'
            ? body
            : new TextDecoder().decode(body as Uint8Array);
        const { inputText } = JSON.parse(raw) as { inputText: string };
        return response(inputText === 'first' ? [1, 0] : [0, 1]);
      },
    });

    await expect(provider.embedBatch(['first', 'second'])).resolves.toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  test('normalizes transport failures without leaking source text', async () => {
    const provider = new TitanEmbeddingProvider({
      model: 'test-model',
      dimensions: 3,
      invoker: async () => {
        throw new Error('transport down');
      },
    });

    try {
      await provider.embed('private mailbox text');
      throw new Error('expected provider failure');
    } catch (error) {
      expect(error).toBeInstanceOf(EmbeddingProviderError);
      expect(error).toMatchObject({
        code: 'provider_request_failed',
        retryable: true,
      });
      expect((error as Error).message).not.toContain('private mailbox text');
    }
  });

  test('fails closed on malformed or wrong-dimension provider responses', async () => {
    const provider = new TitanEmbeddingProvider({
      model: 'test-model',
      dimensions: 3,
      invoker: async () => response([0.1, 0.2]),
    });

    await expect(provider.embed('alpha')).rejects.toMatchObject({
      code: 'invalid_provider_response',
      retryable: false,
    });
  });
});
