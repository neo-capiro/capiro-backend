import type { AssuredEvidence } from '../assurance/claim-ledger';

export const MATCH_LABELS = [
  'explicit_linkage',
  'conditional_linkage',
  'capability_class_alignment',
  'adjacency',
  'insufficient_evidence',
] as const;
export type MatchLabel = (typeof MATCH_LABELS)[number];
export type AssertedMatchTier = 'direct_match' | 'conditional_niche' | 'adjacency';

export interface MatchEligibility {
  mandatoryRequirementsKnown: boolean;
  mandatoryRequirementsSatisfied: boolean;
}

export type MandatoryEligibilityStatus = 'unknown' | 'satisfied' | 'failed';

export type MatchLabelReason =
  | 'jev_agrees_explicit_linkage'
  | 'jev_does_not_confirm_explicit_linkage'
  | 'missing_opportunity_authority'
  | 'missing_client_capability_authority'
  | 'mandatory_eligibility_failed'
  | 'historical_award_only'
  | 'conditional_relationship_established'
  | 'capability_class_only'
  | 'thematic_relevance_only'
  | 'no_supporting_evidence';

export interface DeriveMatchLabelInput {
  assertedTier: AssertedMatchTier;
  jevCategory?: MatchLabel | null;
  jevConfidence?: number | null;
  evidence: AssuredEvidence[];
  eligibility: MatchEligibility;
}

export interface DerivedMatchLabel {
  label: MatchLabel;
  eligibility: MandatoryEligibilityStatus;
  downgraded: boolean;
  reasons: MatchLabelReason[];
}

const RANK: Readonly<Record<MatchLabel, number>> = {
  insufficient_evidence: 0,
  adjacency: 1,
  capability_class_alignment: 2,
  conditional_linkage: 3,
  explicit_linkage: 4,
};
const ASSERTED_LABEL: Readonly<Record<AssertedMatchTier, MatchLabel>> = {
  direct_match: 'explicit_linkage',
  conditional_niche: 'conditional_linkage',
  adjacency: 'adjacency',
};

function isHistoricalAward(evidence: AssuredEvidence): boolean {
  return evidence.sourceType.toLowerCase().includes('award') &&
    !evidence.sourceType.toLowerCase().includes('opportunit');
}

function isOpportunityEvidence(evidence: AssuredEvidence): boolean {
  const value = `${evidence.sourceType} ${evidence.title ?? ''}`.toLowerCase();
  return /opportunit|solicitation|forecast|grant|notice|rfp|rfi/.test(value) && !isHistoricalAward(evidence);
}

function isClientCapabilityEvidence(evidence: AssuredEvidence): boolean {
  const value = `${evidence.sourceType} ${evidence.title ?? ''}`.toLowerCase();
  return /client|document|context|capabil|profile|website|web/.test(value);
}

function authoritativeResolved(evidence: AssuredEvidence): boolean {
  return evidence.authoritative && Boolean(evidence.sourceId.trim());
}

function capAt(label: MatchLabel, cap: MatchLabel): MatchLabel {
  return RANK[label] > RANK[cap] ? cap : label;
}

export function deriveMatchLabel(input: DeriveMatchLabelInput): DerivedMatchLabel {
  const eligibility: MandatoryEligibilityStatus = !input.eligibility.mandatoryRequirementsKnown
    ? 'unknown'
    : input.eligibility.mandatoryRequirementsSatisfied ? 'satisfied' : 'failed';
  const asserted = ASSERTED_LABEL[input.assertedTier];
  const authoritative = input.evidence.filter(authoritativeResolved);
  const opportunity = authoritative.some(isOpportunityEvidence);
  const clientCapability = authoritative.some(isClientCapabilityEvidence);
  const nonAward = authoritative.some((evidence) => !isHistoricalAward(evidence));
  const historicalAwardOnly = input.evidence.length > 0 && input.evidence.every(isHistoricalAward);
  const jev = input.jevCategory ?? null;
  const jevUsable = jev !== null && Number.isFinite(input.jevConfidence ?? 0) && (input.jevConfidence ?? 0) >= 0.5;
  const reasons: MatchLabelReason[] = [];

  if (!input.evidence.length || (!authoritative.length && (!jevUsable || jev === 'insufficient_evidence'))) {
    return { label: 'insufficient_evidence', eligibility, downgraded: RANK[asserted] > 0, reasons: ['no_supporting_evidence'] };
  }

  let label = jevUsable && jev ? jev : asserted;
  label = capAt(label, asserted);

  if (label === 'explicit_linkage') {
    if (!opportunity) reasons.push('missing_opportunity_authority');
    if (!clientCapability) reasons.push('missing_client_capability_authority');
    if (!jevUsable || jev !== 'explicit_linkage') reasons.push('jev_does_not_confirm_explicit_linkage');
    if (!opportunity || !clientCapability || !jevUsable || jev !== 'explicit_linkage') {
      label = opportunity || clientCapability ? 'conditional_linkage' : 'capability_class_alignment';
    } else {
      reasons.push('jev_agrees_explicit_linkage');
    }
  }

  if (historicalAwardOnly) {
    label = capAt(label, 'capability_class_alignment');
    reasons.push('historical_award_only');
  }
  if (input.eligibility.mandatoryRequirementsKnown && !input.eligibility.mandatoryRequirementsSatisfied) {
    label = capAt(label, 'conditional_linkage');
    reasons.push('mandatory_eligibility_failed');
  }
  if (!nonAward && label === 'adjacency') reasons.push('thematic_relevance_only');
  if (label === 'conditional_linkage' && !reasons.includes('mandatory_eligibility_failed')) {
    reasons.push('conditional_relationship_established');
  }
  if (label === 'capability_class_alignment' && !reasons.includes('historical_award_only')) {
    reasons.push('capability_class_only');
  }
  if (label === 'adjacency' && !reasons.includes('thematic_relevance_only')) {
    reasons.push('thematic_relevance_only');
  }
  if (label === 'insufficient_evidence') reasons.push('no_supporting_evidence');

  return { label, eligibility, downgraded: RANK[label] < RANK[asserted], reasons: [...new Set(reasons)] };
}

export const MATCH_LABEL_DISPLAY: Readonly<Record<MatchLabel, string>> = {
  explicit_linkage: 'Direct match',
  conditional_linkage: 'Conditional niche',
  capability_class_alignment: 'Capability class alignment',
  adjacency: 'Adjacency',
  insufficient_evidence: 'Insufficient evidence',
};

export function establishedRelationshipSentence(result: DerivedMatchLabel): string {
  if (result.label === 'explicit_linkage') return 'The cited evidence establishes the specific capability-to-need linkage.';
  if (result.label === 'conditional_linkage') return 'The evidence supports a conditional relationship, subject to the named qualification or eligibility requirement.';
  if (result.label === 'capability_class_alignment') return 'The evidence establishes capability-class alignment, but not a specific capability-to-need linkage.';
  if (result.label === 'adjacency') return 'The evidence establishes thematic relevance only.';
  return 'The cited evidence does not establish a match tier.';
}
