import { describe, expect, jest, test } from '@jest/globals';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { StrictMemoryProjectorService } from './strict-memory-projector.service.js';
import { exactProjectionIdempotencyKey } from './exact-memory-cleanup-outbox.service.js';
import { ExactMemoryProjectionWorkerService } from './exact-memory-projection-worker.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CLIO = '22222222-2222-4222-8222-222222222222';
const ITEM = '33333333-3333-4333-8333-333333333333';
const JOB = '44444444-4444-4444-8444-444444444444';
const VERSION = new Date('2026-07-30T12:00:00.000Z');
const HASH = 'b'.repeat(64);
const KEY = exactProjectionIdempotencyKey(CLIO, VERSION.toISOString(), HASH);

function sqlText(strings: TemplateStringsArray | unknown): string {
  return Array.isArray((strings as TemplateStringsArray).raw)
    ? (strings as unknown as string[]).join('?')
    : String(strings);
}

interface TestJob {
  id: string;
  tenant_id: string;
  memory_item_id: string | null;
  clio_memory_id: string | null;
  operation: string;
  idempotency_key: string;
  expected_source_version: Date | null;
  expected_content_hash: string | null;
  attempts: number;
  lease_owner: string;
}

function job(overrides: Partial<TestJob> = {}): TestJob {
  return {
    id: JOB,
    tenant_id: TENANT,
    memory_item_id: ITEM,
    clio_memory_id: CLIO,
    operation: 'index_memory_item',
    idempotency_key: KEY,
    expected_source_version: VERSION,
    expected_content_hash: HASH,
    attempts: 1,
    lease_owner: 'memory-worker:lease-1',
    ...overrides,
  };
}

function harness(
  outcome: 'projected' | 'superseded' | 'vanished' = 'projected',
  failure?: Error,
) {
  const captured: Array<{ sql: string; params: unknown[]; kind: 'query' | 'execute' }> = [];
  const tx = {
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...params: unknown[]) => {
      captured.push({ sql: sqlText(strings), params, kind: 'execute' });
      return 1;
    }),
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...params: unknown[]) => {
      const sql = sqlText(strings);
      captured.push({ sql, params, kind: 'query' });
      if (sql.includes('UPDATE memory_cleanup_outbox')) return [{ status: 'failed' }];
      return [];
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
        sourceVersion: VERSION.toISOString(),
        contentHash: HASH,
        idempotencyKey: KEY,
        memoryItemId: ITEM,
        embeddingRequired: true,
      };
    }),
  } as unknown as StrictMemoryProjectorService;
  const service = new ExactMemoryProjectionWorkerService(prisma, projector);
  const process = (value: TestJob) =>
    (
      service as unknown as {
        processJob: (
          input: TestJob,
        ) => Promise<'completed' | 'vanished' | 'superseded' | 'failed' | 'dead_letter'>;
      }
    ).processJob(value);
  return { process, projector, captured };
}

describe('ExactMemoryProjectionWorkerService', () => {
  test('passes exact job identity, source version, hash, and item to the strict projector', async () => {
    const h = harness('projected');
    await expect(h.process(job())).resolves.toBe('completed');

    expect(h.projector.projectClioMemoryStrict).toHaveBeenCalledWith(TENANT, CLIO, {
      sourceVersion: VERSION.toISOString(),
      contentHash: HASH,
      memoryItemId: ITEM,
      idempotencyKey: KEY,
    });
    const complete = h.captured.find(
      (entry) => entry.kind === 'execute' && entry.sql.includes("SET status = 'completed'"),
    );
    expect(complete).toBeDefined();
    expect(complete!.params).toEqual(expect.arrayContaining([JOB, 'memory-worker:lease-1']));
    expect(complete!.sql).toContain('WHERE id =');
    expect(complete!.sql).toContain('lease_owner =');
  });

  test('marks an old job superseded without completing the newer obligation', async () => {
    const h = harness('superseded');
    await expect(h.process(job())).resolves.toBe('superseded');

    const supersede = h.captured.find(
      (entry) => entry.kind === 'execute' && entry.sql.includes("SET status = 'superseded'"),
    );
    expect(supersede).toBeDefined();
    expect(supersede!.params).toEqual(expect.arrayContaining([JOB, 'memory-worker:lease-1']));
    expect(
      h.captured.some(
        (entry) => entry.kind === 'execute' && entry.sql.includes("SET status = 'completed'"),
      ),
    ).toBe(false);
  });

  test('keeps the job retryable when the projector throws', async () => {
    const h = harness('projected', new Error('memory_embedding_missing'));

    await expect(h.process(job())).resolves.toBe('failed');
    const failed = h.captured.find(
      (entry) => entry.kind === 'query' && entry.sql.includes("SET status = 'failed'"),
    );
    expect(failed).toBeDefined();
    expect(failed!.params).toEqual(
      expect.arrayContaining(['memory_embedding_missing', JOB, 'memory-worker:lease-1']),
    );
    expect(
      h.captured.some(
        (entry) => entry.kind === 'execute' && entry.sql.includes("SET status = 'completed'"),
      ),
    ).toBe(false);
  });

  test('fails closed when a legacy index job lacks an exact expectation', async () => {
    const h = harness();
    await expect(
      h.process(job({ expected_source_version: null, expected_content_hash: null })),
    ).resolves.toBe('failed');
    expect(h.projector.projectClioMemoryStrict).not.toHaveBeenCalled();
  });

  test('refuses an idempotency key not bound to both expected version and hash', async () => {
    const h = harness();
    await expect(
      h.process(
        job({
          idempotency_key: exactProjectionIdempotencyKey(
            CLIO,
            VERSION.toISOString(),
            'c'.repeat(64),
          ),
        }),
      ),
    ).resolves.toBe('failed');
    expect(h.projector.projectClioMemoryStrict).not.toHaveBeenCalled();
  });
});
