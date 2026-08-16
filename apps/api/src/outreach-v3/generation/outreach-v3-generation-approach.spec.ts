import type { OutreachV3GenerationPlan } from './outreach-v3-generation-plan.js';
import {
  createOutreachV3ApproachApprovalSnapshot,
  evaluateOutreachV3ApproachGate,
  isOutreachV3ApproachApprovalCurrent,
  remainingOutreachV3GenerationKeys,
  type OutreachV3SampleVersionRef,
} from './outreach-v3-generation-approach.js';

function plan(): OutreachV3GenerationPlan {
  const keys = ['slot-a', 'slot-b', 'slot-c', 'slot-d'];
  return {
    planVersion: 'outreach_v3_generation_plan_v1',
    planHash: 'a'.repeat(64),
    sessionId: '11111111-1111-4111-8111-111111111111',
    stateVersion: 8,
    specHash: 'b'.repeat(64),
    eligible: true,
    blockers: [],
    sponsorClientId: null,
    deliveryPattern: 'personalized_separate',
    personalization: 'high',
    slots: keys.map((generationKey) => ({
      generationKey,
      recipientKey: generationKey,
      audienceKind: 'individual',
      scopeKeys: [generationKey],
      recipients: [],
      context: {
        requiredPolicy: [],
        writingGuidance: [],
        campaignFacts: [],
        targetSpecific: [],
        groupSafe: [],
      },
      diversitySignature: generationKey,
    })),
    representativeSampleKeys: ['slot-a', 'slot-b', 'slot-c'],
  };
}

function sample(
  generationKey: string,
  version = generationKey,
  planHash = 'a'.repeat(64),
): OutreachV3SampleVersionRef {
  return {
    generationKey,
    artifactId: `artifact-${version}`,
    versionId: `version-${version}`,
    contentHash: generationKey.padEnd(64, 'c').slice(0, 64),
    planHash,
    auditStatus: 'passed',
    generationStatus: 'generated',
  };
}

describe('Outreach V3 representative-sample approach gate', () => {
  it('requires exactly the deterministic representative sample set', () => {
    const campaignPlan = plan();
    expect(
      evaluateOutreachV3ApproachGate(campaignPlan, [sample('slot-a'), sample('slot-b')]),
    ).toEqual(
      expect.objectContaining({
        eligible: false,
        blockers: ['REPRESENTATIVE_SAMPLE_MISSING'],
      }),
    );
    expect(
      evaluateOutreachV3ApproachGate(campaignPlan, [
        sample('slot-a'),
        sample('slot-b'),
        sample('slot-c'),
      ]).eligible,
    ).toBe(true);
  });

  it('rejects held/pending samples from approach approval', () => {
    const held = sample('slot-b');
    held.auditStatus = 'held';
    const gate = evaluateOutreachV3ApproachGate(plan(), [sample('slot-a'), held, sample('slot-c')]);
    expect(gate.eligible).toBe(false);
    expect(gate.blockers).toContain('REPRESENTATIVE_SAMPLE_NOT_REVIEWABLE');
  });

  it('rejects a sample generated from an older plan even when its slot key is unchanged', () => {
    const stale = sample('slot-b', 'slot-b', 'd'.repeat(64));
    const gate = evaluateOutreachV3ApproachGate(plan(), [
      sample('slot-a'),
      stale,
      sample('slot-c'),
    ]);
    expect(gate.eligible).toBe(false);
    expect(gate.blockers).toContain('REPRESENTATIVE_SAMPLE_STALE');
  });

  it('pins approval to exact immutable sample versions and plan hash', () => {
    const campaignPlan = plan();
    const approval = createOutreachV3ApproachApprovalSnapshot(campaignPlan, [
      sample('slot-c'),
      sample('slot-a'),
      sample('slot-b'),
    ]);
    expect(approval.sampleVersions.map((entry) => entry.generationKey)).toEqual([
      'slot-a',
      'slot-b',
      'slot-c',
    ]);
    expect(approval.sampleVersions.every((entry) => entry.planHash === campaignPlan.planHash)).toBe(
      true,
    );
    expect(isOutreachV3ApproachApprovalCurrent(campaignPlan, approval)).toBe(true);

    const changed = { ...campaignPlan, stateVersion: 9, planHash: 'd'.repeat(64) };
    expect(isOutreachV3ApproachApprovalCurrent(changed, approval)).toBe(false);
  });

  it('resumes only unfinished generation slots after approach approval', () => {
    const campaignPlan = plan();
    const approval = createOutreachV3ApproachApprovalSnapshot(campaignPlan, [
      sample('slot-a'),
      sample('slot-b'),
      sample('slot-c'),
    ]);
    expect(
      remainingOutreachV3GenerationKeys(campaignPlan, approval, ['slot-a', 'slot-b', 'slot-c']),
    ).toEqual(['slot-d']);
    expect(
      remainingOutreachV3GenerationKeys(campaignPlan, approval, [
        'slot-a',
        'slot-b',
        'slot-c',
        'slot-d',
      ]),
    ).toEqual([]);
  });

  it('never resumes generation under a stale approval', () => {
    const campaignPlan = plan();
    const approval = createOutreachV3ApproachApprovalSnapshot(campaignPlan, [
      sample('slot-a'),
      sample('slot-b'),
      sample('slot-c'),
    ]);
    const changed = { ...campaignPlan, specHash: 'e'.repeat(64), planHash: 'f'.repeat(64) };
    expect(remainingOutreachV3GenerationKeys(changed, approval, [])).toEqual([]);
  });
});
