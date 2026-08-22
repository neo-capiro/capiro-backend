import type { PinnedGenerationIdentity } from '../../engagement/generation/generation-gateway.types.js';
import {
  buildOutreachV3FullGenerationJob,
  isOutreachV3FullGenerationJobCurrent,
} from './outreach-v3-full-generation-job.js';
import {
  createOutreachV3ReviewPacketApprovalSnapshot,
  isOutreachV3ApproachApprovalCurrent,
  isOutreachV3ReviewPacketApproval,
} from './outreach-v3-generation-approach.js';
import type { OutreachV3GenerationPlan } from './outreach-v3-generation-plan.js';

const pin: PinnedGenerationIdentity = {
  provider: 'anthropic',
  model: 'model-a',
  planModel: null,
  promptSpecVersion: 'v2',
  policyId: 'federal_congressional',
  policyVersion: '1',
};

function plan(): OutreachV3GenerationPlan {
  const keys = ['slot-a', 'slot-b'];
  return {
    planVersion: 'outreach_v3_generation_plan_v1',
    planHash: 'a'.repeat(64),
    sessionId: '11111111-1111-4111-8111-111111111111',
    stateVersion: 7,
    specHash: 'b'.repeat(64),
    eligible: true,
    blockers: [],
    sponsorClientId: '22222222-2222-4222-8222-222222222222',
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
    representativeSampleKeys: ['slot-a', 'slot-b'],
  };
}

describe('Outreach V3 guided review-packet generation gate', () => {
  it('binds the human decision to the exact plan without claiming output review', () => {
    const campaignPlan = plan();
    const approval = createOutreachV3ReviewPacketApprovalSnapshot(campaignPlan);

    expect(isOutreachV3ReviewPacketApproval(approval)).toBe(true);
    expect(approval.sampleVersions).toEqual([]);
    expect(isOutreachV3ApproachApprovalCurrent(campaignPlan, approval)).toBe(true);
  });

  it('fails closed after any state, spec, or plan change', () => {
    const campaignPlan = plan();
    const approval = createOutreachV3ReviewPacketApprovalSnapshot(campaignPlan);

    expect(
      isOutreachV3ApproachApprovalCurrent(
        { ...campaignPlan, stateVersion: campaignPlan.stateVersion + 1 },
        approval,
      ),
    ).toBe(false);
    expect(
      isOutreachV3ApproachApprovalCurrent(
        { ...campaignPlan, specHash: 'c'.repeat(64) },
        approval,
      ),
    ).toBe(false);
    expect(
      isOutreachV3ApproachApprovalCurrent(
        { ...campaignPlan, planHash: 'd'.repeat(64) },
        approval,
      ),
    ).toBe(false);
  });

  it('authorizes only unfinished async generation slots', () => {
    const campaignPlan = plan();
    const approval = createOutreachV3ReviewPacketApprovalSnapshot(campaignPlan);
    const job = buildOutreachV3FullGenerationJob({
      plan: campaignPlan,
      approachApproval: approval,
      completedGenerationKeys: ['slot-a'],
      pinned: pin,
    });

    expect(job.items).toEqual([{ generationKey: 'slot-b' }]);
    expect(isOutreachV3FullGenerationJobCurrent(job, campaignPlan, approval)).toBe(true);
  });
});
