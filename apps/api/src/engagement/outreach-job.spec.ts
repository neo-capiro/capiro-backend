// OutreachJobService (W4.2): pure job-rollup state machine, recipient keying,
// and idempotent submit. The multi-replica crash/exactly-once chaos test needs a
// real DB (deploy-verified per the plan); here we pin the logic that decides job
// status + the idempotency contract.

import { describe, expect, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import {
  OutreachJobService,
  computeJobRollup,
  outreachRecipientKey,
} from './outreach-job.service.js';

describe('computeJobRollup (W4.2)', () => {
  test('all pending → queued', () => {
    const r = computeJobRollup([{ status: 'pending' }, { status: 'pending' }]);
    expect(r.status).toBe('queued');
    expect(r.totals).toEqual({ queued: 2, succeeded: 0, failed: 0, skipped: 0, total: 2 });
  });

  test('some done, some pending → running', () => {
    const r = computeJobRollup([{ status: 'done' }, { status: 'pending' }]);
    expect(r.status).toBe('running');
    expect(r.totals.succeeded).toBe(1);
    expect(r.totals.queued).toBe(1);
  });

  test('all done → complete', () => {
    const r = computeJobRollup([{ status: 'done' }, { status: 'done' }]);
    expect(r.status).toBe('complete');
  });

  test('all failed → failed', () => {
    const r = computeJobRollup([{ status: 'failed' }, { status: 'failed' }]);
    expect(r.status).toBe('failed');
  });

  test('mix of done + failed → partial', () => {
    const r = computeJobRollup([{ status: 'done' }, { status: 'failed' }, { status: 'done' }]);
    expect(r.status).toBe('partial');
    expect(r.totals).toEqual({ queued: 0, succeeded: 2, failed: 1, skipped: 0, total: 3 });
  });

  test('done + skipped (no failures) → complete', () => {
    const r = computeJobRollup([{ status: 'done' }, { status: 'skipped' }]);
    expect(r.status).toBe('complete');
  });

  test('claimed/generating count as in-flight (queued bucket)', () => {
    const r = computeJobRollup([{ status: 'claimed' }, { status: 'generating' }]);
    expect(r.status).toBe('queued');
    expect(r.totals.queued).toBe(2);
  });
});

describe('outreachRecipientKey precedence', () => {
  test('id > directoryContactId > email > name > index', () => {
    expect(outreachRecipientKey({ id: 'A', email: 'e', name: 'n' }, 0)).toBe('A');
    expect(outreachRecipientKey({ directoryContactId: 'B', email: 'e' }, 0)).toBe('B');
    expect(outreachRecipientKey({ email: 'c@x' }, 0)).toBe('c@x');
    expect(outreachRecipientKey({ name: 'Dana' }, 0)).toBe('Dana');
    expect(outreachRecipientKey({}, 5)).toBe('idx-5');
  });
});

const ctx: TenantContext = {
  tenantId: 't1',
  tenantSlug: 'capiro',
  userId: 'u1',
  clerkUserId: 'c1',
  role: 'standard_user',
} as TenantContext;

/** Stub the withTenant tx surface submit() touches. */
function makeService(existingJobId: string | null) {
  const created: { job?: Record<string, unknown>; items?: unknown[] } = {};
  const service = Object.create(OutreachJobService.prototype) as OutreachJobService;
  const patch = service as unknown as Record<string, unknown>;
  patch.prisma = {
    withTenant: (_t: string, fn: (tx: unknown) => unknown) =>
      fn({
        outreachJob: {
          findFirst: async () => (existingJobId ? { id: existingJobId } : null),
          create: async ({ data }: { data: Record<string, unknown> }) => {
            created.job = data;
            return { id: 'new-job' };
          },
        },
        outreachJobItem: {
          createMany: async ({ data }: { data: unknown[] }) => {
            created.items = data;
            return { count: data.length };
          },
        },
      }),
  };
  return { service, created };
}

describe('OutreachJobService.submit idempotency (W4.2)', () => {
  test('a duplicate requestKey returns the existing job and inserts nothing', async () => {
    const { service, created } = makeService('existing-job');
    const out = await service.submit(ctx, {
      requestKey: 'rk-1',
      kind: 'generate',
      params: { templateId: 't' },
      recipients: [{ email: 'a@x' }],
    });
    expect(out).toEqual({ jobId: 'existing-job', deduped: true });
    expect(created.job).toBeUndefined();
    expect(created.items).toBeUndefined();
  });

  test('a fresh submit creates the job + one item per recipient with pinned id', async () => {
    const { service, created } = makeService(null);
    const out = await service.submit(ctx, {
      requestKey: 'rk-2',
      kind: 'generate',
      params: { templateId: 't' },
      recipients: [{ email: 'a@x' }, { email: 'b@x' }, { email: 'a@x' }], // dup collapsed
    });
    expect(out).toEqual({ jobId: 'new-job', deduped: false });
    expect(created.items).toHaveLength(2); // 3 recipients, dup 'a@x' collapsed
    const first = (created.items as Array<Record<string, unknown>>)[0]!;
    expect(first.recipientKey).toBe('a@x');
    // payload.id pinned to the recipientKey so the worker round-trips results.
    expect((first.payload as Record<string, unknown>).id).toBe('a@x');
  });
});

/**
 * Send at-most-once (W4.3): each item flips pending → 'sending' via a
 * status-guarded update BEFORE the Graph call; the outcome maps to sent/failed.
 * Stub the withSystem tx surface + engagement.sendBatchEmails; override sleep.
 */
function makeSendService(sendResult: { sent: number; errors: Array<{ message: string }> }) {
  const setCalls: Array<{ status: string; error: string | null }> = [];
  let claimGuardedByPending = false;
  const service = Object.create(OutreachJobService.prototype) as OutreachJobService;
  const patch = service as unknown as Record<string, unknown>;
  patch.logger = { warn: () => {}, error: () => {}, log: () => {} };
  patch.sleep = async () => {};
  patch.engagement = { sendBatchEmails: async () => sendResult };
  let pending = 1; // one item, pending → sent/failed
  patch.prisma = {
    withSystem: (fn: (tx: unknown) => unknown) =>
      fn({
        outreachJobItem: {
          findFirst: async () =>
            pending > 0
              ? {
                  id: 'item-1',
                  recipientKey: 'a@x',
                  payload: { subject: 's', body: 'b', email: 'a@x' },
                }
              : null,
          updateMany: async ({
            where,
            data,
          }: {
            where: Record<string, unknown>;
            data: Record<string, unknown>;
          }) => {
            // The flip must be guarded on status: 'pending' (at-most-once gate).
            if (where.status === 'pending' && data.status === 'sending') {
              claimGuardedByPending = true;
              pending = 0;
              return { count: 1 };
            }
            return { count: 0 };
          },
          update: async ({ data }: { data: { status: string; error?: string | null } }) => {
            setCalls.push({ status: data.status, error: data.error ?? null });
            return {};
          },
        },
      }),
  };
  const ctx: TenantContext = { tenantId: 't1', userId: 'u1' } as TenantContext;
  return {
    run: () =>
      (
        service as unknown as {
          processSendItems(j: string, c: TenantContext, p: object): Promise<void>;
        }
      ).processSendItems('job-1', ctx, {}),
    setCalls,
    guarded: () => claimGuardedByPending,
  };
}

describe('OutreachJobService send at-most-once (W4.3)', () => {
  test('a successful send flips via a pending-guarded claim, then marks sent', async () => {
    const h = makeSendService({ sent: 1, errors: [] });
    await h.run();
    expect(h.guarded()).toBe(true); // claim was guarded on status='pending'
    expect(h.setCalls).toEqual([{ status: 'sent', error: null }]);
  });

  test('a failed send marks the item failed with the error', async () => {
    const h = makeSendService({ sent: 0, errors: [{ message: 'graph 550' }] });
    await h.run();
    expect(h.setCalls).toEqual([{ status: 'failed', error: 'graph 550' }]);
  });
});

/**
 * Per-item retry (W4.4): a single FAILED generate item flips back to 'pending'
 * (error cleared) and a finalized job reopens to 'running' so the sweep re-runs it.
 * Non-generate jobs and non-failed items are refused.
 */
function makeRetryService(opts: {
  jobKind: string;
  jobStatus: string;
  itemStatus: string | null; // null = item not found
}) {
  const itemUpdates: Array<Record<string, unknown>> = [];
  const jobUpdates: Array<Record<string, unknown>> = [];
  const service = Object.create(OutreachJobService.prototype) as OutreachJobService;
  const patch = service as unknown as Record<string, unknown>;
  patch.prisma = {
    withTenant: (_t: string, fn: (tx: unknown) => unknown) =>
      fn({
        outreachJob: {
          findFirst: async () => ({ id: 'job-1', kind: opts.jobKind, status: opts.jobStatus }),
          update: async ({ data }: { data: Record<string, unknown> }) => {
            jobUpdates.push(data);
            return {};
          },
        },
        outreachJobItem: {
          findFirst: async () =>
            opts.itemStatus ? { id: 'item-1', status: opts.itemStatus } : null,
          update: async ({ data }: { data: Record<string, unknown> }) => {
            itemUpdates.push(data);
            return {};
          },
        },
      }),
  };
  const ctx: TenantContext = { tenantId: 't1', userId: 'u1' } as TenantContext;
  return {
    run: () => service.retryItem(ctx, 'job-1', 'item-1'),
    itemUpdates,
    jobUpdates,
  };
}

describe('OutreachJobService retryItem (W4.4)', () => {
  test('a failed generate item in a finalized job → item pending + job reopened', async () => {
    const h = makeRetryService({ jobKind: 'generate', jobStatus: 'partial', itemStatus: 'failed' });
    const res = await h.run();
    expect(res.retried).toBe(true);
    expect(h.itemUpdates).toEqual([{ status: 'pending', error: null }]);
    expect(h.jobUpdates).toEqual([{ status: 'running', finishedAt: null }]);
  });

  test('a still-running job is not reopened (only the item flips)', async () => {
    const h = makeRetryService({ jobKind: 'generate', jobStatus: 'running', itemStatus: 'failed' });
    const res = await h.run();
    expect(res.retried).toBe(true);
    expect(h.itemUpdates).toHaveLength(1);
    expect(h.jobUpdates).toHaveLength(0);
  });

  test('a send job is refused (at-most-once — never auto-resend)', async () => {
    const h = makeRetryService({ jobKind: 'send', jobStatus: 'partial', itemStatus: 'failed' });
    const res = await h.run();
    expect(res.retried).toBe(false);
    expect(res.reason).toMatch(/only generation/i);
    expect(h.itemUpdates).toHaveLength(0);
  });

  test('a non-failed item is refused', async () => {
    const h = makeRetryService({ jobKind: 'generate', jobStatus: 'partial', itemStatus: 'done' });
    const res = await h.run();
    expect(res.retried).toBe(false);
    expect(h.itemUpdates).toHaveLength(0);
  });
});
