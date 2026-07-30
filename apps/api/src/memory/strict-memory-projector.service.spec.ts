import { describe, expect, jest, test } from '@jest/globals';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MemoryStoreService } from './memory-store.service.js';
import {
  projectionMaterialForClioRow,
  StrictMemoryProjectorService,
} from './strict-memory-projector.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CLIO = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';
const SOURCE_UPDATED_AT = new Date('2026-07-30T00:00:00Z');

function sqlText(strings: TemplateStringsArray | unknown): string {
  return Array.isArray((strings as TemplateStringsArray).raw)
    ? (strings as unknown as string[]).join('?')
    : String(strings);
}

function sourceRow(updatedAt = SOURCE_UPDATED_AT) {
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
    updatedAt,
  };
}

function harness(
  options: {
    source?: boolean;
    projected?: boolean;
    embedded?: boolean;
    deletedAfterProjection?: boolean;
    changedAfterProjection?: boolean;
    projectedContentMismatch?: boolean;
  } = {},
) {
  const sqls: string[] = [];
  let sourceReads = 0;
  const expectedMaterial = projectionMaterialForClioRow(sourceRow());
  const tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = sqlText(strings);
      sqls.push(sql);
      if (sql.includes('FROM clio_memory')) {
        sourceReads += 1;
        if (sourceReads === 1 && options.source === false) return [];
        if (sourceReads > 1 && options.deletedAfterProjection) return [];
        if (sourceReads > 1 && options.changedAfterProjection) {
          return [sourceRow(new Date('2026-07-31T00:00:00Z'))];
        }
        return [sourceRow()];
      }
      if (sql.includes('FROM memory_items')) {
        if (options.projected === false) return [];
        return [
          {
            id: ITEM,
            client_id: null,
            owner_user_id: null,
            title: expectedMaterial.item.title,
            sections_jsonb: options.projectedContentMismatch
              ? [{ key: 'memory', heading: 'Memory', owner: 'human', body: 'Wrong text.' }]
              : expectedMaterial.item.sections,
          },
        ];
      }
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
  return { service, store, writeEmbedding, sqls, expectedMaterial };
}

describe('StrictMemoryProjectorService', () => {
  test('treats a deleted source as an idempotent vanished job', async () => {
    const h = harness({ source: false });
    await expect(h.service.projectClioMemoryStrict(TENANT, CLIO)).resolves.toMatchObject({
      outcome: 'vanished',
      tenantId: TENANT,
      clioMemoryId: CLIO,
      sourceVersion: null,
    });
    expect(h.store.upsertSystem).not.toHaveBeenCalled();
    expect(h.writeEmbedding).not.toHaveBeenCalled();
  });

  test('writes and verifies the exact canonical item, content hash, and embedding', async () => {
    const h = harness();
    const receipt = await h.service.projectClioMemoryStrict(TENANT, CLIO);
    expect(receipt).toMatchObject({
      outcome: 'projected',
      tenantId: TENANT,
      clioMemoryId: CLIO,
      sourceVersion: SOURCE_UPDATED_AT.toISOString(),
      contentHash: h.expectedMaterial.contentHash,
      idempotencyKey: h.expectedMaterial.idempotencyKey,
      memoryItemId: ITEM,
    });
    expect(h.writeEmbedding).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, sourceId: ITEM }),
    );
    expect(h.sqls.some((sql) => sql.includes('FROM memory_items'))).toBe(true);
    expect(h.sqls.some((sql) => sql.includes('FROM context_embeddings'))).toBe(true);
  });

  test('does not project when the queued version/hash is already stale', async () => {
    const h = harness();
    const receipt = await h.service.projectClioMemoryStrict(TENANT, CLIO, {
      sourceVersion: '2026-07-29T00:00:00.000Z',
      contentHash: 'a'.repeat(64),
      idempotencyKey: `index_memory_item:${CLIO}:2026-07-29T00:00:00.000Z`,
    });
    expect(receipt.outcome).toBe('superseded');
    expect(h.store.upsertSystem).not.toHaveBeenCalled();
    expect(h.writeEmbedding).not.toHaveBeenCalled();
  });

  test('does not report completion when the canonical item is absent', async () => {
    const h = harness({ projected: false });
    await expect(h.service.projectClioMemoryStrict(TENANT, CLIO)).rejects.toThrow(
      'memory_projection_missing',
    );
  });

  test('does not report completion when projected content does not match the expected hash', async () => {
    const h = harness({ projectedContentMismatch: true });
    await expect(h.service.projectClioMemoryStrict(TENANT, CLIO)).rejects.toThrow(
      'memory_projection_content_mismatch',
    );
  });

  test('does not report completion when the expected embedding is absent', async () => {
    const h = harness({ embedded: false });
    await expect(h.service.projectClioMemoryStrict(TENANT, CLIO)).rejects.toThrow(
      'memory_embedding_missing',
    );
  });

  test('embeds the exact authoritative item without creating a duplicate Clio projection', async () => {
    const h = harness();
    await expect(
      h.service.projectClioMemoryStrict(TENANT, CLIO, {
        sourceVersion: h.expectedMaterial.sourceVersion,
        contentHash: h.expectedMaterial.contentHash,
        memoryItemId: ITEM,
        idempotencyKey: h.expectedMaterial.idempotencyKey,
      }),
    ).resolves.toMatchObject({
      outcome: 'projected',
      memoryItemId: ITEM,
      contentHash: h.expectedMaterial.contentHash,
    });
    expect(h.store.upsertSystem).not.toHaveBeenCalled();
    expect(h.writeEmbedding).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, sourceId: ITEM }),
    );
  });

  test('cleans up a compatibility projection when its source disappears during embedding', async () => {
    const h = harness({ deletedAfterProjection: true });
    await expect(h.service.projectClioMemoryStrict(TENANT, CLIO)).resolves.toMatchObject({
      outcome: 'vanished',
      sourceVersion: SOURCE_UPDATED_AT.toISOString(),
    });
    expect(h.sqls.some((sql) => sql.includes('DELETE FROM context_embeddings'))).toBe(true);
    expect(h.sqls.some((sql) => sql.includes('DELETE FROM memory_items'))).toBe(true);
  });

  test('marks the old obligation superseded when a newer version arrives in flight', async () => {
    const h = harness({ changedAfterProjection: true });
    await expect(h.service.projectClioMemoryStrict(TENANT, CLIO)).resolves.toMatchObject({
      outcome: 'superseded',
      sourceVersion: SOURCE_UPDATED_AT.toISOString(),
      contentHash: h.expectedMaterial.contentHash,
    });
  });
});
