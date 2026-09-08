import type { PrismaClient } from '@prisma/client';
import { embedAndUpsert } from './embedder.js';
import type { EmbeddingProvider } from './embedding-provider.js';

function fixture() {
  let inTransaction = false;
  const tx = { $executeRawUnsafe: jest.fn().mockResolvedValue(1) };
  const prisma = {
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn(async (fn) => {
      inTransaction = true;
      try { return await fn(tx); } finally { inTransaction = false; }
    }),
  };
  const provider: EmbeddingProvider = {
    metadata: { provider: 'test', model: 'test-model', modelVersion: '1', dimensions: 1024 },
    embed: jest.fn(async () => {
      expect(inTransaction).toBe(false);
      return Array(1024).fill(0);
    }),
    embedBatch: jest.fn(),
  };
  const args = { tenantId: 'tenant', clientId: 'client', sourceType: 'client_doc_chunk', sourceId: 'doc:0', text: 'A real document excerpt' };
  return { tx, prisma, provider, args, isInTransaction: () => inTransaction };
}

describe('embedding source guard at write commit', () => {
  it('checks the source after embedding, inside the same short transaction as the insert', async () => {
    const f = fixture();
    const beforeWrite = jest.fn(async (tx) => {
      expect(f.provider.embed).toHaveBeenCalledTimes(1);
      expect(f.isInTransaction()).toBe(true);
      expect(tx).toBe(f.tx);
      await tx.$executeRawUnsafe('LOCK SOURCE');
      return true;
    });
    await expect(embedAndUpsert(f.prisma as unknown as PrismaClient, { ...f.args, beforeWrite }, f.provider)).resolves.toBe('inserted');
    expect(beforeWrite).toHaveBeenCalledTimes(1);
    expect(f.tx.$executeRawUnsafe.mock.calls[0]?.[0]).toBe('LOCK SOURCE');
    expect(f.tx.$executeRawUnsafe.mock.calls[1]?.[0]).toContain('INSERT INTO context_embeddings');
  });

  it.each([{ existing: [] }, { existing: [{ content_hash: 'old-hash' }] }])('skips insert/update when the source changed during the provider call (%j)', async ({ existing }) => {
    const f = fixture();
    f.prisma.$queryRawUnsafe.mockResolvedValue(existing);
    let sameSource = true;
    jest.mocked(f.provider.embed).mockImplementation(async () => {
      sameSource = false;
      return Array(1024).fill(0);
    });
    await expect(embedAndUpsert(f.prisma as unknown as PrismaClient,
      { ...f.args, beforeWrite: async () => sameSource }, f.provider)).resolves.toBe('skipped');
    expect(f.tx.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('preserves the ordinary unguarded producer path', async () => {
    const f = fixture();
    await expect(embedAndUpsert(f.prisma as unknown as PrismaClient, f.args, f.provider)).resolves.toBe('inserted');
    expect(f.provider.embed).toHaveBeenCalledTimes(1);
    expect(f.tx.$executeRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO context_embeddings'),
      'tenant', 'client', null, 'client_doc_chunk', 'doc:0', 'test-model', f.args.text, expect.any(String));
  });
});
