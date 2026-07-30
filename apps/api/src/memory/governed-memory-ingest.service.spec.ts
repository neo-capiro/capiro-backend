import { describe, expect, jest, test } from '@jest/globals';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MemoryStoreService } from './memory-store.service.js';
import type { TenantContextStore } from '../tenant/tenant-context.store.js';
import type { MeetingNotesCryptoService } from '../engagement/meeting-notes-crypto.service.js';
import type { StrictMemoryProjectorService } from './strict-memory-projector.service.js';
import { GovernedMemoryIngestService } from './governed-memory-ingest.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CLIO = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';
const VERSION = '2026-07-30T12:00:00.000Z';
const HASH = 'a'.repeat(64);
const KEY = `index_memory_item:${CLIO}:${VERSION}`;

function sqlText(strings: TemplateStringsArray | unknown): string {
  return Array.isArray((strings as TemplateStringsArray).raw)
    ? (strings as unknown as string[]).join('?')
    : String(strings);
}

function harness(
  outcome: 'projected' | 'superseded' | 'vanished' = 'projected',
  failure?: Error,
) {
  const captured: Array<{ sql: string; params: unknown[] }> = [];
  const tx = {
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
        sourceVersion: outcome === 'vanished' ? null : VERSION,
        contentHash: outcome === 'vanished' ? null : HASH,
        idempotencyKey: outcome === 'vanished' ? null : KEY,
        memoryItemId: ITEM,
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

describe('GovernedMemoryIngestService', () => {
  test('strict request-time success completes only its exact version/hash-bound job', async () => {
    const h = harness('projected');
    await h.service.projectClioMemory(TENANT, CLIO);

    expect(h.projector.projectClioMemoryStrict).toHaveBeenCalledWith(TENANT, CLIO, undefined);
    const update = h.captured[0]!;
    expect(update.sql).toContain('idempotency_key');
    expect(update.sql).toContain('expected_source_version');
    expect(update.sql).toContain('expected_content_hash');
    expect(update.params).toEqual(
      expect.arrayContaining(['completed', TENANT, CLIO, KEY, new Date(VERSION), HASH]),
    );
  });

  test('an in-flight newer version marks only the old exact obligation superseded', async () => {
    const h = harness('superseded');
    await h.service.projectClioMemory(TENANT, CLIO);

    const update = h.captured[0]!;
    expect(update.params).toEqual(
      expect.arrayContaining(['superseded', 'source_advanced', TENANT, CLIO, KEY, HASH]),
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

  test('a source missing before expectation resolution does not guess which job to close', async () => {
    const h = harness('vanished');
    await h.service.projectClioMemory(TENANT, CLIO);
    expect(h.captured).toHaveLength(0);
  });
});
