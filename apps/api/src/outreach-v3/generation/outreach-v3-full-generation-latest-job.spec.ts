import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { OutreachV3FullGenerationService } from './outreach-v3-full-generation.service.js';

// Existing stored descriptor shape; no retired producer is needed to read it.
function historicalDescriptor() {
  const base = {
    schemaVersion: 'outreach_v3_full_generation_job_v1',
    sessionId: SESSION_ID,
    stateVersion: 5,
    specHash: 'a'.repeat(64),
    planHash: 'b'.repeat(64),
    approachApprovalHash: 'c'.repeat(64),
    pinned: {
      provider: 'openai',
      model: 'historical-model',
      planModel: null,
      promptSpecVersion: 'v1',
    },
    items: [{ generationKey: 'slot-a' }],
    batchSize: 10,
  };
  return { ...base, jobKey: createHash('sha256').update(JSON.stringify(base)).digest('hex') };
}

const CTX = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  role: 'standard_user',
} as TenantContext;
const SESSION_ID = '33333333-3333-4333-8333-333333333333';

function jobRow(overrides: Record<string, unknown> = {}) {
  const descriptor = historicalDescriptor();
  return {
    id: '44444444-4444-4444-8444-444444444444',
    status: 'running',
    totals: { queued: 1, succeeded: 2, failed: 0, skipped: 0, held: 0, total: 3 },
    requestKey: `${SESSION_ID}:hash`,
    params: {
      v3FullGeneration: descriptor,
    },
    startedAt: new Date('2026-08-23T12:00:00.000Z'),
    finishedAt: null,
    createdAt: new Date('2026-08-23T12:00:00.000Z'),
    ...overrides,
    // descriptor must survive shallow overrides of id/status without being clobbered
    __descriptor: descriptor,
  };
}

function harness() {
  const tx = {
    outreachJob: {
      findFirst: jest.fn(),
    },
    outreachJobItem: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const prisma = {
    withTenant: jest
      .fn()
      .mockImplementation(async (_tenantId: string, fn: (value: unknown) => unknown) => fn(tx)),
  };
  const service = new OutreachV3FullGenerationService(prisma as never);
  return { service, tx, prisma };
}

describe('OutreachV3FullGenerationService.getLatestJob', () => {
  it('returns null when no job has ever been created for the session (not a 404)', async () => {
    const h = harness();
    h.tx.outreachJob.findFirst.mockResolvedValue(null);

    const result = await h.service.getLatestJob(CTX, SESSION_ID);

    expect(result).toBeNull();
  });

  it('scopes the lookup to tenant, user, kind, and session, ordered newest-first', async () => {
    const h = harness();
    h.tx.outreachJob.findFirst.mockResolvedValue(jobRow());

    await h.service.getLatestJob(CTX, SESSION_ID);

    expect(h.tx.outreachJob.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: CTX.tenantId,
          userId: CTX.userId,
          kind: 'generate_v3',
          outreachRecordId: SESSION_ID,
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
  });

  it('shapes the response identically to getJob (id, status, totals, hashes, items)', async () => {
    const h = harness();
    const row = jobRow({ id: 'job-77', status: 'partial' });
    const descriptor = (row as any).__descriptor;
    const generationKey = descriptor.items[0].generationKey;
    h.tx.outreachJob.findFirst.mockResolvedValue(row);
    h.tx.outreachJobItem.findMany.mockResolvedValue([
      {
        id: 'item-1',
        recipientKey: generationKey,
        status: 'complete',
        result: {},
        error: null,
        attempt: 1,
      },
    ]);

    const result = await h.service.getLatestJob(CTX, SESSION_ID);

    expect(result).toMatchObject({
      id: 'job-77',
      sessionId: SESSION_ID,
      status: 'partial',
      planHash: descriptor.planHash,
      approachApprovalHash: descriptor.approachApprovalHash,
      items: [expect.objectContaining({ generationKey, status: 'complete' })],
    });
  });

  it('getJob (fetch-by-id) actually returns the formatted job, not a broken/renamed formatter (regression: formatJobBUGGED)', async () => {
    // getLatestJob() and getJob() must share the exact same formatting path
    // (`formatJob(tx, ...)`, using the CALLER's open transaction). A prior
    // defect had getJob() call a nonexistent `formatJobBUGGED` method,
    // which every mocked-transaction unit test missed because the mock
    // never distinguished "reuses the open tx" from "opens a fresh one" —
    // it would have thrown `TypeError: this.formatJobBUGGED is not a
    // function` on every real request. This test exercises getJob()'s
    // success path end-to-end so a regression fails loudly here instead of
    // only surfacing in `nest build` or production.
    const h = harness();
    const row = jobRow({ id: 'job-by-id-1', status: 'complete' });
    const descriptor = (row as any).__descriptor;
    const generationKey = descriptor.items[0].generationKey;
    h.tx.outreachJob.findFirst.mockResolvedValue(row);
    h.tx.outreachJobItem.findMany.mockResolvedValue([
      {
        id: 'item-1',
        recipientKey: generationKey,
        status: 'complete',
        result: {},
        error: null,
        attempt: 1,
      },
    ]);

    const result = await h.service.getJob(CTX, SESSION_ID, 'job-by-id-1');

    expect(result).toMatchObject({
      id: 'job-by-id-1',
      sessionId: SESSION_ID,
      status: 'complete',
      planHash: descriptor.planHash,
      approachApprovalHash: descriptor.approachApprovalHash,
      items: [expect.objectContaining({ generationKey, status: 'complete' })],
    });
  });

  it("never returns another tenant/user's job: relies on the same where-clause tuple as getJob", async () => {
    const h = harness();
    h.tx.outreachJob.findFirst.mockResolvedValue(null);

    await h.service.getLatestJob(CTX, SESSION_ID);
    const latestWhere = h.tx.outreachJob.findFirst.mock.calls[0]![0].where;

    h.tx.outreachJob.findFirst.mockResolvedValue(null);
    try {
      await h.service.getJob(CTX, SESSION_ID, 'some-job-id');
    } catch {
      // getJob throws NotFoundException when the row is null; we only care
      // about the where-clause shape it queried with.
    }
    const getJobWhere = h.tx.outreachJob.findFirst.mock.calls[1]![0].where;

    expect(latestWhere.tenantId).toBe(getJobWhere.tenantId);
    expect(latestWhere.userId).toBe(getJobWhere.userId);
    expect(latestWhere.kind).toBe(getJobWhere.kind);
    expect(latestWhere.outreachRecordId).toBe(getJobWhere.outreachRecordId);
  });

  /**
   * Regression: formatJob() must reuse the caller's already-open `tx`
   * handle for the job-items lookup rather than opening a SECOND
   * `prisma.withTenant(...)` transaction while the first is still open.
   * Nesting interactive transactions like that holds two connection-pool
   * slots for one logical request and, under load, can leave the outer
   * transaction idle past Prisma's interactive-transaction timeout —
   * exactly the "Transaction API error: Transaction not found" failure
   * mode seen in other services in this codebase (e.g. Fill with Meri's
   * background sweeps) once the inner transaction commits and recycles
   * the connection. `withTenant` must be called exactly once per
   * getJob/getLatestJob call, and the items lookup must run on the SAME
   * tx object the job row was read from.
   */
  it("formats the job using the caller's open tx — does not open a nested transaction for job items", async () => {
    const h = harness();
    h.tx.outreachJob.findFirst.mockResolvedValue(jobRow());

    await h.service.getLatestJob(CTX, SESSION_ID);

    expect(h.prisma.withTenant).toHaveBeenCalledTimes(1);
    expect(h.tx.outreachJobItem.findMany).toHaveBeenCalledTimes(1);
  });

  it("getJob also formats using the caller's open tx — does not open a nested transaction", async () => {
    const h = harness();
    h.tx.outreachJob.findFirst.mockResolvedValue(jobRow());

    await h.service.getJob(CTX, SESSION_ID, jobRow().id);

    expect(h.prisma.withTenant).toHaveBeenCalledTimes(1);
    expect(h.tx.outreachJobItem.findMany).toHaveBeenCalledTimes(1);
  });
});
