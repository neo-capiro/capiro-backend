import type { OutreachResolvedContextRefV1 } from '../../capabilities/context/outreach-context.contract.js';
import type { OutreachResolvedTargetRefV1 } from '../../capabilities/targets/outreach-target.contract.js';
import { createBlankCampaignSpecV1 } from '../state/outreach-campaign-spec.v1.js';
import type { OutreachCampaignReadiness } from '../state/outreach-readiness.contract.js';
import {
  buildOutreachV3GenerationPlan,
  selectRepresentativeSampleKeys,
} from './outreach-v3-generation-plan.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

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
    snapshotHash: id
      .padEnd(64, 'a')
      .slice(0, 64)
      .replace(/[^a-f0-9]/g, 'a'),
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
    snapshotHash: key
      .padEnd(64, 'b')
      .slice(0, 64)
      .replace(/[^a-f0-9]/g, 'b'),
    contextClass,
    scope,
  } as OutreachResolvedContextRefV1;
}

function ready(
  blockers: OutreachCampaignReadiness['blockers'] = [
    'GENERATION_NOT_AVAILABLE',
    'DRAFTS_NOT_AVAILABLE',
    'PREFLIGHT_NOT_AVAILABLE',
  ],
): OutreachCampaignReadiness {
  return {
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
    blockers,
  };
}

function baseInput() {
  const spec = createBlankCampaignSpecV1();
  spec.sponsor = {
    kind: 'client',
    label: null,
    clientRefs: [{ clientId: '22222222-2222-4222-8222-222222222222' }],
  };
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
  return {
    sessionId: SESSION_ID,
    stateVersion: 9,
    specHash: 'c'.repeat(64),
    spec,
    readiness: ready(),
    pendingProposalCount: 0,
  };
}

describe('Outreach V3 governed generation plan', () => {
  it('keeps target-specific context isolated to its exact target slot', () => {
    const input = baseInput();
    input.spec.targeting.selectedTargetRefs = [target('alpha'), target('bravo')];
    input.spec.context.campaignFactRefs = [
      context('campaign-fact', 'campaign_fact', { kind: 'campaign' }),
    ];
    input.spec.context.targetSpecificRefs = [
      context('alpha-fact', 'target_specific', {
        kind: 'target',
        targetKey: 'directory_member:alpha',
      }),
      context('bravo-fact', 'target_specific', {
        kind: 'target',
        targetKey: 'directory_member:bravo',
      }),
    ];

    const plan = buildOutreachV3GenerationPlan(input);
    expect(plan.eligible).toBe(true);
    expect(plan.slots).toHaveLength(2);

    const alpha = plan.slots.find((slot) => slot.recipientKey === 'directory_member:alpha');
    const bravo = plan.slots.find((slot) => slot.recipientKey === 'directory_member:bravo');
    expect(alpha?.context.campaignFacts.map((ref) => ref.contextKey)).toEqual(['campaign-fact']);
    expect(alpha?.context.targetSpecific.map((ref) => ref.contextKey)).toEqual(['alpha-fact']);
    expect(bravo?.context.targetSpecific.map((ref) => ref.contextKey)).toEqual(['bravo-fact']);
    expect(alpha?.context.targetSpecific.some((ref) => ref.contextKey === 'bravo-fact')).toBe(
      false,
    );
    expect(bravo?.context.targetSpecific.some((ref) => ref.contextKey === 'alpha-fact')).toBe(
      false,
    );
  });

  it('keeps writing guidance separate from factual evidence', () => {
    const input = baseInput();
    input.spec.targeting.selectedTargetRefs = [target('alpha')];
    input.spec.context.writingGuidanceRefs = [
      context('voice', 'writing_guidance', { kind: 'campaign' }),
    ];
    input.spec.context.campaignFactRefs = [context('fact', 'campaign_fact', { kind: 'campaign' })];

    const slot = buildOutreachV3GenerationPlan(input).slots[0]!;
    expect(slot.context.writingGuidance.map((ref) => ref.contextKey)).toEqual(['voice']);
    expect(slot.context.campaignFacts.map((ref) => ref.contextKey)).toEqual(['fact']);
    expect(slot.context.campaignFacts.some((ref) => ref.contextKey === 'voice')).toBe(false);
  });

  it('never mixes per-target facts into a shared-thread group slot', () => {
    const input = baseInput();
    input.spec.delivery = { pattern: 'shared_thread', personalization: 'light' };
    input.spec.targeting.selectedTargetRefs = [target('alpha'), target('bravo')];
    input.spec.context.campaignFactRefs = [
      context('campaign-fact', 'campaign_fact', { kind: 'campaign' }),
    ];
    input.spec.context.targetSpecificRefs = [
      context('alpha-fact', 'target_specific', {
        kind: 'target',
        targetKey: 'directory_member:alpha',
      }),
    ];
    input.spec.context.groupSafeRefs = [
      context('group-fact', 'group_safe', { kind: 'group', groupRef: 'shared-audience' }),
    ];

    const plan = buildOutreachV3GenerationPlan(input);
    expect(plan.slots).toHaveLength(1);
    expect(plan.slots[0]?.audienceKind).toBe('group');
    expect(plan.slots[0]?.context.targetSpecific).toEqual([]);
    expect(plan.slots[0]?.context.campaignFacts.map((ref) => ref.contextKey)).toEqual([
      'campaign-fact',
    ]);
    expect(plan.slots[0]?.context.groupSafe.map((ref) => ref.contextKey)).toEqual(['group-fact']);
  });

  it('fails closed when a real planning blocker or pending proposal remains', () => {
    const input = baseInput();
    input.spec.targeting.selectedTargetRefs = [target('alpha')];
    input.readiness = ready(['CONTEXT_NOT_REVIEWED', 'GENERATION_NOT_AVAILABLE']);
    input.pendingProposalCount = 1;

    const plan = buildOutreachV3GenerationPlan(input);
    expect(plan.eligible).toBe(false);
    expect(plan.blockers).toEqual(['CONTEXT_NOT_REVIEWED', 'PENDING_PROPOSALS']);
  });

  it('rejects high personalization for a shared thread even if corrupted state reaches the planner', () => {
    const input = baseInput();
    input.spec.targeting.selectedTargetRefs = [target('alpha'), target('bravo')];
    input.spec.delivery = { pattern: 'shared_thread', personalization: 'high' };

    const plan = buildOutreachV3GenerationPlan(input);
    expect(plan.eligible).toBe(false);
    expect(plan.blockers).toContain('SHARED_THREAD_HIGH_PERSONALIZATION');
  });

  it('selects at most three deterministic, diverse representative samples', () => {
    const input = baseInput();
    input.spec.targeting.selectedTargetRefs = [
      target('one', {
        jurisdiction: { ...target('one').jurisdiction, chamber: 'house', state: 'VA' },
      }),
      target('two', {
        jurisdiction: { ...target('two').jurisdiction, chamber: 'house', state: 'VA' },
      }),
      target('three', {
        jurisdiction: { ...target('three').jurisdiction, chamber: 'senate', state: 'VA' },
      }),
      target('four', {
        locator: { source: 'state_legislator', id: 'four' },
        targetKey: 'state_legislator:four',
        jurisdiction: {
          ...target('four').jurisdiction,
          governmentLevel: 'state',
          chamber: 'state_senate',
          state: 'MD',
        },
      }),
    ];

    const plan = buildOutreachV3GenerationPlan(input);
    expect(plan.representativeSampleKeys).toHaveLength(3);
    expect(new Set(plan.representativeSampleKeys).size).toBe(3);
    expect(selectRepresentativeSampleKeys([...plan.slots].reverse())).toEqual(
      plan.representativeSampleKeys,
    );
  });

  it('hashes the same canonical plan identically across repeated reads', () => {
    const input = baseInput();
    input.spec.targeting.selectedTargetRefs = [target('alpha'), target('bravo')];
    const first = buildOutreachV3GenerationPlan(input);
    const second = buildOutreachV3GenerationPlan(input);
    expect(second.planHash).toBe(first.planHash);
    expect(second.representativeSampleKeys).toEqual(first.representativeSampleKeys);
  });
});
