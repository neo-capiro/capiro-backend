import { describe, expect, it } from '@jest/globals';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  cleanupBackoffSeconds,
  DRAINABLE_CLEANUP_OPERATIONS,
  MAX_CLEANUP_ATTEMPTS,
  MemoryCleanupOutboxService,
} from './memory-cleanup-outbox.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';
const CLIO = '33333333-3333-4333-8333-333333333333';

/**
 * Each withSystem call gets its own recorded transaction, so the assertions can
 * distinguish the due-scan from the claim from the completion write — which is the
 * only way to prove the claim is atomic and single-shot.
 */
function harness(responder: (sql: string) => unknown) {
  const sqls: string[] = [];
  const render = (strings: TemplateStringsArray | { strings?: string[] }): string =>
    Array.isArray((strings as TemplateStringsArray).raw)
      ? (strings as unknown as string[]).join('?')
      : String(strings);
  const tx = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = render(strings);
      sqls.push(sql);
      return responder(sql) ?? [];
    }),
    $executeRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = render(strings);
      sqls.push(sql);
      return 1;
    }),
  };
  const prisma = {
    withSystem: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  } as unknown as PrismaService;
  return { service: new MemoryCleanupOutboxService(prisma), sqls, tx };
}

describe('cleanupBackoffSeconds', () => {
  it('starts at a minute and grows exponentially', () => {
    expect(cleanupBackoffSeconds(0)).toBe(60);
    expect(cleanupBackoffSeconds(1)).toBe(120);
    expect(cleanupBackoffSeconds(3)).toBe(480);
  });

  it('caps at six hours so an exhausted job cannot become a hot loop', () => {
    expect(cleanupBackoffSeconds(50)).toBe(6 * 60 * 60);
  });

  it('treats a nonsense attempt count as the first attempt', () => {
    expect(cleanupBackoffSeconds(Number.NaN)).toBe(60);
    expect(cleanupBackoffSeconds(-5)).toBe(60);
  });
});

describe('MemoryCleanupOutboxService.enqueue', () => {
  it('is idempotent on (tenant_id, idempotency_key)', async () => {
    const h = harness(() => []);
    const captured: string[] = [];
    const tx = {
      $executeRaw: jest.fn(async (strings: TemplateStringsArray) => {
        captured.push(strings.join('?'));
        return 1;
      }),
    } as never;
    await h.service.enqueue(tx, TENANT, {
      memoryItemId: ITEM,
      clioMemoryId: CLIO,
      operation: 'revoke_projections',
      idempotencyKey: `revoke:${ITEM}`,
    });
    expect(captured[0]).toContain('INSERT INTO memory_cleanup_outbox');
    expect(captured[0]).toContain('ON CONFLICT (tenant_id, idempotency_key) DO NOTHING');
  });

  it('caps the idempotency key at the column width', async () => {
    const h = harness(() => []);
    const params: unknown[] = [];
    const tx = {
      $executeRaw: jest.fn(async (_s: TemplateStringsArray, ...args: unknown[]) => {
        params.push(...args);
        return 1;
      }),
    } as never;
    await h.service.enqueue(tx, TENANT, {
      memoryItemId: ITEM,
      operation: 'purge_projections',
      idempotencyKey: 'k'.repeat(400),
    });
    expect(params.some((p) => typeof p === 'string' && p.length === 192)).toBe(true);
  });
});

describe('MemoryCleanupOutboxService.drainPending', () => {
  it('claims only rows that are due and under the attempt ceiling', async () => {
    const h = harness((sql) => (sql.includes('SELECT id::text AS id') ? [] : []));
    const summary = await h.service.drainPending(10);
    expect(summary).toEqual({ processed: 0, succeeded: 0, vanished: 0, failed: 0 });
    const scan = h.sqls[0];
    expect(scan).toContain("status IN ('pending', 'failed')");
    expect(scan).toContain('next_attempt_at <= now()');
    expect(scan).toContain('attempts <');
  });

  it('claims with an atomic conditional UPDATE that also burns an attempt', async () => {
    const h = harness((sql) => {
      if (sql.includes('SELECT id::text AS id\n        FROM memory_cleanup_outbox')) {
        return [{ id: 'job-1' }];
      }
      if (sql.includes('UPDATE memory_cleanup_outbox')) {
        return [
          {
            id: 'job-1',
            tenant_id: TENANT,
            memory_item_id: ITEM,
            clio_memory_id: CLIO,
            operation: 'revoke_projections',
            attempts: 1,
          },
        ];
      }
      if (sql.includes('FROM memory_items')) return [{ id: ITEM }];
      return [];
    });
    const summary = await h.service.drainPending(10);
    expect(summary).toEqual({ processed: 1, succeeded: 1, vanished: 0, failed: 0 });
    const claim = h.sqls.find((s) => s.includes("SET status = 'running'"));
    expect(claim).toContain('attempts = attempts + 1');
    expect(claim).toContain("status IN ('pending', 'failed')");
    expect(h.sqls.some((s) => s.includes('DELETE FROM context_embeddings'))).toBe(true);
    expect(h.sqls.some((s) => s.includes('DELETE FROM clio_memory'))).toBe(true);
    expect(h.sqls.some((s) => s.includes("SET status = 'completed'"))).toBe(true);
  });

  it('does not touch clio_memory when the job carries no clio id', async () => {
    const h = harness((sql) => {
      if (sql.includes('SELECT id::text AS id\n        FROM memory_cleanup_outbox')) {
        return [{ id: 'job-1' }];
      }
      if (sql.includes('UPDATE memory_cleanup_outbox')) {
        return [
          {
            id: 'job-1',
            tenant_id: TENANT,
            memory_item_id: ITEM,
            clio_memory_id: null,
            operation: 'expire_projections',
            attempts: 1,
          },
        ];
      }
      if (sql.includes('FROM memory_items')) return [{ id: ITEM }];
      return [];
    });
    await h.service.drainPending(10);
    expect(h.sqls.some((s) => s.includes('DELETE FROM clio_memory'))).toBe(false);
  });

  /**
   * memory_cleanup_outbox.memory_item_id is NOT NULL with NO foreign key, while
   * MemoryPurgeService deletes memory_items outright on client offboarding. Without
   * this branch a purge would leave jobs retrying to exhaustion forever.
   */
  it('completes rather than retries when the subject item is already gone', async () => {
    const h = harness((sql) => {
      if (sql.includes('SELECT id::text AS id\n        FROM memory_cleanup_outbox')) {
        return [{ id: 'job-1' }];
      }
      if (sql.includes('UPDATE memory_cleanup_outbox')) {
        return [
          {
            id: 'job-1',
            tenant_id: TENANT,
            memory_item_id: ITEM,
            clio_memory_id: CLIO,
            operation: 'purge_projections',
            attempts: 1,
          },
        ];
      }
      if (sql.includes('FROM memory_items')) return []; // purged
      return [];
    });
    const summary = await h.service.drainPending(10);
    expect(summary).toEqual({ processed: 1, succeeded: 0, vanished: 1, failed: 0 });
    expect(h.sqls.some((s) => s.includes("SET status = 'completed'"))).toBe(true);
    expect(h.sqls.some((s) => s.includes("SET status = 'failed'"))).toBe(false);
  });

  it('treats a job it cannot execute as a failure with the reason captured', async () => {
    const h = harness((sql) => {
      if (sql.includes('SELECT id::text AS id\n        FROM memory_cleanup_outbox')) {
        return [{ id: 'job-1' }];
      }
      if (sql.includes("SET status = 'running'")) {
        return [
          {
            id: 'job-1',
            tenant_id: TENANT,
            memory_item_id: ITEM,
            clio_memory_id: null,
            operation: 'index_memory_item',
            attempts: 1,
          },
        ];
      }
      if (sql.includes("SET status = 'failed'")) return [{ attempts: 1, tenant_id: TENANT }];
      return [];
    });
    const summary = await h.service.drainPending(10);
    expect(summary.failed).toBe(1);
    const failWrite = h.sqls.find((s) => s.includes("SET status = 'failed'"));
    expect(failWrite).toContain('last_error =');
    expect(h.sqls.some((s) => s.includes('next_attempt_at = now() +'))).toBe(true);
  });

  it('counts a row another drain already claimed as neither success nor failure', async () => {
    const h = harness((sql) => {
      if (sql.includes('SELECT id::text AS id\n        FROM memory_cleanup_outbox')) {
        return [{ id: 'job-1' }];
      }
      return []; // the conditional claim matched nothing
    });
    const summary = await h.service.drainPending(10);
    expect(summary).toEqual({ processed: 1, succeeded: 0, vanished: 0, failed: 0 });
  });
});

describe('cleanup operation vocabulary', () => {
  /**
   * `index_memory_item` was excluded here until the gap-B2 work (closeout §4):
   * this worker only deleted projections and carried no projector, so a queued
   * index job could never be worked off — `processJob` failed it as
   * `unsupported operation`. It is drainable now, with the projector INJECTED
   * rather than reimplemented, which is what lets `commitToClioMemory` stop
   * relying on fire-and-forget dispatch for correctness.
   */
  it('includes index_memory_item now that a projector is injected', () => {
    expect(DRAINABLE_CLEANUP_OPERATIONS).toContain('index_memory_item');
    expect(DRAINABLE_CLEANUP_OPERATIONS).toEqual([
      'index_memory_item',
      'revoke_projections',
      'supersede_projections',
      'expire_projections',
      'purge_projections',
    ]);
  });

  /**
   * The forward operation is the only entry that CREATES rather than deletes.
   * Every other one must stay a deletion, or a "cleanup" job could resurrect the
   * projection of a memory that was revoked.
   */
  it('keeps every other drainable operation a deletion', () => {
    const others = DRAINABLE_CLEANUP_OPERATIONS.filter((op) => op !== 'index_memory_item');
    expect(others.every((op) => /_projections$/.test(op))).toBe(true);
  });

  it('has a finite attempt ceiling', () => {
    expect(MAX_CLEANUP_ATTEMPTS).toBeGreaterThan(0);
    expect(Number.isFinite(MAX_CLEANUP_ATTEMPTS)).toBe(true);
  });
});
