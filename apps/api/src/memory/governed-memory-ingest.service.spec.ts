import { describe, expect, jest, test } from '@jest/globals';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MemoryStoreService } from './memory-store.service.js';
import type { TenantContextStore } from '../tenant/tenant-context.store.js';
import type { MeetingNotesCryptoService } from '../engagement/meeting-notes-crypto.service.js';
import type { StrictMemoryProjectorService } from './strict-memory-projector.service.js';
import { exactProjectionIdempotencyKey } from './exact-memory-cleanup-outbox.service.js';
import { GovernedMemoryIngestService } from './governed-memory-ingest.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CLIO = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';
const JOB = '44444444-4444-4444-8444-444444444444';
const VERSION = '2026-07-30T12:00:00.000Z';
const HASH = 'a'.repeat(64);
const KEY = exactProjectionIdempotencyKey(CLIO, VERSION, HASH);

function sqlText(strings: TemplateStringsArray | unknown): string {
  return Array.isArray((strings as TemplateStringsArray).raw)
    ? (strings as unknown as string[]).join('?')
    : String(strings);
}

function harness(
  outcome: 'projected' | 'superseded' | 'vanished' = 'projected',
  failure?: Error,
  hasJob = true,
  jobKey = KEY,
) {
  const captured: Array<{ sql: string; params: unknown[] }> = [];
  const tx = {
    $queryRaw: jest.fn(async () =>
      hasJob
        ? [
            {
              id: JOB,
              memory_item_id: ITEM,
              idempotency_key: jobKey,
              expected_source_version: new Date(VERSION),
              expected_content_hash: HASH,
            },
          ]
        : [],
    ),
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...params: unknown[]) => {
      captured.push({ sql: sqlText(strings), params });
      return 1;
    }),
  } as unknown as Prisma.TransactionClient;
  const prisma = {
    withSystem: jest.fn(async <T>(fn: (arg: Prisma.TransactionClient) => Promise<T>) => fn(tx)),
  } as unknown as PrismaService;
  const projector = {
    projectClioMemoryStrict: jest.fn(async () => {
      if (failure) throw failure;
      return {
        outcome,
        tenantId: TENANT,
        clioMemoryId: CLIO,
        sourceVersion: VERSION,
        contentHash: HASH,
        idempotencyKey: KEY,
        memoryItemId: outcome === 'vanished' ? null : ITEM,
        embeddingRequired: true,
      };
    }),
  } as unknown as StrictMemoryProjectorService;
  const service = new GovernedMemoryIngestService(
    prisma,
    {} as MemoryStoreService,
    {} as TenantContextStore,
    {} as MeetingNotesCryptoService,
    projector,
  );
  return { service, projector, captured };
}

const EXPECTATION = {
  sourceVersion: VERSION,
  contentHash: HASH,
  memoryItemId: ITEM,
  idempotencyKey: KEY,
};

describe('GovernedMemoryIngestService', () => {
  test('strict request-time success loads and completes only its exact queued job', async () => {
    const h = harness('projected');
    await h.service.projectClioMemory(TENANT, CLIO);

    expect(h.projector.projectClioMemoryStrict).toHaveBeenCalledWith(TENANT, CLIO, EXPECTATION);
    const update = h.captured[0]!;
    expect(update.sql).toContain('WHERE id =');
    expect(update.sql).toContain('idempotency_key');
    expect(update.sql).toContain('expected_source_version');
    expect(update.sql).toContain('expected_content_hash');
    expect(update.params).toEqual(
      expect.arrayContaining(['completed', JOB, TENANT, CLIO, KEY, new Date(VERSION), HASH]),
    );
  });

  test('an in-flight newer version marks only the old exact obligation superseded', async () => {
    const h = harness('superseded');
    await h.service.projectClioMemory(TENANT, CLIO);

    const update = h.captured[0]!;
    expect(update.params).toEqual(
      expect.arrayContaining(['superseded', 'source_advanced', JOB, TENANT, CLIO, KEY, HASH]),
    );
    expect(update.sql).toContain('superseded_at');
  });

  test('a projector failure leaves the durable job retryable', async () => {
    const h = harness('projected', new Error('embedding_provider_unavailable'));

    await expect(h.service.projectClioMemory(TENANT, CLIO)).rejects.toThrow(
      'embedding_provider_unavailable',
    );
    expect(h.captured).toHaveLength(0);
  });

  test('a vanished source closes only the exact known job', async () => {
    const h = harness('vanished');
    await h.service.projectClioMemory(TENANT, CLIO);

    expect(h.projector.projectClioMemoryStrict).toHaveBeenCalledWith(TENANT, CLIO, EXPECTATION);
    expect(h.captured[0]!.params).toEqual(
      expect.arrayContaining(['completed', JOB, TENANT, CLIO, KEY, HASH]),
    );
  });

  test('does not guess a projection target when no exact durable job is available', async () => {
    const h = harness('projected', undefined, false);
    await expect(h.service.projectClioMemory(TENANT, CLIO)).rejects.toThrow(
      'memory_projection_exact_job_unavailable',
    );
    expect(h.projector.projectClioMemoryStrict).not.toHaveBeenCalled();
    expect(h.captured).toHaveLength(0);
  });

  test('rejects a queued key not bound to the captured version and hash', async () => {
    const malformed = exactProjectionIdempotencyKey(CLIO, VERSION, 'c'.repeat(64));
    const h = harness('projected', undefined, true, malformed);

    await expect(h.service.projectClioMemory(TENANT, CLIO)).rejects.toThrow(
      'memory_projection_idempotency_binding_mismatch',
    );
    expect(h.projector.projectClioMemoryStrict).not.toHaveBeenCalled();
    expect(h.captured).toHaveLength(0);
  });
});
