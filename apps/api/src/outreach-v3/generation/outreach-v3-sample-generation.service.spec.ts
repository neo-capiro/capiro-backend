import type { TenantContext } from '@capiro/shared';
import { createBlankCampaignSpecV1 } from '../state/outreach-campaign-spec.v1.js';
import type { OutreachResolvedTargetRefV1 } from '../../capabilities/targets/outreach-target.contract.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import { OutreachV3SampleGenerationService } from './outreach-v3-sample-generation.service.js';

const CTX = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  role: 'standard_user',
} as TenantContext;
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const PLAN_SPEC_HASH = 'a'.repeat(64);

function target(index: number): OutreachResolvedTargetRefV1 {
  const id = `target-${index}`;
  return {
    targetKey: `directory_member:${id}`,
    locator: { source: 'directory_member', id },
    displayName: `Target ${index}`,
    email: `target${index}@example.test`,
    phone: null,
    title: 'Policy Director',
    organization: 'Office',
    clientId: null,
    jurisdiction: {
      governmentLevel: 'federal',
      chamber: index % 2 === 0 ? 'senate' : 'house',
      state: index % 3 === 0 ? 'MD' : 'VA',
      district: String(index).padStart(2, '0'),
      committees: [],
      issueAreas: [],
    },
    roleStatus: 'current',
    emailStatus: 'available',
    profileStatus: 'complete',
    sourceSnapshot: { system: 'directory', version: '1', lastVerifiedAt: null },
    snapshotHash: String(index)
      .padEnd(64, 'b')
      .slice(0, 64)
      .replace(/[^a-f0-9]/g, 'b'),
  } as OutreachResolvedTargetRefV1;
}

function currentSession(targetCount = 4, stateVersion = 7) {
  const spec = createBlankCampaignSpecV1();
  spec.targeting.selectedTargetRefs = Array.from({ length: targetCount }, (_, i) => target(i + 1));
  spec.delivery = { pattern: 'personalized_separate', personalization: 'high' };
  return {
    session: { id: SESSION_ID, title: 'Test campaign', status: 'active' },
    currentStateVersion: stateVersion,
    specHash: PLAN_SPEC_HASH,
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

function manifest() {
  return {
    contextPacketId: 'packet-1',
    packetHash: 'c'.repeat(64),
    evidenceCountsByType: {},
    included: [],
    exclusions: [],
    failures: [],
    criticalFailures: [],
    oldestSourceAt: null,
    newestSourceAt: null,
    policy: {
      policyId: 'policy',
      version: '1',
      label: 'Policy',
      jurisdiction: 'federal',
      audienceType: 'congressional',
    },
    provider: 'openai',
    model: 'model',
    planModel: null,
    promptSpecVersion: 'v1',
    emailScopeLabel: 'My mailbox',
    standingMemoryCount: 0,
    criticalMissingContext: [],
    disclosures: [],
  } as any;
}

function harness(options: { sessions?: any; generate?: jest.Mock } = {}) {
  const base = currentSession();
  const sessions = options.sessions ?? {
    getSession: jest.fn().mockResolvedValue(base),
  };
  const preparation = {
    prepareSlot: jest.fn().mockImplementation(async (_ctx: unknown, _spec: unknown, slot: any) => ({
      slot,
      currentTargets: [
        base.spec.targeting.selectedTargetRefs.find(
          (entry: any) => entry.targetKey === slot.recipientKey,
        ),
      ],
      selectedItems: [],
      serverEvidence: [],
      sourceContextKeys: [],
    })),
  };
  const roots = { ensureRoot: jest.fn().mockResolvedValue({ outreachRecordId: SESSION_ID }) };
  const pinned = {
    provider: 'openai',
    model: 'model',
    planModel: null,
    promptSpecVersion: 'v1',
    policyId: 'policy',
    policyVersion: '1',
  };
  const generate =
    options.generate ??
    jest.fn().mockImplementation(async (_ctx: unknown, request: any) => ({
      outcome: 'ready',
      generationKey: request.recipient.generationKey,
      recipientKey: request.recipient.recipientKey,
      subject: `Subject ${request.recipient.generationKey}`,
      body: 'Body',
      manifest: manifest(),
      artifactId: `artifact-${request.recipient.generationKey}`,
      versionId: `version-${request.recipient.generationKey}`,
      version: 1,
      generationStatus: 'generated',
      auditStatus: 'passed',
      approvalStatus: 'not_required',
      sendable: true,
      pinned,
    }));
  const gateway = {
    enabled: true,
    resolvePinnedIdentity: jest.fn().mockResolvedValue({ pinned, creds: { provider: 'openai' } }),
    generate,
  };
  const drafts = {
    getVersion: jest.fn().mockImplementation(async (_ctx: unknown, versionId: string) => {
      const generationKey = versionId.slice('version-'.length);
      return {
        id: versionId,
        artifactId: `artifact-${generationKey}`,
        outreachRecordId: SESSION_ID,
        version: 1,
        sourceVersionId: null,
        generationKey,
        recipientKey: generationKey,
        audienceKind: 'individual',
        subject: 'Subject',
        body: 'Body',
        contentHash: `sha256:${'d'.repeat(64)}`,
        generationStatus: 'generated',
        auditStatus: 'passed',
        approvalStatus: 'not_required',
        auditDecision: null,
        auditChecks: [],
        reviewRequestId: null,
        provider: 'openai',
        model: 'model',
        promptSpecVersion: 'v1',
        sendable: true,
        createdAt: '2026-08-11T00:00:00.000Z',
      };
    }),
  };
  const service = new OutreachV3SampleGenerationService(
    sessions as any,
    preparation as any,
    roots as any,
    gateway as any,
    drafts as any,
  );
  return { service, sessions, preparation, roots, gateway, drafts, generate, pinned };
}

describe('Outreach V3 representative sample generation coordinator', () => {
  it('pins one provider/model and generates only the deterministic max-three sample set', async () => {
    const h = harness();
    const result = await h.service.generateSamples(CTX, SESSION_ID, 'Bearer test');

    expect(result.complete).toBe(true);
    expect(result.samples).toHaveLength(3);
    expect(result.representativeSampleKeys).toHaveLength(3);
    expect(result.approachApprovalRequired).toBe(true);
    expect(result.fullGenerationStarted).toBe(false);
    expect(result.samples.every((sample) => sample.sendable === false)).toBe(true);
    expect(h.gateway.resolvePinnedIdentity).toHaveBeenCalledTimes(1);
    expect(h.generate).toHaveBeenCalledTimes(3);
    for (const call of h.generate.mock.calls) {
      expect(call[1].pinned).toEqual(h.pinned);
      expect(call[2].includeRelevantEmail).toBe(false);
      expect(Array.isArray(call[2].auditLedger)).toBe(true);
    }
  });

  it('reauthorizes the whole sample set before the first model call', async () => {
    const h = harness();
    await h.service.generateSamples(CTX, SESSION_ID);
    expect(h.preparation.prepareSlot).toHaveBeenCalledTimes(3);
    expect(h.preparation.prepareSlot.mock.invocationCallOrder[2]).toBeLessThan(
      h.generate.mock.invocationCallOrder[0]!,
    );
  });

  it('stops immediately after the first sample that fails to persist', async () => {
    const generate = jest.fn().mockResolvedValue({
      outcome: 'blocked',
      generationKey: 'v3:blocked',
      recipientKey: 'blocked',
      subject: '',
      body: '',
      manifest: manifest(),
      sendable: false,
      error: 'blocked',
      pinned: {
        provider: 'openai',
        model: 'model',
        planModel: null,
        promptSpecVersion: 'v1',
        policyId: 'policy',
        policyVersion: '1',
      },
    });
    const h = harness({ generate });
    const result = await h.service.generateSamples(CTX, SESSION_ID);
    expect(result.complete).toBe(false);
    expect(result.samples).toHaveLength(1);
    expect(result.samples[0]?.sampleVersion).toBeNull();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('fails the action if Campaign Spec moves after a persisted sample', async () => {
    const original = currentSession(4, 7);
    const changed = currentSession(4, 8);
    const sessions = {
      getSession: jest.fn().mockResolvedValueOnce(original).mockResolvedValueOnce(changed),
    };
    const h = harness({ sessions });

    let thrown: OutreachCommandError | null = null;
    try {
      await h.service.generateSamples(CTX, SESSION_ID);
    } catch (error) {
      thrown = error as OutreachCommandError;
    }
    expect(thrown?.code).toBe('OUTREACH_STATE_CONFLICT');
    expect(h.generate).toHaveBeenCalledTimes(1);
  });

  it('does not call any preparation/model code when the shared generation gateway is dark', async () => {
    const h = harness();
    h.gateway.enabled = false;
    await expect(h.service.generateSamples(CTX, SESSION_ID)).rejects.toMatchObject({
      code: 'OUTREACH_COMMAND_BLOCKED',
      httpStatus: 503,
    });
    expect(h.preparation.prepareSlot).not.toHaveBeenCalled();
    expect(h.generate).not.toHaveBeenCalled();
  });
});
