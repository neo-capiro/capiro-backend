// OutreachJobService (W4.2): pure job-rollup state machine, recipient keying,
// and idempotent submit. The multi-replica crash/exactly-once chaos test needs a
// real DB (deploy-verified per the plan); here we pin the logic that decides job
// status + the idempotency contract.

import { describe, expect, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { AudiencePolicyRequiredError } from './generation/government-affairs-policy.registry.js';
import {
  OutreachJobService,
  buildItemResult,
  classifyGenerationItem,
  computeJobRollup,
  outreachRecipientKey,
  readPinnedIdentity,
} from './outreach-job.service.js';

describe('computeJobRollup (W4.2)', () => {
  test('all pending → queued', () => {
    const r = computeJobRollup([{ status: 'pending' }, { status: 'pending' }]);
    expect(r.status).toBe('queued');
    expect(r.totals).toEqual({ queued: 2, succeeded: 0, failed: 0, skipped: 0, held: 0, total: 2 });
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
    expect(r.totals).toEqual({ queued: 0, succeeded: 2, failed: 1, skipped: 0, held: 0, total: 3 });
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
function makeService(
  existingJobId: string | null,
  opts: {
    gatewayEnabled?: boolean;
    pinned?: Record<string, unknown> | null;
    /** §e2 — resolvePolicy throws AudiencePolicyRequiredError instead of resolving. */
    audienceAmbiguous?: boolean;
  } = {},
) {
  const created: { job?: Record<string, unknown>; items?: unknown[] } = {};
  const lookups: Array<Record<string, unknown>> = [];
  const service = Object.create(OutreachJobService.prototype) as OutreachJobService;
  const patch = service as unknown as Record<string, unknown>;
  patch.versionedOutreach = false;
  // Phase 1 §3.k1: submit() resolves the provider/model identity ONCE through
  // the gateway before the transaction. With the gateway off it is never called.
  patch.logger = { warn: () => {}, error: () => {}, log: () => {} };
  patch.gateway = {
    enabled: opts.gatewayEnabled ?? false,
    resolvePolicy: () => {
      if (opts.audienceAmbiguous) {
        throw new AudiencePolicyRequiredError('The audience could not be determined.', [
          'congressional_office',
          'federal_agency',
        ]);
      }
      return { policyId: 'federal.congressional_office', version: 'ga-policy-v1' };
    },
    resolvePinnedIdentity: async () =>
      opts.pinned === null
        ? null
        : {
            creds: [],
            pinned: opts.pinned ?? {
              provider: 'anthropic',
              model: 'claude-sonnet-4-6',
              planModel: 'claude-haiku-4-5-20251001',
              promptSpecVersion: 'v2.2-gateway',
              policyId: 'federal.congressional_office',
              policyVersion: 'ga-policy-v1',
            },
          },
  };
  patch.prisma = {
    withTenant: (_t: string, fn: (tx: unknown) => unknown) =>
      fn({
        outreachJob: {
          findFirst: async ({ where }: { where: Record<string, unknown> }) => {
            lookups.push(where);
            return existingJobId ? { id: existingJobId } : null;
          },
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
  return { service, created, lookups };
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

// ── Phase 0 (plan §3.c3) ─────────────────────────────────────────────────────

describe('computeJobRollup — held is terminal and never "complete"', () => {
  test('all held → partial (nothing failed, but nothing is sendable either)', () => {
    const r = computeJobRollup([{ status: 'held' }, { status: 'held' }]);
    expect(r.status).toBe('partial');
    expect(r.totals.held).toBe(2);
    expect(r.totals.succeeded).toBe(0);
    expect(r.totals.failed).toBe(0);
  });

  test('done + held → partial, never complete', () => {
    expect(computeJobRollup([{ status: 'done' }, { status: 'held' }]).status).toBe('partial');
  });

  test('held counts as TERMINAL, so a job with only held items finalizes', () => {
    // If held were non-terminal the job would sit in 'running' forever.
    const r = computeJobRollup([{ status: 'held' }]);
    expect(['partial', 'complete', 'failed']).toContain(r.status);
  });

  test('held + failed (no successes) is partial — some drafts do exist', () => {
    expect(computeJobRollup([{ status: 'held' }, { status: 'failed' }]).status).toBe('partial');
  });
});

describe('classifyGenerationItem — fails closed', () => {
  test('the versioned lifecycle is authoritative', () => {
    expect(classifyGenerationItem({ versionId: 'v1', auditStatus: 'passed' })).toBe('done');
    expect(classifyGenerationItem({ versionId: 'v1', auditStatus: 'not_required' })).toBe('done');
    expect(classifyGenerationItem({ versionId: 'v1', auditStatus: 'warning' })).toBe('done');
    expect(classifyGenerationItem({ versionId: 'v1', auditStatus: 'held' })).toBe('held');
    expect(classifyGenerationItem({ versionId: 'v1', auditStatus: 'pending' })).toBe('held');
    expect(classifyGenerationItem({ versionId: 'v1', auditStatus: 'unavailable' })).toBe('held');
  });

  test('an outstanding or refused review is held, whatever the audit says', () => {
    expect(
      classifyGenerationItem({ versionId: 'v1', auditStatus: 'passed', approvalStatus: 'pending' }),
    ).toBe('held');
    expect(
      classifyGenerationItem({ versionId: 'v1', auditStatus: 'passed', approvalStatus: 'rejected' }),
    ).toBe('held');
  });

  test('a generation failure is failed even when version fields are present', () => {
    expect(
      classifyGenerationItem({ versionId: 'v1', generationStatus: 'generation_failed' }),
    ).toBe('failed');
  });

  test('the pre-Phase-0 shape still works', () => {
    expect(classifyGenerationItem({ status: 'ready' })).toBe('done');
    expect(classifyGenerationItem({ status: 'held' })).toBe('held');
    expect(classifyGenerationItem({ status: 'error' })).toBe('failed');
  });

  test('missing/garbage results are failed, never done', () => {
    expect(classifyGenerationItem(undefined)).toBe('failed');
    expect(classifyGenerationItem(null)).toBe('failed');
    expect(classifyGenerationItem('nope')).toBe('failed');
    expect(classifyGenerationItem({})).toBe('failed');
    expect(classifyGenerationItem({ versionId: 'v1', auditStatus: 'brand_new' })).toBe('failed');
  });
});

describe('buildItemResult — held content is preserved, internals are not', () => {
  test('keeps the real subject/body plus version metadata', () => {
    const out = buildItemResult({
      subject: 'Funding update',
      body: 'Real held content',
      versionId: 'v-1',
      artifactId: 'art-1',
      version: 2,
      auditStatus: 'held',
      approvalStatus: 'pending',
      reviewRequestId: 'rr-1',
      contextNote: 'Unverified — 1 finding',
    });
    expect(out).toMatchObject({
      subject: 'Funding update',
      body: 'Real held content',
      versionId: 'v-1',
      auditStatus: 'held',
      reviewRequestId: 'rr-1',
    });
  });

  test('drops anything not on the allowlist (no auditor internals reach the client)', () => {
    const out = buildItemResult({
      subject: 'S',
      body: 'B',
      error: 'Error: at Object.<anonymous> (/app/dist/auditor.js:1:1)',
      rawVerdict: { findings: [{ span: 'secret sentence' }] },
    })!;
    expect(out).not.toHaveProperty('error');
    expect(out).not.toHaveProperty('rawVerdict');
    expect(JSON.stringify(out)).not.toContain('secret sentence');
  });

  test('a non-object result yields null', () => {
    expect(buildItemResult(undefined)).toBeNull();
    expect(buildItemResult('x')).toBeNull();
  });
});

describe('per-USER job idempotency (§3.c3)', () => {
  test('the requestKey lookup is scoped by userId, not just tenantId', async () => {
    const { service, lookups } = makeService(null);
    await service.submit(ctx, {
      requestKey: 'rk-shared',
      kind: 'generate',
      params: {},
      recipients: [{ email: 'a@x' }],
    });
    expect(lookups[0]).toMatchObject({ tenantId: 't1', userId: 'u1', requestKey: 'rk-shared' });
  });

  test("two users' identical request keys do not collide", async () => {
    const a = makeService(null);
    await a.service.submit(ctx, {
      requestKey: 'rk-same',
      kind: 'generate',
      params: {},
      recipients: [{ email: 'a@x' }],
    });
    const b = makeService(null);
    const other = { ...ctx, userId: 'u2' } as TenantContext;
    await b.service.submit(other, {
      requestKey: 'rk-same',
      kind: 'generate',
      params: {},
      recipients: [{ email: 'b@x' }],
    });
    expect(a.lookups[0]!.userId).toBe('u1');
    expect(b.lookups[0]!.userId).toBe('u2');
    // Both created their OWN job; neither deduped onto the other's.
    expect(a.created.job).toBeDefined();
    expect(b.created.job).toBeDefined();
  });
});

describe('legacy async SEND is refused under versioned outreach (§3.c3)', () => {
  test('kind=send is rejected when ENGAGEMENT_VERSIONED_OUTREACH is on', async () => {
    const { service } = makeService(null);
    (service as unknown as Record<string, unknown>).versionedOutreach = true;
    await expect(
      service.submit(ctx, {
        requestKey: 'rk-send',
        kind: 'send',
        params: {},
        recipients: [{ email: 'a@x' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test('kind=generate is unaffected by that flag', async () => {
    const { service } = makeService(null);
    (service as unknown as Record<string, unknown>).versionedOutreach = true;
    await expect(
      service.submit(ctx, {
        requestKey: 'rk-gen',
        kind: 'generate',
        params: {},
        recipients: [{ email: 'a@x' }],
      }),
    ).resolves.toMatchObject({ deduped: false });
  });
});

/** getJob / retryItem / cancelJob must all be owner-scoped, not tenant-scoped. */
function makeOwnershipService(opts: { jobUserId: string; itemStatus?: string }) {
  const wheres: Array<Record<string, unknown>> = [];
  const service = Object.create(OutreachJobService.prototype) as OutreachJobService;
  const patch = service as unknown as Record<string, unknown>;
  patch.versionedOutreach = false;
  patch.prisma = {
    withTenant: (_t: string, fn: (tx: unknown) => unknown) =>
      fn({
        outreachJob: {
          findFirst: async ({ where }: { where: Record<string, unknown> }) => {
            wheres.push(where);
            // Faithful to Prisma: a userId predicate that does not match → null.
            if ('userId' in where && where.userId !== opts.jobUserId) return null;
            return { id: 'job-1', kind: 'generate', status: 'partial', userId: opts.jobUserId };
          },
          update: async () => ({}),
          updateMany: async () => ({ count: 1 }),
        },
        outreachJobItem: {
          findFirst: async () => ({ id: 'item-1', status: opts.itemStatus ?? 'failed' }),
          findMany: async () => [],
          update: async () => ({}),
          updateMany: async () => ({ count: 0 }),
        },
      }),
  };
  return { service, wheres };
}

describe('job ownership (§3.c3): user A cannot touch user B\'s job', () => {
  const userB = { ...ctx, userId: 'u2' } as TenantContext;

  test('getJob returns null for a foreign job (no existence leak)', async () => {
    const { service, wheres } = makeOwnershipService({ jobUserId: 'u1' });
    expect(await service.getJob(userB, 'job-1')).toBeNull();
    expect(wheres[0]).toMatchObject({ userId: 'u2' });
    // The owner still sees it.
    const own = makeOwnershipService({ jobUserId: 'u1' });
    expect(await own.service.getJob(ctx, 'job-1')).not.toBeNull();
  });

  test('retryItem refuses a foreign job', async () => {
    const { service } = makeOwnershipService({ jobUserId: 'u1' });
    const res = await service.retryItem(userB, 'job-1', 'item-1');
    expect(res.retried).toBe(false);
    expect(res.reason).toMatch(/not found/i);
  });

  test('cancelJob refuses a foreign job', async () => {
    const { service } = makeOwnershipService({ jobUserId: 'u1' });
    expect(await service.cancelJob(userB, 'job-1')).toEqual({ canceled: false });
  });

  test('a HELD item is not retryable — it needs review or a new version', async () => {
    const { service } = makeOwnershipService({ jobUserId: 'u1', itemStatus: 'held' });
    const res = await service.retryItem(ctx, 'job-1', 'item-1');
    expect(res.retried).toBe(false);
    expect(res.reason).toMatch(/held for review/i);
  });
});

describe('cancel is terminal (§3.c3)', () => {
  test('finalizeJob cannot overwrite a canceled job', async () => {
    const calls: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
    const service = Object.create(OutreachJobService.prototype) as OutreachJobService;
    const patch = service as unknown as Record<string, unknown>;
    patch.prisma = {
      withSystem: (fn: (tx: unknown) => unknown) =>
        fn({
          outreachJobItem: { findMany: async () => [{ status: 'done' }] },
          outreachJob: {
            updateMany: async (a: {
              where: Record<string, unknown>;
              data: Record<string, unknown>;
            }) => {
              calls.push(a);
              return { count: 0 }; // the guard matched nothing: job IS canceled
            },
          },
        }),
    };
    await (service as unknown as { finalizeJob(id: string): Promise<void> }).finalizeJob('job-1');
    expect(calls).toHaveLength(1);
    // The write is guarded so a canceled job is never rolled forward.
    expect(calls[0]!.where).toMatchObject({ status: { not: 'canceled' } });
  });
});

// ── Phase 1 §3.k — provider/model pinned at submit, honored by every chunk ────

describe('async provider/model pinning (Phase 1 §3.k)', () => {
  const recipients = [{ email: 'a@mail.house.gov' }, { email: 'b@mail.house.gov' }];

  test('with the gateway ON, submit stores the pinned identity in job params', async () => {
    const { service, created } = makeService(null, { gatewayEnabled: true });
    await service.submit(ctx, {
      requestKey: 'rk-pin',
      kind: 'generate',
      params: { templateId: 'meeting_request', clientId: 'c1' },
      recipients,
    });
    const pinned = (created.job?.params as Record<string, unknown>).pinnedIdentity as Record<
      string,
      unknown
    >;
    expect(pinned).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      promptSpecVersion: 'v2.2-gateway',
    });
  });

  test('with the gateway OFF, no identity is pinned (flag-off path unchanged)', async () => {
    const { service, created } = makeService(null, { gatewayEnabled: false });
    await service.submit(ctx, {
      requestKey: 'rk-nopin',
      kind: 'generate',
      params: { templateId: 'meeting_request' },
      recipients,
    });
    expect((created.job?.params as Record<string, unknown>).pinnedIdentity).toBeUndefined();
  });

  test('a SEND job is never pinned — it drafts nothing', async () => {
    const { service, created } = makeService(null, { gatewayEnabled: true });
    await service.submit(ctx, {
      requestKey: 'rk-send',
      kind: 'send',
      params: { senderConnectionId: 'conn-1' },
      recipients,
    });
    expect((created.job?.params as Record<string, unknown>).pinnedIdentity).toBeUndefined();
  });

  // §e1 — a pinning failure under the gateway used to degrade to an unpinned
  // job (per-chunk resolution, today's behavior); it now REJECTS the whole
  // submission before any job or item row exists, because an unpinned job is
  // exactly the mid-campaign voice split the pin exists to prevent.
  test('with the gateway ON, no available credential REJECTS the submission — no job is created (§e1)', async () => {
    const { service, created } = makeService(null, { gatewayEnabled: true, pinned: null });
    await expect(
      service.submit(ctx, {
        requestKey: 'rk-nocreds',
        kind: 'generate',
        params: { templateId: 'meeting_request' },
        recipients,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(created.job).toBeUndefined();
    expect(created.items).toBeUndefined();
  });

  // §e2 — an ambiguous audience is a submission failure, not something the
  // (now-mandatory) pin can defer to "the per-chunk resolution will raise it
  // later" — there is no per-chunk resolution once pinning is mandatory.
  test('with the gateway ON, an ambiguous audience REJECTS the submission — no job is created (§e2)', async () => {
    const { service, created } = makeService(null, { gatewayEnabled: true, audienceAmbiguous: true });
    let caught: unknown;
    try {
      await service.submit(ctx, {
        requestKey: 'rk-ambiguous',
        kind: 'generate',
        params: { templateId: 'meeting_request' },
        recipients,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    const body = (caught as BadRequestException).getResponse() as Record<string, unknown>;
    expect(body.error).toBe('AUDIENCE_POLICY_REQUIRED');
    expect(created.job).toBeUndefined();
    expect(created.items).toBeUndefined();
  });

  test('the gateway OFF path never resolves policy, so an ambiguous audience is irrelevant', async () => {
    const { service, created } = makeService(null, {
      gatewayEnabled: false,
      audienceAmbiguous: true,
    });
    await expect(
      service.submit(ctx, {
        requestKey: 'rk-flag-off',
        kind: 'generate',
        params: { templateId: 'meeting_request' },
        recipients,
      }),
    ).resolves.toMatchObject({ deduped: false });
    expect(created.job).toBeDefined();
  });
});

describe('readPinnedIdentity (Phase 1 §3.k3)', () => {
  const valid = {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    planModel: 'claude-haiku-4-5-20251001',
    promptSpecVersion: 'v2.2-gateway',
    policyId: 'federal.congressional_office',
    policyVersion: 'ga-policy-v1',
  };

  test('round-trips a well-formed identity', () => {
    expect(readPinnedIdentity({ pinnedIdentity: valid })).toMatchObject(valid);
  });

  test('absent params yield null (per-chunk resolution, the pre-Phase-1 behavior)', () => {
    expect(readPinnedIdentity({})).toBeNull();
  });

  test('a HALF-formed identity degrades to null rather than pinning nothing silently', () => {
    // params is JSONB; a hand-edited or partially-written row must not produce an
    // identity with an empty model that would then be sent to the provider.
    expect(readPinnedIdentity({ pinnedIdentity: { provider: 'anthropic' } })).toBeNull();
    expect(readPinnedIdentity({ pinnedIdentity: { ...valid, model: '' } })).toBeNull();
    expect(readPinnedIdentity({ pinnedIdentity: { ...valid, promptSpecVersion: 42 } })).toBeNull();
  });

  test('a non-object value is rejected', () => {
    expect(readPinnedIdentity({ pinnedIdentity: 'anthropic' })).toBeNull();
    expect(readPinnedIdentity({ pinnedIdentity: ['a'] })).toBeNull();
    expect(readPinnedIdentity({ pinnedIdentity: null })).toBeNull();
  });
});

describe('the job item result keeps the Context Used manifest (§3.k4)', () => {
  test('manifest is on the persisted-field allowlist', () => {
    const out = buildItemResult({
      subject: 's',
      body: 'b',
      versionId: 'v1',
      manifest: { contextPacketId: 'pkt-1', promptSpecVersion: 'v2.2-gateway' },
      // Not on the allowlist — must not leak into the column.
      error: 'RAW PROVIDER STACK',
    });
    expect((out?.manifest as { contextPacketId: string }).contextPacketId).toBe('pkt-1');
    expect(out).not.toHaveProperty('error');
  });
});

describe('the job item result preserves candidate status (§e4)', () => {
  test('isCandidate + baseVersion survive the allowlist', () => {
    const out = buildItemResult({
      subject: 's',
      body: 'b',
      versionId: 'v-2',
      artifactId: 'art-1',
      version: 2,
      auditStatus: 'passed',
      approvalStatus: 'not_required',
      isCandidate: true,
      baseVersion: 1,
    });
    expect(out).toMatchObject({ isCandidate: true, baseVersion: 1 });
  });

  test('a normal (non-candidate) result carries neither field', () => {
    const out = buildItemResult({ subject: 's', body: 'b', versionId: 'v-1' });
    expect(out).not.toHaveProperty('isCandidate');
    expect(out).not.toHaveProperty('baseVersion');
  });
});
