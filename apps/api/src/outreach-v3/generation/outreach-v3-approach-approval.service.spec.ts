import type { TenantContext } from '@capiro/shared';
import type { OutreachResolvedTargetRefV1 } from '../../capabilities/targets/outreach-target.contract.js';
import { createBlankCampaignSpecV1 } from '../state/outreach-campaign-spec.v1.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import { OutreachV3ApproachApprovalService } from './outreach-v3-approach-approval.service.js';
import { buildOutreachV3GenerationPlan } from './outreach-v3-generation-plan.js';

const CTX = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  role: 'standard_user',
} as TenantContext;
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const PACKET_ID = '66666666-6666-4666-8666-666666666666';

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

function current(status: 'active' | 'archived' = 'active') {
  const spec = createBlankCampaignSpecV1();
  spec.targeting.selectedTargetRefs = [target()];
  spec.delivery = { pattern: 'personalized_separate', personalization: 'high' };
  return {
    session: { id: SESSION_ID, status, title: 'Test' },
    currentStateVersion: 5,
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
      sampleGenerationEligible: false,
      fullGenerationEligible: false,
      sendReviewEligible: false,
      blockers: ['GENERATION_NOT_AVAILABLE', 'DRAFTS_NOT_AVAILABLE', 'PREFLIGHT_NOT_AVAILABLE'],
    },
    pendingProposalCount: 0,
  } as any;
}

function harness(
  options: {
    packetRef?: Record<string, unknown>;
    auditStatus?: string;
    status?: 'active' | 'archived';
  } = {},
) {
  const session = current(options.status);
  const plan = buildOutreachV3GenerationPlan({
    sessionId: SESSION_ID,
    stateVersion: session.currentStateVersion,
    specHash: session.specHash,
    spec: session.spec,
    readiness: session.readiness,
    pendingProposalCount: session.pendingProposalCount,
  });
  const generationKey = plan.representativeSampleKeys[0]!;
  const version = {
    id: '44444444-4444-4444-8444-444444444444',
    artifactId: '55555555-5555-4555-8555-555555555555',
    outreachRecordId: SESSION_ID,
    version: 1,
    generationKey,
    contentHash: `sha256:${'c'.repeat(64)}`,
    auditStatus: options.auditStatus ?? 'passed',
    generationStatus: 'generated',
    approvalStatus: 'not_required',
  };
  const sessions = { getSession: jest.fn().mockResolvedValue(session) };
  const drafts = {
    getVersion: jest.fn().mockResolvedValue(version),
    listForOutreach: jest.fn().mockResolvedValue([
      {
        id: version.artifactId,
        generationKey,
        current: { ...version },
      },
    ]),
  };
  const packetRef = options.packetRef ?? {
    outreachV3SessionId: SESSION_ID,
    outreachV3StateVersion: String(plan.stateVersion),
    outreachV3SpecHash: plan.specHash,
    outreachV3PlanHash: plan.planHash,
    generationKey,
  };
  const tx = {
    outreachDraftVersion: {
      findFirst: jest.fn().mockResolvedValue({
        contextPacketId: PACKET_ID,
        artifact: { createdByUserId: CTX.userId },
      }),
    },
    contextPacket: {
      findFirst: jest.fn().mockResolvedValue({ ref: packetRef }),
    },
  };
  const prisma = {
    withTenant: jest
      .fn()
      .mockImplementation(async (_tenantId: string, fn: (value: any) => unknown) => fn(tx)),
  };
  const event = {
    id: '77777777-7777-4777-8777-777777777777',
    sequence: BigInt(9),
    eventType: 'approach_approved',
    actorUserId: CTX.userId,
    source: 'user_control',
    stateVersionBefore: 5,
    stateVersionAfter: 5,
    commandBatchId: null,
    commandType: null,
    payloadHash: 'hash',
    safeMetadataJsonb: {},
    createdAt: new Date(),
  };
  const decisions = {
    append: jest.fn().mockResolvedValue({ event, idempotent: false }),
    latest: jest.fn().mockResolvedValue(null),
  };
  const service = new OutreachV3ApproachApprovalService(
    sessions as any,
    drafts as any,
    prisma as any,
    decisions as any,
  );
  return { service, plan, version, sessions, drafts, prisma, tx, decisions, event };
}

describe('Outreach V3 approach approval persistence', () => {
  it('pins approval to the persisted ContextPacket plan identity and appends one human decision', async () => {
    const h = harness();
    const result = await h.service.approve(CTX, SESSION_ID, [h.version.id]);
    expect(result.approval.planHash).toBe(h.plan.planHash);
    expect(result.approval.sampleVersions).toEqual([
      expect.objectContaining({
        versionId: h.version.id,
        artifactId: h.version.artifactId,
        generationKey: h.version.generationKey,
        contentHash: h.version.contentHash,
        planHash: h.plan.planHash,
      }),
    ]);
    expect(h.tx.outreachDraftVersion.findFirst).toHaveBeenCalled();
    expect(h.decisions.append).toHaveBeenCalledWith(
      CTX,
      SESSION_ID,
      expect.objectContaining({
        eventType: 'approach_approved',
        expectedStateVersion: h.plan.stateVersion,
        payloadHash: result.approval.approvalHash,
      }),
    );
  });

  it('rejects a sample whose persisted packet was produced by another plan', async () => {
    const h = harness({
      packetRef: {
        outreachV3SessionId: SESSION_ID,
        outreachV3StateVersion: '5',
        outreachV3SpecHash: 'b'.repeat(64),
        outreachV3PlanHash: 'f'.repeat(64),
      },
    });
    await expect(h.service.approve(CTX, SESSION_ID, [h.version.id])).rejects.toMatchObject({
      code: 'OUTREACH_STATE_CONFLICT',
    });
    expect(h.decisions.append).not.toHaveBeenCalled();
  });

  it('rejects held samples rather than writing an approval event', async () => {
    const h = harness({ auditStatus: 'held' });
    await expect(h.service.approve(CTX, SESSION_ID, [h.version.id])).rejects.toMatchObject({
      code: 'OUTREACH_COMMAND_BLOCKED',
    });
    expect(h.decisions.append).not.toHaveBeenCalled();
  });

  it('rejects archived campaigns before loading any draft version', async () => {
    const h = harness({ status: 'archived' });
    await expect(h.service.approve(CTX, SESSION_ID, [h.version.id])).rejects.toMatchObject({
      code: 'OUTREACH_SESSION_ARCHIVED',
    });
    expect(h.drafts.getVersion).not.toHaveBeenCalled();
  });

  it('invalidates a prior approach approval after a sample gains a newer current version', async () => {
    const h = harness();
    const approved = await h.service.approve(CTX, SESSION_ID, [h.version.id]);
    h.decisions.latest.mockResolvedValue({
      ...h.event,
      safeMetadataJsonb: { approval: approved.approval },
    });
    expect(await h.service.getCurrent(CTX, SESSION_ID, h.plan)).not.toBeNull();
    h.drafts.listForOutreach.mockResolvedValue([
      {
        id: h.version.artifactId,
        generationKey: h.version.generationKey,
        current: { ...h.version, id: '99999999-9999-4999-8999-999999999999' },
      },
    ]);
    expect(await h.service.getCurrent(CTX, SESSION_ID, h.plan)).toBeNull();
  });
});
