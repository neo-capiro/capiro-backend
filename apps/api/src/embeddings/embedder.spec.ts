import { describe, expect, jest, test } from '@jest/globals';
import type { PrismaClient } from '@prisma/client';
import type { EmbeddingProvider } from './embedding-provider.js';
import { EMBEDDING_DIM, embedAndUpsert, embedText, sha256 } from './embedder.js';

function provider(overrides: Partial<EmbeddingProvider> = {}): EmbeddingProvider {
  const vector = Array.from({ length: EMBEDDING_DIM }, (_, i) => i / EMBEDDING_DIM);
  return {
    metadata: {
      provider: 'test-provider',
      model: 'portable-model',
      modelVersion: 'test-v1',
      dimensions: EMBEDDING_DIM,
    },
    embed: jest.fn(async () => vector),
    embedBatch: jest.fn(async (inputs: readonly string[]) => inputs.map(() => vector)),
    ...overrides,
  };
}

describe('provider-neutral embedder', () => {
  test('delegates vector production through EmbeddingProvider', async () => {
    const p = provider();
    const vector = await embedText('alpha beta', p);

    expect(p.embed).toHaveBeenCalledWith('alpha beta');
    expect(vector).toHaveLength(EMBEDDING_DIM);
  });

  test('fails before writes when provider dimension disagrees with pgvector storage', async () => {
    const p = provider({
      metadata: {
        provider: 'future-provider',
        model: 'future-model',
        modelVersion: 'future-v1',
        dimensions: 1536,
      },
    });

    await expect(embedText('alpha beta', p)).rejects.toThrow(
      `Embedding provider dimension 1536 does not match context_embeddings dimension ${EMBEDDING_DIM}`,
    );
  });

  test('content-hash short circuit skips provider calls and DB writes', async () => {
    const text = 'stable knowledge text for hashing';
    const p = provider();
    const transaction = jest.fn();
    const prisma = {
      $queryRawUnsafe: jest.fn(async (..._args: unknown[]) => [
        {
          content_hash: sha256(text),
          client_id: '22222222-2222-4222-8222-222222222222',
          owner_user_id: null,
        },
      ]),
      $transaction: transaction,
    } as unknown as PrismaClient;

    await expect(
      embedAndUpsert(
        prisma,
        {
          tenantId: '11111111-1111-4111-8111-111111111111',
          clientId: '22222222-2222-4222-8222-222222222222',
          sourceType: 'capability',
          sourceId: 'cap-1',
          text,
        },
        p,
      ),
    ).resolves.toBe('skipped');

    expect(p.embed).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  test('repairs client/owner scope without re-embedding unchanged content', async () => {
    const text = 'stable knowledge text for scope repair';
    const p = provider();
    const executeRaw = jest.fn(async (..._args: unknown[]) => 1);
    const tx = { $executeRawUnsafe: executeRaw };
    const prisma = {
      $queryRawUnsafe: jest.fn(async () => [
        { content_hash: sha256(text), client_id: null, owner_user_id: 'old-owner' },
      ]),
      $transaction: jest.fn(async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaClient;
    await expect(
      embedAndUpsert(
        prisma,
        {
          tenantId: '11111111-1111-4111-8111-111111111111',
          clientId: '22222222-2222-4222-8222-222222222222',
          ownerUserId: null,
          sourceType: 'memory_item',
          sourceId: 'memory-1',
          text,
        },
        p,
      ),
    ).resolves.toBe('updated');
    expect(p.embed).not.toHaveBeenCalled();
    expect(String(executeRaw.mock.calls[0]?.[0])).toContain('SET client_id = $1::uuid');
    expect(executeRaw.mock.calls[0]?.[1]).toBe('22222222-2222-4222-8222-222222222222');
    expect(executeRaw.mock.calls[0]?.[2]).toBeNull();
  });

  test('persists provider model metadata while preserving tenant/client scope', async () => {
    const p = provider();
    const executeRaw = jest.fn(async (..._args: unknown[]) => 1);
    const tx = { $executeRawUnsafe: executeRaw };
    const queryRaw = jest.fn(async (..._args: unknown[]) => []);
    const transaction = jest.fn(async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx));
    const prisma = {
      $queryRawUnsafe: queryRaw,
      $transaction: transaction,
    } as unknown as PrismaClient;
    const tenantId = '11111111-1111-4111-8111-111111111111';
    const clientId = '22222222-2222-4222-8222-222222222222';

    await expect(
      embedAndUpsert(
        prisma,
        {
          tenantId,
          clientId,
          ownerUserId: null,
          sourceType: 'capability',
          sourceId: 'cap-1',
          text: 'capability text long enough to embed',
          bypassRls: false,
        },
        p,
      ),
    ).resolves.toBe('inserted');

    expect(queryRaw).toHaveBeenCalledWith(
      expect.stringContaining('FROM context_embeddings'),
      'capability',
      'cap-1',
      'portable-model',
      tenantId,
    );
    expect(p.embed).toHaveBeenCalledTimes(1);
    expect(executeRaw).toHaveBeenCalledTimes(1);

    const insertArgs = executeRaw.mock.calls[0]!;
    expect(String(insertArgs[0])).toContain('INSERT INTO context_embeddings');
    expect(insertArgs[1]).toBe(tenantId);
    expect(insertArgs[2]).toBe(clientId);
    expect(insertArgs[4]).toBe('capability');
    expect(insertArgs[5]).toBe('cap-1');
    expect(insertArgs[6]).toBe('portable-model');
  });

  test('bypassRls still remains an explicit persistence concern, not a provider concern', async () => {
    const p = provider();
    const executeRaw = jest.fn(async (..._args: unknown[]) => 1);
    const tx = { $executeRawUnsafe: executeRaw };
    const prisma = {
      $queryRawUnsafe: jest.fn(async (..._args: unknown[]) => []),
      $transaction: jest.fn(async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaClient;

    await embedAndUpsert(
      prisma,
      {
        tenantId: null,
        clientId: null,
        sourceType: 'bill',
        sourceId: 'bill-1',
        text: 'federal bill text long enough to embed',
        bypassRls: true,
      },
      p,
    );

    expect(executeRaw.mock.calls[0]?.[0]).toBe(`SET LOCAL app.bypass_rls = 'on'`);
    expect(String(executeRaw.mock.calls[1]?.[0])).toContain('INSERT INTO context_embeddings');
  });
});
