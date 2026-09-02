import type { TenantContext } from '@capiro/shared';
import type { OutreachResolvedContextRefV1 } from '../../capabilities/context/outreach-context.contract.js';
import type { OutreachContextReferenceService } from '../../capabilities/context/outreach-context-reference.service.js';
import type { OutreachResolvedTargetRefV1 } from '../../capabilities/targets/outreach-target.contract.js';
import type { OutreachTargetReferenceService } from '../../capabilities/targets/outreach-target-reference.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import { createBlankCampaignSpecV1 } from '../state/outreach-campaign-spec.v1.js';
import { buildOutreachV3GenerationPlan } from './outreach-v3-generation-plan.js';
import { OutreachV3GenerationPreparationService } from './outreach-v3-generation-preparation.service.js';

const CTX = { tenantId: 't1', tenantSlug: 'tenant', userId: 'u1' } as TenantContext;

function target(
  id: string,
  overrides: Partial<OutreachResolvedTargetRefV1> = {},
): OutreachResolvedTargetRefV1 {
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
    snapshotHash: id.padEnd(64, 'a').slice(0, 64).replace(/[^a-f0-9]/g, 'a'),
    ...overrides,
  } as OutreachResolvedTargetRefV1;
}

function context(
  key: string,
  contextClass: OutreachResolvedContextRefV1['contextClass'],
  scope: OutreachResolvedContextRefV1['scope'],
): OutreachResolvedContextRefV1 {
  return {
    contextKey: key,
    locator: { source: 'government_record', category: 'hearing', id: key },
    contextClass,
    scope,
    title: `Source ${key}`,
    summary: `Verified text for ${key}`,
    clientId: null,
    verificationClass: 'authoritative',
    sensitivity: 'normal',
    instructionsAllowed: false,
    // Full evidence assembly (prepareOutreachV3ContextForGeneration) requires
    // this to be true for anything not writing-guidance or a user-supplied
    // target fact — the plan-builder's own minimal fixture (this helper was
    // copied from outreach-v3-generation-plan.spec.ts) never needed it because
    // the plan builder only reads contextKey/snapshotHash, not the full ref.
    usableAsEvidence: true,
    usableAsWritingGuidance: false,
    sourceSnapshot: { system: 'test', version: '1', lastVerifiedAt: '2026-08-11T00:00:00.000Z' },
    snapshotHash: key.padEnd(64, 'b').slice(0, 64).replace(/[^a-f0-9]/g, 'b'),
  } as OutreachResolvedContextRefV1;
}

/**
 * Builds a real slot via the actual plan builder (not a hand-rolled shape),
 * with one target and one accepted context ref, so `prepareSlot` is exercised
 * against the exact object shape production code produces.
 */
function specAndSlot() {
  const spec = createBlankCampaignSpecV1();
  spec.sponsor = { kind: 'client', label: null, clientRefs: [] };
  spec.targeting.criteria = {
    notes: null,
    governmentLevels: ['federal'],
    chambers: ['house'],
    committees: [],
    agencies: [],
    states: [],
    relationshipPreference: 'any',
    includeStaff: true,
    includePrincipals: true,
  };
  spec.delivery = { pattern: 'personalized_separate', personalization: 'high' };
  spec.strategy = {
    campaignAngle: 'Protect the program.',
    tone: 'professional',
    length: 'short',
    customLengthInstruction: null,
  };
  spec.targeting.selectedTargetRefs = [target('alpha')];
  spec.context.campaignFactRefs = [context('campaign-fact', 'campaign_fact', { kind: 'campaign' })];

  const plan = buildOutreachV3GenerationPlan({
    sessionId: '11111111-1111-4111-8111-111111111111',
    stateVersion: 9,
    specHash: 'c'.repeat(64),
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
      blockers: [],
    },
    pendingProposalCount: 0,
  });
  const slot = plan.slots[0]!;
  return { spec, slot };
}

function harness(input?: {
  resolveTarget?: jest.Mock;
  resolveContext?: jest.Mock;
}) {
  const tx = {};
  const withTenantUser = jest.fn(async (_tenantId: string, _userId: string, fn: (tx: unknown) => unknown) =>
    fn(tx),
  );
  const prisma = { withTenantUser } as unknown as PrismaService;

  const resolveOneWithinTx =
    input?.resolveTarget ??
    jest.fn(async (_tx: unknown, _ctx: TenantContext, locator: { id: string }) =>
      target(locator.id),
    );
  const targetReferences = { resolveOneWithinTx } as unknown as OutreachTargetReferenceService;

  const resolveContextOneWithinTx =
    input?.resolveContext ??
    jest.fn(async (_tx: unknown, _ctx: TenantContext, selection: { locator: unknown }) =>
      context('campaign-fact', 'campaign_fact', { kind: 'campaign' }),
    );
  const contextReferences = {
    resolveOneWithinTx: resolveContextOneWithinTx,
  } as unknown as OutreachContextReferenceService;

  return {
    service: new OutreachV3GenerationPreparationService(prisma, targetReferences, contextReferences),
    withTenantUser,
    resolveOneWithinTx,
    resolveContextOneWithinTx,
    tx,
  };
}

describe('OutreachV3GenerationPreparationService.prepareSlot', () => {
  it('resolves every target and context ref inside ONE shared transaction, not one per ref', async () => {
    const { spec, slot } = specAndSlot();
    const h = harness();

    const result = await h.service.prepareSlot(CTX, spec, slot);

    expect(h.withTenantUser).toHaveBeenCalledTimes(1);
    expect(h.resolveOneWithinTx).toHaveBeenCalledWith(h.tx, CTX, expect.objectContaining({ id: 'alpha' }));
    expect(h.resolveContextOneWithinTx).toHaveBeenCalledWith(
      h.tx,
      CTX,
      expect.objectContaining({ contextClass: 'campaign_fact' }),
    );
    expect(result.currentTargets).toHaveLength(1);
    expect(result.currentTargets[0]!.targetKey).toBe('directory_member:alpha');
  });

  it('blocks with target_unavailable, naming the exact target, when resolution throws', async () => {
    const { spec, slot } = specAndSlot();
    const h = harness({ resolveTarget: jest.fn().mockRejectedValue(new Error('lookup failed')) });

    await expect(h.service.prepareSlot(CTX, spec, slot)).rejects.toMatchObject({
      code: 'OUTREACH_COMMAND_BLOCKED',
      safeMetadata: { targetKey: 'directory_member:alpha', reason: 'target_unavailable' },
    } satisfies Partial<OutreachCommandError>);
  });

  it('blocks with target_snapshot_changed when the resolved target no longer matches the reviewed snapshot', async () => {
    const { spec, slot } = specAndSlot();
    const h = harness({
      resolveTarget: jest.fn(async () => target('alpha', { snapshotHash: 'f'.repeat(64) })),
    });

    await expect(h.service.prepareSlot(CTX, spec, slot)).rejects.toMatchObject({
      code: 'OUTREACH_COMMAND_BLOCKED',
      safeMetadata: { targetKey: 'directory_member:alpha', reason: 'target_snapshot_changed' },
    } satisfies Partial<OutreachCommandError>);
  });

  it('blocks with context_unavailable, naming the exact context key, when context resolution throws', async () => {
    const { spec, slot } = specAndSlot();
    const h = harness({ resolveContext: jest.fn().mockRejectedValue(new Error('gone')) });

    await expect(h.service.prepareSlot(CTX, spec, slot)).rejects.toMatchObject({
      code: 'OUTREACH_COMMAND_BLOCKED',
      safeMetadata: { contextKey: 'campaign-fact', reason: 'context_unavailable' },
    } satisfies Partial<OutreachCommandError>);
  });
});
