import { describe, expect, jest, test } from '@jest/globals';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MemoryStoreService } from './memory-store.service.js';
import { StrictMemoryProjectorService } from './strict-memory-projector.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CLIO = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';
const SOURCE_UPDATED_AT = new Date('2026-07-30T00:00:00Z');

function sqlText(strings: TemplateStringsArray | unknown): string {
  return Array.isArray((strings as TemplateStringsArray).raw)
    ? (strings as unknown as string[]).join('?')
    : String(strings);
}

function sourceRow() {
  return {
    id: CLIO,
    tenantId: TENANT,
    scope: 'firm',
    ownerUserId: null,
    clientId: null,
    expiresAt: null,
    key: 'Firm position',
    value: 'Support the full authorization and appropriation request.',
    source: 'explicit_user',
    metadata: {},
    createdAt: SOURCE_UPDATED_AT,
    updatedAt: SOURCE_UPDATED_AT,
  };
}

function harness(
  options: {
    source?: boolean;
    projected?: boolean;
    embedded?: boolean;
    deletedAfterProjection?: boolean;
    changedAfterProjection?: boolean;
  } = {},
) {
  const sqls: string[] = [];
  const tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = sqlText(strings);
      sqls.push(sql);
      if (sql.includes('SELECT updated_at')) {
        if (options.deletedAfterProjection) return [];
        return [
          {
            updated_at: options.changedAfterProjection
              ? new Date('2026-07-31T00:00:00Z')
              : SOURCE_UPDATED_AT,
          },
        ];
      }
      if (sql.includes('FROM clio_memory')) return options.source === false ? [] : [sourceRow()];
      if (sql.includes('FROM memory_items')) return options.projected === false ? [] : [{ id: ITEM }];
      if (sql.includes('FROM context_embeddings')) {
        return options.embedded === false ? [] : [{ source_id: ITEM }];
      }
      return [];
    }),
    $executeRaw: jest.fn(async (strings: TemplateStringsArray) => {
      sqls.push(sqlText(strings));
      return 1;
    }),
  } as unknown as Prisma.TransactionClient;
  const prisma = {
    withSystem: jest.fn(async <T>(fn: (arg: Prisma.TransactionClient) => Promise<T>) => fn(tx)),
  } as unknown as PrismaService;
  const store = {
    upsertSystem: jest.fn(async () => ITEM),
  } as unknown as MemoryStoreService;
  const service = new StrictMemoryProjectorService(prisma, store);
  const writeEmbedding = jest.fn(async () => undefined);
  (
    service as unknown as {
      writeEmbedding: (input: Record<string, unknown>) => Promise<void>;
    }
  ).writeEmbedding = writeEmbedding;
  return { service, store, writeEmbedding, sqls };
}

describe('StrictMemoryProjectorService', () => {
  test('treats a deleted source as an idempotent vanished job', async () => {
    const h = harness({ source: false });
    await expect(h.service.projectClioMemoryStrict(TENANT, CLIO)).resolves.toBe('vanished');
    expect(h.store.upsertSystem).not.toHaveBeenCalled();
    expect(h.writeEmbedding).not.toHaveBeenCalled();
  });

  test('writes through the canonical store and verifies item plus expected embedding', async () => {
    const h = harness();
    await expect(h.service.projectClioMemoryStrict(TENANT, CLIO)).resolves.toBe('projected');
    expect(h.store.upsertSystem).toHaveBeenCalledTimes(1);
    expect(h.writeEmbedding).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, sourceId: ITEM }),
    );
    expect(h.sqls.some((sql) => sql.includes('FROM memory_items'))).toBe(true);
    expect(h.sqls.some((sql) => sql.includes('FROM context_embeddings'))).toBe(true);
  });

  test('does not report completion when the canonical item is absent', async () => {
    const h = harness({ projected: false });
    await expect(h.service.projectClioMemoryStrict(TENANT, CLIO)).rejects.toThrow(
      'memory_projection_missing',
    );
  });

  test('does not report completion when the expected embedding is absent', async () => {
    const h = harness({ embedded: false });
    await expect(h.service.projectClioMemoryStrict(TENANT, CLIO)).rejects.toThrow(
      'memory_embedding_missing',
    );
  });

  test('cleans up a projection when the source disappears during embedding', async () => {
    const h = harness({ deletedAfterProjection: true });
    await expect(h.service.projectClioMemoryStrict(TENANT, CLIO)).resolves.toBe('vanished');
    expect(h.sqls.some((sql) => sql.includes('DELETE FROM context_embeddings'))).toBe(true);
    expect(h.sqls.some((sql) => sql.includes('DELETE FROM memory_items'))).toBe(true);
  });

  test('retries when a newer source version arrives during projection', async () => {
    const h = harness({ changedAfterProjection: true });
    await expect(h.service.projectClioMemoryStrict(TENANT, CLIO)).rejects.toThrow(
      'memory_source_changed_during_projection',
    );
  });
});
