import type { TenantContext } from '@capiro/shared';
import type { OutreachResolvedTargetRefV1 } from '../../capabilities/targets/outreach-target.contract.js';
import { createBlankCampaignSpecV1 } from '../state/outreach-campaign-spec.v1.js';
import { OutreachV3FullGenerationService } from './outreach-v3-full-generation.service.js';
import { buildOutreachV3GenerationPlan } from './outreach-v3-generation-plan.js';
import { createOutreachV3ReviewPacketApprovalSnapshot } from './outreach-v3-generation-approach.js';
import { buildOutreachV3FullGenerationJob } from './outreach-v3-full-generation-job.js';

/**
 * Server-truth recovery (section 8): the most recent full-generation job for
 * a session must be resolvable directly from the database, scoped to the
 * exact (tenantId, userId, kind, outreachRecordId) tuple used by every other
 * lookup in this service, ordered so the newest job always wins, and must
 * return null (not throw/404) when no job has ever existed — a legitimate,
 * distinct state from "the specific job you asked about is missing".
 *
 * The durable JSONB payload is re-validated on every read by the strict
 * `parseOutreachV3FullGenerationJob()` parser (schemaVersion, 64-hex hashes,
 * and a self-verifying jobKey digest of the base payload — see
 * outreach-v3-full-generation-job.ts). Fixtures here MUST build a genuinely
 * valid descriptor via the real `buildOutreachV3FullGenerationJob()`
 * builder rather than hand-rolled placeholder strings like "plan-hash",
 * or the parser will correctly reject them and every hash/items assertion
 * will silently read back null.
 */

const CTX = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  role: 'standard_user',
} as TenantContext;
const SESSION_ID = '33333333-3333-4333-8333-333333333333';

function target(): OutreachResolvedTargetRefV1 {
  return {
    targetKey: 'directory_member:alpha',
    locator: { source: 'directory_member', id: 'alpha' },
    displayName: 'Alpha',
    email: 'alpha@example.test',
    phone: null,
    title: 'Policy Director',
    organization: 'Office',
    clientId: null,
    jurisdiction: {
      governmentLevel: 'federal',
      chamber: 'house',
      state: 'VA',
      district: '01',
      committees: [],
      issueAreas: [],
    },
    roleStatus: 'current',
    emailStatus: 'available',
    profileStatus: 'complete',
    sourceSnapshot: { system: 'directory', version: '1', lastVerifiedAt: null },
    snapshotHash: 'a'.repeat(64),
  } as OutreachResolvedTargetRefV1;
}

function buildValidPlan() {
  const spec = createBlankCampaignSpecV1();
  spec.targeting.selectedTargetRefs = [target()];
  spec.delivery = { pattern: 'personalized_separate', personalization: 'high' };
  return buildOutreachV3GenerationPlan({
    sessionId: SESSION_ID,
    stateVersion: 5,
    specHash: 'b'.repeat(64),
    spec,
    readiness: {
      goalReady: true,
      sponsorResolved: true,
      targetCriteriaReady: true,
      targetsReady: true,
      deliveryReady: true,
      contextReady: true,
      contextEvidenceReady: true,
      strategyReady: true,
      sampleGenerationEligible: true,
      fullGenerationEligible: true,
      sendReviewEligible: false,
      blockers: [],
    } as any,
    pendingProposalCount: 0,
  });
}

function jobRow(overrides: Record<string, unknown> = {}) {
  const plan = buildValidPlan();
  const approval = createOutreachV3ReviewPacketApprovalSnapshot(plan);
  const descriptor = buildOutreachV3FullGenerationJob({
    plan,
    approachApproval: approval,
    completedGenerationKeys: [],
    pinned: {
      provider: 'openai',
      model: 'gpt-4.1',
      planModel: null,
      promptSpecVersion: 'v1',
      policyId: 'policy-1',
      policyVersion: '1',
    },
  });
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
  const service = new OutreachV3FullGenerationService(
    prisma as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
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

  it('never returns another tenant/user\'s job: relies on the same where-clause tuple as getJob', async () => {
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
  it('formats the job using the caller\'s open tx — does not open a nested transaction for job items', async () => {
    const h = harness();
    h.tx.outreachJob.findFirst.mockResolvedValue(jobRow());

    await h.service.getLatestJob(CTX, SESSION_ID);

    expect(h.prisma.withTenant).toHaveBeenCalledTimes(1);
    expect(h.tx.outreachJobItem.findMany).toHaveBeenCalledTimes(1);
  });

  it('getJob also formats using the caller\'s open tx — does not open a nested transaction', async () => {
    const h = harness();
    h.tx.outreachJob.findFirst.mockResolvedValue(jobRow());

    await h.service.getJob(CTX, SESSION_ID, jobRow().id);

    expect(h.prisma.withTenant).toHaveBeenCalledTimes(1);
    expect(h.tx.outreachJobItem.findMany).toHaveBeenCalledTimes(1);
  });
});
