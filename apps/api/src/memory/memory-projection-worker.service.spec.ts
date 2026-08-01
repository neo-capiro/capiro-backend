import { describe, expect, jest, test } from '@jest/globals';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import { MAX_CLEANUP_ATTEMPTS } from './memory-cleanup-outbox.service.js';
import {
  memoryWorkerErrorCode,
  MemoryProjectionWorkerService,
} from './memory-projection-worker.service.js';
import type { StrictMemoryProjectorService } from './strict-memory-projector.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';
const CLIO = '33333333-3333-4333-8333-333333333333';
const JOB = '44444444-4444-4444-8444-444444444444';

function sqlText(strings: TemplateStringsArray | unknown): string {
  return Array.isArray((strings as TemplateStringsArray).raw)
    ? (strings as unknown as string[]).join('?')
    : String(strings);
}

interface HarnessOptions {
  operation?: string;
  attempts?: number;
  memoryItemId?: string | null;
  clioMemoryId?: string | null;
  subjectPresent?: boolean;
  projectorResult?: 'projected' | 'vanished';
  projectorError?: Error;
  claimOnlyOnce?: boolean;
  exhaustedLeaseCount?: number;
}

function harness(options: HarnessOptions = {}) {
  const sqls: string[] = [];
  let claims = 0;
  const claimed = {
    id: JOB,
    tenant_id: TENANT,
    memory_item_id: options.memoryItemId === undefined ? ITEM : options.memoryItemId,
    clio_memory_id: options.clioMemoryId === undefined ? CLIO : options.clioMemoryId,
    operation: options.operation ?? 'index_memory_item',
    attempts: options.attempts ?? 1,
    lease_owner: 'memory-worker:test',
  };
  const tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = sqlText(strings);
      sqls.push(sql);
      if (sql.includes('WITH due AS')) {
        claims += 1;
        if (options.claimOnlyOnce && claims > 1) return [];
        return [claimed];
      }
      if (sql.includes("SET status = 'dead_letter'")) return [{ status: 'dead_letter' }];
      if (sql.includes("SET status = 'failed'")) return [{ status: 'failed' }];
      if (sql.includes('FROM memory_items')) {
        return options.subjectPresent === false ? [] : [{ id: ITEM }];
      }
      return [];
    }),
    $executeRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = sqlText(strings);
      sqls.push(sql);
      if (sql.includes('lease_expired_after_attempt_ceiling')) {
        return options.exhaustedLeaseCount ?? 0;
      }
      return 1;
    }),
  } as unknown as Prisma.TransactionClient;
  const prisma = {
    withSystem: jest.fn(async <T>(fn: (arg: Prisma.TransactionClient) => Promise<T>) => fn(tx)),
  } as unknown as PrismaService;
  const projector = {
    projectClioMemoryStrict: options.projectorError
      ? jest.fn(async () => Promise.reject(options.projectorError))
      : jest.fn(async () => options.projectorResult ?? 'projected'),
  } as unknown as StrictMemoryProjectorService;
  return {
    worker: new MemoryProjectionWorkerService(prisma, projector),
    projector,
    sqls,
  };
}

describe('MemoryProjectionWorkerService', () => {
  test('uses the injected strict projector and completes a durable index job', async () => {
    const h = harness();
    await expect(h.worker.drainPending(10, 120)).resolves.toEqual({
      processed: 1,
      succeeded: 1,
      vanished: 0,
      failed: 0,
      deadLettered: 0,
    });
    expect(h.projector.projectClioMemoryStrict).toHaveBeenCalledWith(TENANT, CLIO);
    expect(h.sqls.some((sql) => sql.includes("SET status = 'completed'"))).toBe(true);
  });

  test('claims a batch with SKIP LOCKED, expiring leases, and stale-running recovery', async () => {
    const h = harness({ claimOnlyOnce: true });
    await Promise.all([h.worker.drainPending(10, 90), h.worker.drainPending(10, 90)]);
    expect(h.projector.projectClioMemoryStrict).toHaveBeenCalledTimes(1);
    const claim = h.sqls.find((sql) => sql.includes('WITH due AS')) ?? '';
    expect(claim).toContain('FOR UPDATE SKIP LOCKED');
    expect(claim).toContain("status = 'running' AND lease_expires_at <= now()");
    expect(claim).toContain('lease_expires_at = now() +');
    expect(claim).toContain('attempts = job.attempts + 1');
  });

  test('treats an already-missing cleanup subject as an idempotent completion', async () => {
    const h = harness({ operation: 'purge_projections', subjectPresent: false });
    await expect(h.worker.drainPending()).resolves.toMatchObject({
      processed: 1,
      vanished: 1,
      failed: 0,
      deadLettered: 0,
    });
    expect(h.sqls.some((sql) => sql.includes('DELETE FROM context_embeddings'))).toBe(true);
    expect(h.sqls.some((sql) => sql.includes("SET status = 'completed'"))).toBe(true);
  });

  test('retries failures with backoff before the ceiling', async () => {
    const h = harness({ projectorError: new Error('projection_failed'), attempts: 2 });
    await expect(h.worker.drainPending()).resolves.toMatchObject({ failed: 1, deadLettered: 0 });
    const failed = h.sqls.find((sql) => sql.includes("SET status = 'failed'")) ?? '';
    expect(failed).toContain('next_attempt_at = now() +');
    expect(failed).toContain('lease_owner = NULL');
  });

  test('moves an exhausted failure to terminal dead-letter state', async () => {
    const h = harness({
      projectorError: new Error('projection_failed'),
      attempts: MAX_CLEANUP_ATTEMPTS,
    });
    await expect(h.worker.drainPending()).resolves.toMatchObject({
      failed: 0,
      deadLettered: 1,
    });
    const dead = h.sqls.find((sql) => sql.includes("SET status = 'dead_letter'")) ?? '';
    expect(dead).toContain('dead_lettered_at = now()');
    expect(dead).toContain('lease_owner = NULL');
  });

  test('recovers a crashed final-attempt lease directly to dead-letter', async () => {
    const h = harness({ claimOnlyOnce: true, exhaustedLeaseCount: 1 });
    const summary = await h.worker.drainPending();
    expect(summary.deadLettered).toBe(1);
    expect(h.sqls.some((sql) => sql.includes('lease_expired_after_attempt_ceiling'))).toBe(true);
  });

  test('never persists or logs a provider/body error message', async () => {
    const secret = 'CLASSIFIED CLIENT BODY SHOULD NEVER APPEAR';
    const h = harness({ projectorError: new Error(secret), attempts: 1 });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await h.worker.drainPending();
      const output = errorSpy.mock.calls.flat().join(' ');
      expect(output).not.toContain(secret);
      expect(memoryWorkerErrorCode(new Error(secret))).toBe('error');
    } finally {
      errorSpy.mockRestore();
    }
  });
});
