import { parseCampaignSpecV1, type OutreachCampaignSpecV1 } from './outreach-campaign-spec.v1.js';

export const OUTREACH_READINESS_BLOCKER_CODES = [
  'GOAL_MISSING',
  'SPONSOR_UNDECIDED',
  'SPONSOR_SCOPE_INVALID',
  'TARGET_CRITERIA_MISSING',
  'TARGETS_NOT_IMPLEMENTED_YET',
  'TARGETS_MISSING',
  'DELIVERY_UNDECIDED',
  'CONTEXT_NOT_IMPLEMENTED_YET',
  'CONTEXT_NOT_REVIEWED',
  'STRATEGY_INCOMPLETE',
  'GENERATION_NOT_AVAILABLE',
  'DRAFTS_NOT_AVAILABLE',
  'PREFLIGHT_NOT_AVAILABLE',
] as const;

export type OutreachReadinessBlocker = (typeof OUTREACH_READINESS_BLOCKER_CODES)[number];

export interface OutreachFeatureAvailability {
  targets: boolean;
  context: boolean;
  generation: boolean;
  drafts: boolean;
  preflight: boolean;
}

export const PHASE2_OUTREACH_FEATURE_AVAILABILITY: OutreachFeatureAvailability = Object.freeze({
  targets: false,
  context: false,
  generation: false,
  drafts: false,
  preflight: false,
});

export const PHASE4_OUTREACH_FEATURE_AVAILABILITY: OutreachFeatureAvailability = Object.freeze({
  targets: true,
  context: false,
  generation: false,
  drafts: false,
  preflight: false,
});

export interface OutreachCampaignReadiness {
  goalReady: boolean;
  sponsorResolved: boolean;
  targetCriteriaReady: boolean;
  targetsReady: boolean;
  deliveryReady: boolean;
  contextReady: boolean;
  strategyReady: boolean;
  sampleGenerationEligible: boolean;
  fullGenerationEligible: boolean;
  sendReviewEligible: boolean;
  blockers: OutreachReadinessBlocker[];
}

function sponsorScopeValid(spec: OutreachCampaignSpecV1): boolean {
  const { kind, label, clientRefs } = spec.sponsor;
  if (kind === 'undecided') return false;
  if (['firm', 'internal_team', 'none'].includes(kind)) return clientRefs.length === 0;
  if (kind === 'client') return clientRefs.length === 1;
  if (kind === 'multi_client') return clientRefs.length >= 2;
  if (kind === 'coalition') return Boolean(label);
  return false;
}

export function deriveOutreachReadiness(
  input: OutreachCampaignSpecV1,
  availability: OutreachFeatureAvailability = PHASE2_OUTREACH_FEATURE_AVAILABILITY,
): OutreachCampaignReadiness {
  const spec = parseCampaignSpecV1(input);
  const blockers: OutreachReadinessBlocker[] = [];

  const goalReady = Boolean(spec.goal.goal && spec.goal.objective);
  if (!goalReady) blockers.push('GOAL_MISSING');

  const sponsorResolved = spec.sponsor.kind !== 'undecided' && sponsorScopeValid(spec);
  if (spec.sponsor.kind === 'undecided') blockers.push('SPONSOR_UNDECIDED');
  else if (!sponsorResolved) blockers.push('SPONSOR_SCOPE_INVALID');

  const targetCriteriaReady = spec.targeting.criteria !== null;
  if (!targetCriteriaReady) blockers.push('TARGET_CRITERIA_MISSING');

  const targetsReady = availability.targets && spec.targeting.selectedTargetRefs.length > 0;
  if (!availability.targets) blockers.push('TARGETS_NOT_IMPLEMENTED_YET');
  else if (!targetsReady) blockers.push('TARGETS_MISSING');

  const deliveryReady =
    spec.delivery.pattern !== 'undecided' && spec.delivery.personalization !== 'undecided';
  if (!deliveryReady) blockers.push('DELIVERY_UNDECIDED');

  const contextReady =
    availability.context &&
    (spec.context.requiredPolicyRefs.length > 0 ||
      spec.context.writingGuidanceRefs.length > 0 ||
      spec.context.campaignFactRefs.length > 0);
  if (!availability.context) blockers.push('CONTEXT_NOT_IMPLEMENTED_YET');
  else if (!contextReady) blockers.push('CONTEXT_NOT_REVIEWED');

  const strategyReady = Boolean(
    spec.strategy.campaignAngle && spec.strategy.tone && spec.strategy.length !== 'undecided',
  );
  if (!strategyReady) blockers.push('STRATEGY_INCOMPLETE');

  const stateReadyForGeneration =
    goalReady &&
    sponsorResolved &&
    targetCriteriaReady &&
    targetsReady &&
    deliveryReady &&
    contextReady &&
    strategyReady;

  const sampleGenerationEligible = stateReadyForGeneration && availability.generation;
  const fullGenerationEligible = stateReadyForGeneration && availability.generation;
  const sendReviewEligible =
    fullGenerationEligible && availability.drafts && availability.preflight;

  if (!availability.generation) blockers.push('GENERATION_NOT_AVAILABLE');
  if (!availability.drafts) blockers.push('DRAFTS_NOT_AVAILABLE');
  if (!availability.preflight) blockers.push('PREFLIGHT_NOT_AVAILABLE');

  return {
    goalReady,
    sponsorResolved,
    targetCriteriaReady,
    targetsReady,
    deliveryReady,
    contextReady,
    strategyReady,
    sampleGenerationEligible,
    fullGenerationEligible,
    sendReviewEligible,
    blockers,
  };
}
