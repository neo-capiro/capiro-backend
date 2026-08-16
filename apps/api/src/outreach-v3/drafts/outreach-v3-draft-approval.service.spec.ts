import type { TenantContext } from '@capiro/shared';
import type { OutreachResolvedTargetRefV1 } from '../../capabilities/targets/outreach-target.contract.js';
import { createBlankCampaignSpecV1 } from '../state/outreach-campaign-spec.v1.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import { buildOutreachV3GenerationPlan } from '../generation/outreach-v3-generation-plan.js';
import { OutreachV3DraftApprovalService } from './outreach-v3-draft-approval.service.js';

const CTX = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  role: 'standard_user',
} as TenantContext;
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const VERSION_ID = '44444444-4444-4444-8444-444444444444';
const ARTIFACT_ID = '55555555-5555-4555-8555-555555555555';
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

function current() {
  const spec = createBlankCampaignSpecV1();
  spec.targeting.selectedTargetRefs = [target()];
  spec.delivery = { pattern: 'personalized_separate', personalization: 'high' };
  return {
    session: { id: SESSION_ID, status: 'active', title: 'Test' },
    currentStateVersion: 6,
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
    currentVersion?: number;
    versionNumber?: number;
    auditStatus?: string;
    packetRef?: Record<string, unknown>;
  } = {},
) {
  const session = current();
  const plan = buildOutreachV3GenerationPlan({
    sessionId: SESSION_ID,
    stateVersion: session.currentStateVersion,
    specHash: session.specHash,
    spec: session.spec,
    readiness: session.readiness,
    pendingProposalCount: session.pendingProposalCount,
  });
  const generationKey = plan.slots[0]!.generationKey;
  const version = {
    id: VERSION_ID,
    artifactId: ARTIFACT_ID,
    outreachRecordId: SESSION_ID,
    version: options.versionNumber ?? 2,
    generationKey,
    contentHash: `sha256:${'c'.repeat(64)}`,
    generationStatus: 'generated',
    auditStatus: options.auditStatus ?? 'passed',
    approvalStatus: 'not_required',
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
        artifact: {
          currentVersion: options.currentVersion ?? 2,
          createdByUserId: CTX.userId,
        },
      }),
    },
    contextPacket: { findFirst: jest.fn().mockResolvedValue({ ref: packetRef }) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const prisma = {
    withTenant: jest
      .fn()
      .mockImplementation(async (_tenantId: string, fn: (value: any) => unknown) => fn(tx)),
  };
  const sessions = { getSession: jest.fn().mockResolvedValue(session) };
  const drafts = { getVersion: jest.fn().mockResolvedValue(version) };
  const event = {
    id: '77777777-7777-4777-8777-777777777777',
    sequence: BigInt(10),
  };
  const decisions = {
    append: jest.fn().mockResolvedValue({ event, idempotent: false }),
  };
  const service = new OutreachV3DraftApprovalService(
    sessions as any,
    drafts as any,
    prisma as any,
    decisions as any,
  );
  return { service, plan, version, tx, sessions, drafts, prisma, decisions, event };
}

describe('Outreach V3 exact draft approval persistence', () => {
  it('approves only the current immutable version and appends the exact approval hash', async () => {
    const h = harness();
    const result = await h.service.approve(CTX, SESSION_ID, VERSION_ID);
    expect(result.approval).toEqual(
      expect.objectContaining({
        sessionId: SESSION_ID,
        stateVersion: h.plan.stateVersion,
        planHash: h.plan.planHash,
        artifactId: ARTIFACT_ID,
        versionId: VERSION_ID,
        contentHash: h.version.contentHash,
      }),
    );
    expect(h.tx.outreachDraftVersion.findFirst).toHaveBeenCalled();
    expect(h.decisions.append).toHaveBeenCalledWith(
      CTX,
      SESSION_ID,
      expect.objectContaining({
        eventType: 'draft_version_approved',
        expectedStateVersion: h.plan.stateVersion,
        payloadHash: result.approval.approvalHash,
      }),
    );
  });

  it('rejects an older version when the artifact has moved forward', async () => {
    const h = harness({ currentVersion: 3, versionNumber: 2 });
    await expect(h.service.approve(CTX, SESSION_ID, VERSION_ID)).rejects.toMatchObject({
      code: 'OUTREACH_STATE_CONFLICT',
    });
    expect(h.decisions.append).not.toHaveBeenCalled();
  });

  it('rejects a version generated or edited under an older campaign plan', async () => {
    const h = harness({
      packetRef: {
        outreachV3SessionId: SESSION_ID,
        outreachV3StateVersion: '6',
        outreachV3SpecHash: 'b'.repeat(64),
        outreachV3PlanHash: 'f'.repeat(64),
      },
    });
    await expect(h.service.approve(CTX, SESSION_ID, VERSION_ID)).rejects.toMatchObject({
      code: 'OUTREACH_STATE_CONFLICT',
    });
    expect(h.decisions.append).not.toHaveBeenCalled();
  });

  it('rejects held audit instead of treating legacy not_required approval as author approval', async () => {
    const h = harness({ auditStatus: 'held' });
    await expect(h.service.approve(CTX, SESSION_ID, VERSION_ID)).rejects.toMatchObject({
      code: 'OUTREACH_COMMAND_BLOCKED',
    });
    expect(h.decisions.append).not.toHaveBeenCalled();
  });

  it('rejects a draft rooted in another campaign before any approval write', async () => {
    const h = harness();
    h.version.outreachRecordId = '88888888-8888-4888-8888-888888888888';
    await expect(h.service.approve(CTX, SESSION_ID, VERSION_ID)).rejects.toMatchObject({
      code: 'OUTREACH_REFERENCE_UNAUTHORIZED',
    });
    expect(h.decisions.append).not.toHaveBeenCalled();
  });
});
