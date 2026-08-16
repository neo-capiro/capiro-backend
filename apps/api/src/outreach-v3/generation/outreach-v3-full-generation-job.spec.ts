import type { PinnedGenerationIdentity } from '../../engagement/generation/generation-gateway.types.js';
import {
  buildOutreachV3FullGenerationJob,
  isOutreachV3FullGenerationJobCurrent,
  nextOutreachV3FullGenerationBatch,
  parseOutreachV3FullGenerationJob,
} from './outreach-v3-full-generation-job.js';
import type { OutreachV3ApproachApprovalSnapshot } from './outreach-v3-generation-approach.js';
import type { OutreachV3GenerationPlan } from './outreach-v3-generation-plan.js';

const pin: PinnedGenerationIdentity = {
  provider: 'anthropic',
  model: 'model-a',
  planModel: 'model-b',
  promptSpecVersion: 'v2',
  policyId: 'federal_congressional',
  policyVersion: '1',
};

function plan(): OutreachV3GenerationPlan {
  const keys = ['slot-a', 'slot-b', 'slot-c', 'slot-d'];
  return {
    planVersion: 'outreach_v3_generation_plan_v1',
    planHash: 'a'.repeat(64),
    sessionId: '11111111-1111-4111-8111-111111111111',
    stateVersion: 9,
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

function approval(campaignPlan = plan()): OutreachV3ApproachApprovalSnapshot {
  return {
    gateVersion: 'outreach_v3_approach_gate_v1',
    sessionId: campaignPlan.sessionId,
    stateVersion: campaignPlan.stateVersion,
    specHash: campaignPlan.specHash,
    planHash: campaignPlan.planHash,
    sampleSetHash: 'c'.repeat(64),
    sampleVersions: ['slot-a', 'slot-b', 'slot-c'].map((generationKey, index) => ({
      generationKey,
      artifactId: `artifact-${index}`,
      versionId: `version-${index}`,
      contentHash: 'd'.repeat(63) + String(index),
      planHash: campaignPlan.planHash,
      auditStatus: 'passed',
      generationStatus: 'generated',
    })),
    approvalHash: 'e'.repeat(64),
  };
}

describe('Outreach V3 full-generation durable job contract', () => {
  it('queues only unfinished slots and persists no recipient text or credentials', () => {
    const descriptor = buildOutreachV3FullGenerationJob({
      plan: plan(),
      approachApproval: approval(),
      completedGenerationKeys: ['slot-a', 'slot-b', 'slot-c'],
      pinned: pin,
    });
    expect(descriptor.items).toEqual([{ generationKey: 'slot-d' }]);
    expect(descriptor.batchSize).toBe(10);
    const durable = JSON.stringify(descriptor);
    expect(durable).not.toContain('apiKey');
    expect(durable).not.toContain('Authorization');
    expect(durable).not.toContain('authHeader');
    expect(durable).not.toContain('@example');
    expect(parseOutreachV3FullGenerationJob(descriptor)).toEqual(descriptor);
  });

  it('fails closed if the durable descriptor is tampered with', () => {
    const descriptor = buildOutreachV3FullGenerationJob({
      plan: plan(),
      approachApproval: approval(),
      completedGenerationKeys: ['slot-a'],
      pinned: pin,
    });
    expect(
      parseOutreachV3FullGenerationJob({
        ...descriptor,
        pinned: { ...descriptor.pinned, apiKey: 'secret' },
      }),
    ).toBeNull();
    expect(
      parseOutreachV3FullGenerationJob({
        ...descriptor,
        planHash: 'f'.repeat(64),
      }),
    ).toBeNull();
  });

  it('invalidates when Campaign Spec or approach approval changes', () => {
    const campaignPlan = plan();
    const accepted = approval(campaignPlan);
    const descriptor = buildOutreachV3FullGenerationJob({
      plan: campaignPlan,
      approachApproval: accepted,
      completedGenerationKeys: ['slot-a', 'slot-b', 'slot-c'],
      pinned: pin,
    });
    expect(isOutreachV3FullGenerationJobCurrent(descriptor, campaignPlan, accepted)).toBe(true);
    expect(
      isOutreachV3FullGenerationJobCurrent(
        descriptor,
        { ...campaignPlan, planHash: 'f'.repeat(64) },
        accepted,
      ),
    ).toBe(false);
    expect(
      isOutreachV3FullGenerationJobCurrent(descriptor, campaignPlan, {
        ...accepted,
        approvalHash: 'f'.repeat(64),
      }),
    ).toBe(false);
  });

  it('claims a deterministic bounded subset of unfinished job keys', () => {
    const campaignPlan = plan();
    const descriptor = buildOutreachV3FullGenerationJob({
      plan: campaignPlan,
      approachApproval: approval(campaignPlan),
      completedGenerationKeys: [],
      pinned: pin,
    });
    expect(
      nextOutreachV3FullGenerationBatch(descriptor, ['slot-d', 'slot-b', 'other', 'slot-a']),
    ).toEqual(['slot-a', 'slot-b', 'slot-d']);
  });
});
