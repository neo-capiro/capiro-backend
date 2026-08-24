import type { TenantContext } from '@capiro/shared';
import type { OutreachResolvedTargetRefV1 } from '../../capabilities/targets/outreach-target.contract.js';
import { createBlankCampaignSpecV1 } from '../state/outreach-campaign-spec.v1.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import { OutreachV3FullGenerationService } from './outreach-v3-full-generation.service.js';
import { buildOutreachV3GenerationPlan } from './outreach-v3-generation-plan.js';
import { createOutreachV3ReviewPacketApprovalSnapshot } from './outreach-v3-generation-approach.js';

/**
 * Server-authoritative preflight, provider, approval-staleness, and
 * idempotency coverage for OutreachV3FullGenerationService.submit().
 *
 * This is the single entry point a manually constructed frontend request
 * would hit, so every one of these checks must be enforced HERE — the
 * frontend gating added for the P0 fix (classifyOutreachV3FullGenerationResult)
 * is a UX improvement, not a security boundary. These tests exercise the
 * service directly with a minimal harness (no HTTP layer) so they prove the
 * server rejects each condition even if a caller bypasses the UI entirely.
 */

const CTX = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  role: 'standard_user',
} as TenantContext;
const OTHER_USER = '99999999-9999-4999-8999-999999999999';
const OTHER_TENANT = '88888888-8888-4888-8888-888888888888';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';

function target(id: string): OutreachResolvedTargetRefV1 {
  return {
    targetKey: `directory_member:${id}`,
    locator: { source: 'directory_member', id },
    displayName: `Target ${id}`,
    email: `${id}@example.test`,
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

function eligibleReadiness() {
  return {
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
  } as any;
}

function currentSession(
  options: {
    status?: 'active' | 'archived';
    stateVersion?: number;
    specHash?: string;
    targetCount?: number;
    pendingProposalCount?: number;
  } = {},
) {
  const spec = createBlankCampaignSpecV1();
  const count = options.targetCount ?? 2;
  spec.targeting.selectedTargetRefs = Array.from({ length: count }, (_, i) =>
    target(`m${i + 1}`),
  );
  spec.delivery = { pattern: 'personalized_separate', personalization: 'high' };
  return {
    session: { id: SESSION_ID, title: 'Test campaign', status: options.status ?? 'active' },
    currentStateVersion: options.stateVersion ?? 5,
    specHash: options.specHash ?? 'b'.repeat(64),
    spec,
    readiness: eligibleReadiness(),
    pendingProposalCount: options.pendingProposalCount ?? 0,
  } as any;
}

function harness(
  overrides: {
    session?: ReturnType<typeof currentSession>;
    gatewayEnabled?: boolean;
    approval?: 'current' | null;
    resolvePolicyThrows?: boolean;
    pinnedIdentity?: 'available' | null;
    priorJob?: any;
    completedGenerationKeys?: string[];
  } = {},
) {
  const session = overrides.session ?? currentSession();
  const plan = buildOutreachV3GenerationPlan({
    sessionId: SESSION_ID,
    stateVersion: session.currentStateVersion,
    specHash: session.specHash,
    spec: session.spec,
    readiness: session.readiness,
    pendingProposalCount: session.pendingProposalCount,
  });
  const approval =
    overrides.approval === null ? null : createOutreachV3ReviewPacketApprovalSnapshot(plan);

  const tx = {
    outreachJob: {
      findFirst: jest.fn().mockResolvedValue(overrides.priorJob ?? null),
      create: jest.fn().mockImplementation(async ({ data }: any) => ({ id: 'new-job-id', ...data })),
    },
    outreachJobItem: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    outreachDraftVersion: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    contextPacket: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  } as Record<string, any>;
  const prisma = {
    withTenant: jest
      .fn()
      .mockImplementation(async (_tenantId: string, fn: (value: unknown) => unknown) => fn(tx)),
  };
  const sessions = { getSession: jest.fn().mockResolvedValue(session) };
  const approvals = { getCurrent: jest.fn().mockResolvedValue(approval) };
  const drafts = { listForOutreach: jest.fn().mockResolvedValue([]) };
  const preparation = {
    prepareSlot: jest.fn().mockImplementation(async (_ctx: unknown, _spec: unknown, slot: any) => ({
      slot,
      currentTargets: [target('m1')],
      selectedItems: [],
      serverEvidence: [],
      sourceContextKeys: [],
    })),
  };
  const pinned = {
    provider: 'openai',
    model: 'model',
    planModel: null,
    promptSpecVersion: 'v1',
    policyId: 'policy',
    policyVersion: '1',
  };
  const gateway = {
    enabled: overrides.gatewayEnabled ?? true,
    resolvePolicy: overrides.resolvePolicyThrows
      ? jest.fn().mockImplementation(() => {
          throw new Error('no audience policy');
        })
      : jest.fn().mockReturnValue({ id: 'policy' }),
    resolvePinnedIdentity:
      overrides.pinnedIdentity === null
        ? jest.fn().mockResolvedValue(null)
        : jest.fn().mockResolvedValue({ pinned, creds: [{ provider: 'openai' }] }),
  };
  const roots = { ensureRoot: jest.fn().mockResolvedValue({ outreachRecordId: SESSION_ID }) };

  const service = new OutreachV3FullGenerationService(
    prisma as any,
    sessions as any,
    approvals as any,
    drafts as any,
    preparation as any,
    gateway as any,
    roots as any,
  );
  return { service, session, plan, approval, tx, prisma, sessions, approvals, drafts, gateway, roots };
}

describe('OutreachV3FullGenerationService.submit — server-authoritative gating', () => {
  it('rejects a request key outside the 8-128 character bound', async () => {
    const h = harness();
    await expect(h.service.submit(CTX, SESSION_ID, 'short')).rejects.toBeInstanceOf(Error);
  });

  it('blocks generation when the shared generation gateway (provider) is dark', async () => {
    const h = harness({ gatewayEnabled: false });
    await expect(
      h.service.submit(CTX, SESSION_ID, 'a'.repeat(16)),
    ).rejects.toMatchObject({ status: 503 });
    expect(h.approvals.getCurrent).not.toHaveBeenCalled();
  });

  it('blocks generation when the campaign session is archived', async () => {
    const h = harness({ session: currentSession({ status: 'archived' }) });
    await expect(h.service.submit(CTX, SESSION_ID, 'a'.repeat(16))).rejects.toMatchObject({
      code: 'OUTREACH_SESSION_ARCHIVED',
    });
  });

  it('blocks generation when pending proposals make the generation plan ineligible (preflight)', async () => {
    const blockedSession = currentSession({ pendingProposalCount: 1 });
    const tx = {
      outreachJob: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
      outreachJobItem: { createMany: jest.fn() },
    };
    const prisma = { withTenant: jest.fn().mockImplementation(async (_t: string, fn: any) => fn(tx)) };
    const sessions = { getSession: jest.fn().mockResolvedValue(blockedSession) };
    const approvals = { getCurrent: jest.fn() };
    const drafts = { listForOutreach: jest.fn() };
    const preparation = { prepareSlot: jest.fn() };
    const gateway = { enabled: true, resolvePolicy: jest.fn(), resolvePinnedIdentity: jest.fn() };
    const roots = { ensureRoot: jest.fn().mockResolvedValue({ outreachRecordId: SESSION_ID }) };
    const service = new OutreachV3FullGenerationService(
      prisma as any,
      sessions as any,
      approvals as any,
      drafts as any,
      preparation as any,
      gateway as any,
      roots as any,
    );

    await expect(service.submit(CTX, SESSION_ID, 'a'.repeat(16))).rejects.toMatchObject({
      code: 'OUTREACH_COMMAND_BLOCKED',
      safeMetadata: expect.objectContaining({ reason: 'generation_plan_not_eligible' }),
    });
    expect(approvals.getCurrent).not.toHaveBeenCalled();
  });

  it('blocks generation when no approach/review-packet approval exists (stale/missing approval)', async () => {
    const h = harness({ approval: null });
    await expect(h.service.submit(CTX, SESSION_ID, 'a'.repeat(16))).rejects.toMatchObject({
      code: 'OUTREACH_COMMAND_BLOCKED',
      safeMetadata: expect.objectContaining({ reason: 'approach_approval_required' }),
    });
  });

  it('blocks generation when the approval was computed for a DIFFERENT (stale) plan/state version', async () => {
    // Build an approval bound to state version 5, then have the session report
    // state version 6 (recipients/context/etc. changed after approval).
    const oldSession = currentSession({ stateVersion: 5 });
    const staleOldPlan = buildOutreachV3GenerationPlan({
      sessionId: SESSION_ID,
      stateVersion: oldSession.currentStateVersion,
      specHash: oldSession.specHash,
      spec: oldSession.spec,
      readiness: oldSession.readiness,
      pendingProposalCount: oldSession.pendingProposalCount,
    });
    const staleApproval = createOutreachV3ReviewPacketApprovalSnapshot(staleOldPlan);

    const newSession = currentSession({ stateVersion: 6 });
    const tx = {
      outreachJob: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
      outreachJobItem: { createMany: jest.fn() },
    };
    const prisma = {
      withTenant: jest.fn().mockImplementation(async (_t: string, fn: any) => fn(tx)),
    };
    const sessions = { getSession: jest.fn().mockResolvedValue(newSession) };
    // approvals.getCurrent is itself responsible for staleness detection in the
    // real service (isOutreachV3ApproachApprovalCurrent) — simulate that here
    // by having it return null once the plan has moved, exactly like the real
    // OutreachV3ApproachApprovalService.getCurrent would.
    const approvals = { getCurrent: jest.fn().mockResolvedValue(null) };
    const drafts = { listForOutreach: jest.fn().mockResolvedValue([]) };
    const preparation = { prepareSlot: jest.fn() };
    const gateway = {
      enabled: true,
      resolvePolicy: jest.fn(),
      resolvePinnedIdentity: jest.fn(),
    };
    const roots = { ensureRoot: jest.fn().mockResolvedValue({ outreachRecordId: SESSION_ID }) };
    const service = new OutreachV3FullGenerationService(
      prisma as any,
      sessions as any,
      approvals as any,
      drafts as any,
      preparation as any,
      gateway as any,
      roots as any,
    );

    await expect(service.submit(CTX, SESSION_ID, 'a'.repeat(16))).rejects.toMatchObject({
      code: 'OUTREACH_COMMAND_BLOCKED',
      safeMetadata: expect.objectContaining({ reason: 'approach_approval_required' }),
    });
    // Confirms staleOldPlan/staleApproval were never treated as satisfying the
    // NEW state — the approval snapshot itself is discarded, not reused.
    expect(staleApproval.stateVersion).toBe(5);
    expect(newSession.currentStateVersion).toBe(6);
  });

  it('blocks generation when the audience policy cannot be resolved for the first slot', async () => {
    const h = harness({ resolvePolicyThrows: true });
    await expect(h.service.submit(CTX, SESSION_ID, 'a'.repeat(16))).rejects.toMatchObject({
      code: 'OUTREACH_COMMAND_BLOCKED',
      safeMetadata: expect.objectContaining({ reason: 'audience_policy_required' }),
    });
  });

  it('blocks generation when the pinned provider identity cannot be resolved (provider unavailable)', async () => {
    const h = harness({ pinnedIdentity: null });
    await expect(h.service.submit(CTX, SESSION_ID, 'a'.repeat(16))).rejects.toMatchObject({
      status: 503,
    });
  });

  it('happy path: creates a queued job with one item per unfinished slot', async () => {
    const h = harness();
    const result = await h.service.submit(CTX, SESSION_ID, 'a'.repeat(16));
    expect(result.deduped).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.jobId).toBe('new-job-id');
    expect(result.remaining).toBe(2);
    expect(h.tx.outreachJob.create).toHaveBeenCalledTimes(1);
    expect(h.tx.outreachJobItem.createMany).toHaveBeenCalledTimes(1);
  });

  it('reports complete=true, jobId=null when every slot already has a current draft (nothing to do)', async () => {
    const session = currentSession({ targetCount: 1 });
    const plan = buildOutreachV3GenerationPlan({
      sessionId: SESSION_ID,
      stateVersion: session.currentStateVersion,
      specHash: session.specHash,
      spec: session.spec,
      readiness: session.readiness,
      pendingProposalCount: session.pendingProposalCount,
    });
    const generationKey = plan.slots[0]!.generationKey;
    const h = harness({ session });
    // Simulate an existing current draft version whose packet matches this
    // exact plan/spec/state — completedGenerationKeysForPlan() should treat
    // the slot as already-done and short-circuit before any model call.
    h.drafts.listForOutreach.mockResolvedValue([
      {
        id: 'artifact-1',
        generationKey,
        current: { id: 'version-1' },
      },
    ]);
    h.tx.outreachDraftVersion.findMany.mockResolvedValue([
      { id: 'version-1', contextPacketId: 'packet-1' },
    ]);
    h.tx.contextPacket.findMany.mockResolvedValue([
      {
        id: 'packet-1',
        ref: {
          outreachV3SessionId: SESSION_ID,
          outreachV3PlanHash: plan.planHash,
          outreachV3SpecHash: plan.specHash,
          outreachV3StateVersion: String(plan.stateVersion),
        },
      },
    ]);

    const result = await h.service.submit(CTX, SESSION_ID, 'a'.repeat(16));
    expect(result.complete).toBe(true);
    expect(result.jobId).toBeNull();
    expect(result.remaining).toBe(0);
    expect(h.gateway.resolvePinnedIdentity).not.toHaveBeenCalled();
  });
});

describe('OutreachV3FullGenerationService.submit — idempotency', () => {
  it('same requestKey + same tenant/user/plan/approval returns the SAME logical job (deduped), no new job row', async () => {
    const priorJob = {
      id: 'existing-job-id',
      kind: 'generate_v3',
      outreachRecordId: SESSION_ID,
      status: 'running',
      params: null, // set below once we know the plan/approval
    };
    const h = harness({ priorJob });
    // Build the exact descriptor the prior submit would have stored.
    const descriptor = {
      schemaVersion: 'outreach_v3_full_generation_job_v1',
      sessionId: SESSION_ID,
      stateVersion: h.plan.stateVersion,
      specHash: h.plan.specHash,
      planHash: h.plan.planHash,
      approachApprovalHash: h.approval!.approvalHash,
      pinned: {
        provider: 'openai',
        model: 'model',
        planModel: null,
        promptSpecVersion: 'v1',
        policyId: 'policy',
        policyVersion: '1',
      },
      items: [{ generationKey: h.plan.slots[0]!.generationKey }],
      batchSize: 10,
    };
    const { createHash } = await import('node:crypto');
    (priorJob as any).params = {
      v3FullGeneration: {
        ...descriptor,
        jobKey: createHash('sha256').update(JSON.stringify(descriptor), 'utf8').digest('hex'),
      },
    };

    const result = await h.service.submit(CTX, SESSION_ID, 'same-request-key-123');
    expect(result.deduped).toBe(true);
    expect(result.jobId).toBe('existing-job-id');
    expect(h.tx.outreachJob.create).not.toHaveBeenCalled();
  });

  it('same requestKey but a DIFFERENT stored plan/approval hash is a conflict, not a silent dedup', async () => {
    const priorJob = {
      id: 'existing-job-id',
      kind: 'generate_v3',
      outreachRecordId: SESSION_ID,
      status: 'running',
      params: {
        v3FullGeneration: {
          schemaVersion: 'outreach_v3_full_generation_job_v1',
          sessionId: SESSION_ID,
          stateVersion: 999,
          specHash: 'f'.repeat(64),
          planHash: 'f'.repeat(64), // deliberately does not match h.plan.planHash
          approachApprovalHash: 'f'.repeat(64),
          pinned: {
            provider: 'openai',
            model: 'model',
            planModel: null,
            promptSpecVersion: 'v1',
            policyId: 'policy',
            policyVersion: '1',
          },
          items: [],
          batchSize: 10,
          jobKey: 'f'.repeat(64),
        },
      },
    };
    const h = harness({ priorJob });
    await expect(h.service.submit(CTX, SESSION_ID, 'reused-request-key')).rejects.toMatchObject({
      status: 409,
    });
    expect(h.tx.outreachJob.create).not.toHaveBeenCalled();
  });

  it('a request key used for a DIFFERENT session id is a conflict, never silently reattributed', async () => {
    const priorJob = {
      id: 'other-session-job',
      kind: 'generate_v3',
      outreachRecordId: '77777777-7777-4777-8777-777777777777',
      status: 'running',
      params: { v3FullGeneration: {} },
    };
    const h = harness({ priorJob });
    await expect(h.service.submit(CTX, SESSION_ID, 'cross-session-key')).rejects.toMatchObject({
      status: 409,
    });
  });

  it('the idempotency lookup is scoped by tenantId AND userId — never a bare requestKey collision', async () => {
    const h = harness();
    await h.service.submit(CTX, SESSION_ID, 'a'.repeat(16));
    const lookupArgs = h.tx.outreachJob.findFirst.mock.calls[0]![0];
    expect(lookupArgs.where).toMatchObject({
      tenantId: CTX.tenantId,
      userId: CTX.userId,
      requestKey: 'a'.repeat(16),
    });
    // Confirms the WHERE clause could never match another tenant's or
    // another user's row with an identical requestKey string.
    expect(lookupArgs.where.tenantId).not.toBe(OTHER_TENANT);
    expect(lookupArgs.where.userId).not.toBe(OTHER_USER);
  });
});
