import { describe, expect, jest, test } from '@jest/globals';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MemoryIngestService } from './memory-ingest.service.js';
import { ExactMemoryCleanupOutboxService } from './exact-memory-cleanup-outbox.service.js';
import { projectionMaterialForClioRow } from './strict-memory-projector.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CLIO = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';
const UPDATED_AT = new Date('2026-07-30T12:00:00Z');

interface Captured {
  sql: string;
  params: unknown[];
}

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
    createdAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
  };
}

function harness() {
  const captured: Captured[] = [];
  const tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...params: unknown[]) => {
      captured.push({ sql: sqlText(strings), params });
      return [sourceRow()];
    }),
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...params: unknown[]) => {
      captured.push({ sql: sqlText(strings), params });
      return 1;
    }),
  } as unknown as Prisma.TransactionClient;
  const prisma = {
    withSystem: jest.fn(async <T>(fn: (arg: Prisma.TransactionClient) => Promise<T>) => fn(tx)),
  } as unknown as PrismaService;
  const ingest = {
    projectClioMemory: jest.fn(async () => undefined),
  } as unknown as MemoryIngestService;
  return {
    service: new ExactMemoryCleanupOutboxService(prisma, ingest),
    tx,
    captured,
  };
}

describe('ExactMemoryCleanupOutboxService', () => {
  test('binds an index job to exact source version, hash, and canonical key', async () => {
    const h = harness();
    await h.service.enqueue(h.tx, TENANT, {
      memoryItemId: ITEM,
      clioMemoryId: CLIO,
      operation: 'index_memory_item',
      idempotencyKey: 'caller-value-is-not-trusted',
    });

    const insert = h.captured.find((entry) => entry.sql.includes('INSERT INTO memory_cleanup_outbox'));
    expect(insert).toBeDefined();
    const material = projectionMaterialForClioRow(sourceRow());
    expect(insert!.params).toEqual(
      expect.arrayContaining([
        TENANT,
        ITEM,
        CLIO,
        material.idempotencyKey,
        new Date(material.sourceVersion),
        material.contentHash,
      ]),
    );
    expect(insert!.sql).toContain('expected_source_version');
    expect(insert!.sql).toContain('expected_content_hash');
  });

  test('does not run the old broad index completion update', async () => {
    const h = harness();
    await h.service.markIndexedOnFastPath(TENANT, CLIO);
    expect(h.captured).toHaveLength(0);
  });

  test('closes a deletion fast path by exact idempotency key', async () => {
    const h = harness();
    await h.service.markIndexedOnFastPath(TENANT, CLIO, 'revoke_projections');

    const update = h.captured.find((entry) => entry.sql.includes('UPDATE memory_cleanup_outbox'));
    expect(update).toBeDefined();
    expect(update!.params).toEqual(
      expect.arrayContaining([TENANT, CLIO, 'revoke_projections', `revoke_projections:${CLIO}`]),
    );
    expect(update!.sql).toContain('idempotency_key');
    expect(update!.sql).toMatch(/status IN \('pending', 'failed'\)/);
  });

  test('rejects an index obligation without a Clio source identity', async () => {
    const h = harness();
    await expect(
      h.service.enqueue(h.tx, TENANT, {
        operation: 'index_memory_item',
        idempotencyKey: 'missing-source',
      }),
    ).rejects.toThrow('index_memory_item requires clioMemoryId');
  });
});
