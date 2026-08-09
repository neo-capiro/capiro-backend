import { describe, expect, it } from 'vitest';
import type { OutreachV3SessionEnvelope } from './contracts.js';
import {
  deriveOutreachV3Stage,
  outreachV3PlanningBlockerCodes,
  outreachV3ReadinessBlockerCodes,
} from './useOutreachV3Session.js';

const FUTURE_BLOCKERS = [
  'GENERATION_NOT_AVAILABLE',
  'DRAFTS_NOT_AVAILABLE',
  'PREFLIGHT_NOT_AVAILABLE',
];

function session(): OutreachV3SessionEnvelope {
  return {
    session: { id: 'session-1', title: 'Campaign', status: 'active' },
    currentStateVersion: 1,
    specHash: 'hash',
    pendingProposalCount: 0,
    readiness: {
      goalReady: false,
      sponsorResolved: false,
      targetCriteriaReady: false,
      targetsReady: false,
      deliveryReady: false,
      contextReady: false,
      contextEvidenceReady: true,
      strategyReady: false,
      sampleGenerationEligible: false,
      fullGenerationEligible: false,
      sendReviewEligible: false,
      blockers: [
        'GOAL_MISSING',
        'SPONSOR_UNDECIDED',
        'TARGET_CRITERIA_MISSING',
        'TARGETS_MISSING',
        'DELIVERY_UNDECIDED',
        'CONTEXT_NOT_REVIEWED',
        'STRATEGY_INCOMPLETE',
        ...FUTURE_BLOCKERS,
      ],
    },
    spec: {
      schemaVersion: 'outreach_campaign_spec_v1',
      goal: {
        goal: null,
        objective: null,
        topic: null,
        desiredOutcome: null,
        ask: { mode: 'undecided', text: null },
        whyNow: null,
      },
      sponsor: { kind: 'undecided', label: null, clientRefs: [] },
      targeting: {
        criteria: null,
        selectedTargetRefs: [],
        rejectedRecommendationRefs: [],
      },
      delivery: { pattern: 'undecided', personalization: 'undecided' },
      context: {
        requiredPolicyRefs: [],
        writingGuidanceRefs: [],
        campaignFactRefs: [],
        targetSpecificRefs: [],
        groupSafeRefs: [],
        excludedRefs: [],
      },
      strategy: {
        campaignAngle: null,
        tone: null,
        length: 'undecided',
        customLengthInstruction: null,
      },
    },
  };
}

function completeGoal(value: OutreachV3SessionEnvelope) {
  value.spec.goal = {
    goal: 'Protect funding',
    objective: 'Educate staff',
    topic: 'Ground Robotics',
    desiredOutcome: 'Request a meeting',
    ask: { mode: 'explicit', text: 'Request a staff briefing' },
    whyNow: 'Current mark',
  };
}

function addCriteria(value: OutreachV3SessionEnvelope) {
  value.spec.targeting.criteria = {
    notes: 'Ground Robotics staff',
    governmentLevels: ['federal'],
    chambers: ['house'],
    committees: ['HASC'],
    agencies: [],
    states: [],
    relationshipPreference: 'any',
    includeStaff: true,
    includePrincipals: true,
  };
}

function addTarget(value: OutreachV3SessionEnvelope) {
  value.spec.targeting.selectedTargetRefs.push({
    targetKey: 'directory_staff:staff-1',
    locator: { source: 'directory_staff', id: 'staff-1' },
    displayName: 'Alex Morgan',
    title: 'Professional Staff Member',
    organization: 'HASC',
    email: 'alex@example.test',
    clientId: null,
    roleStatus: 'current',
    snapshotHash: 'a'.repeat(64),
    jurisdiction: {
      governmentLevel: 'federal',
      chamber: 'House',
      state: null,
      district: null,
      committees: ['HASC'],
      issueAreas: ['Ground Robotics'],
    },
  });
}

function addContext(value: OutreachV3SessionEnvelope, usableAsEvidence = true) {
  value.spec.context.campaignFactRefs.push({
    contextKey: 'campaign_fact:campaign:government_record:hearing:h-1',
    locator: { source: 'government_record', id: 'h-1', category: 'hearing' },
    contextClass: 'campaign_fact',
    scope: { kind: 'campaign' },
    title: 'HASC hearing',
    summary: 'Verified hearing record',
    verificationClass: usableAsEvidence ? 'authoritative' : 'unverified',
    sensitivity: 'normal',
    instructionsAllowed: false,
    usableAsEvidence,
    usableAsWritingGuidance: false,
    snapshotHash: 'b'.repeat(64),
  });
}

function setBlockers(value: OutreachV3SessionEnvelope, blockers: string[]) {
  value.readiness.blockers = [...blockers, ...FUTURE_BLOCKERS];
}

describe('deriveOutreachV3Stage', () => {
  it('starts with the goal and never requires a client to reach targets', () => {
    const value = session();
    expect(deriveOutreachV3Stage(value)).toBe('goal');

    completeGoal(value);
    value.spec.sponsor.kind = 'none';
    value.readiness.goalReady = true;
    value.readiness.sponsorResolved = true;
    setBlockers(value, ['TARGET_CRITERIA_MISSING', 'TARGETS_MISSING', 'DELIVERY_UNDECIDED', 'CONTEXT_NOT_REVIEWED', 'STRATEGY_INCOMPLETE']);

    expect(deriveOutreachV3Stage(value)).toBe('targets');
  });

  it('follows canonical backend blocker priority instead of browser-invented wizard state', () => {
    const value = session();
    completeGoal(value);
    value.readiness.goalReady = true;
    setBlockers(value, ['SPONSOR_UNDECIDED', 'TARGET_CRITERIA_MISSING', 'TARGETS_MISSING', 'DELIVERY_UNDECIDED', 'CONTEXT_NOT_REVIEWED', 'STRATEGY_INCOMPLETE']);
    expect(deriveOutreachV3Stage(value)).toBe('sponsor');

    value.spec.sponsor.kind = 'firm';
    value.readiness.sponsorResolved = true;
    setBlockers(value, ['TARGET_CRITERIA_MISSING', 'TARGETS_MISSING', 'DELIVERY_UNDECIDED', 'CONTEXT_NOT_REVIEWED', 'STRATEGY_INCOMPLETE']);
    expect(deriveOutreachV3Stage(value)).toBe('targets');

    addTarget(value);
    value.readiness.targetsReady = true;
    expect(deriveOutreachV3Stage(value)).toBe('targets');

    addCriteria(value);
    value.readiness.targetCriteriaReady = true;
    setBlockers(value, ['DELIVERY_UNDECIDED', 'CONTEXT_NOT_REVIEWED', 'STRATEGY_INCOMPLETE']);
    expect(deriveOutreachV3Stage(value)).toBe('delivery');

    value.spec.delivery = { pattern: 'personalized_separate', personalization: 'light' };
    value.readiness.deliveryReady = true;
    setBlockers(value, ['CONTEXT_NOT_REVIEWED', 'STRATEGY_INCOMPLETE']);
    expect(deriveOutreachV3Stage(value)).toBe('context');

    addContext(value, false);
    value.readiness.contextReady = true;
    value.readiness.contextEvidenceReady = false;
    setBlockers(value, ['CONTEXT_HAS_UNVERIFIED_EVIDENCE', 'STRATEGY_INCOMPLETE']);
    expect(deriveOutreachV3Stage(value)).toBe('context');

    value.spec.context.campaignFactRefs[0]!.usableAsEvidence = true;
    value.spec.context.campaignFactRefs[0]!.verificationClass = 'authoritative';
    value.readiness.contextEvidenceReady = true;
    setBlockers(value, ['STRATEGY_INCOMPLETE']);
    expect(deriveOutreachV3Stage(value)).toBe('strategy');

    value.spec.strategy = {
      campaignAngle: 'Protect funding through staff education',
      tone: 'Direct and professional',
      length: 'short',
      customLengthInstruction: null,
    };
    value.readiness.strategyReady = true;
    setBlockers(value, []);
    expect(deriveOutreachV3Stage(value)).toBe('ready_for_generation');
  });

  it('honors a backend blocker even when the local spec appears complete', () => {
    const value = session();
    completeGoal(value);
    value.spec.sponsor.kind = 'firm';
    addCriteria(value);
    addTarget(value);
    value.spec.delivery = { pattern: 'uniform_separate', personalization: 'none' };
    addContext(value);
    value.spec.strategy = {
      campaignAngle: 'Educate staff',
      tone: 'Professional',
      length: 'short',
      customLengthInstruction: null,
    };
    setBlockers(value, ['GOAL_MISSING']);

    expect(deriveOutreachV3Stage(value)).toBe('goal');
  });

  it('uses the spec only for a legacy response with no blockers property', () => {
    const value = session();
    delete value.readiness.blockers;
    completeGoal(value);
    value.spec.sponsor.kind = 'none';
    addCriteria(value);
    addTarget(value);
    value.spec.delivery = { pattern: 'uniform_separate', personalization: 'none' };
    addContext(value);
    value.spec.strategy = {
      campaignAngle: 'Educate staff',
      tone: 'Professional',
      length: 'short',
      customLengthInstruction: null,
    };

    expect(deriveOutreachV3Stage(value)).toBe('ready_for_generation');
  });
});

describe('canonical blocker projections', () => {
  it('accepts string and object blocker shapes while excluding only future-phase blockers', () => {
    const readiness = {
      blockers: [
        'TARGETS_MISSING',
        { code: 'CONTEXT_HAS_UNVERIFIED_EVIDENCE' },
        ...FUTURE_BLOCKERS,
      ],
    };

    expect(outreachV3ReadinessBlockerCodes(readiness)).toEqual([
      'TARGETS_MISSING',
      'CONTEXT_HAS_UNVERIFIED_EVIDENCE',
      ...FUTURE_BLOCKERS,
    ]);
    expect(outreachV3PlanningBlockerCodes(readiness)).toEqual([
      'TARGETS_MISSING',
      'CONTEXT_HAS_UNVERIFIED_EVIDENCE',
    ]);
  });
});