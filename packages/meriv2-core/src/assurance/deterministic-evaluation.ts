import type { AssuredClaim, AssuredEvidence } from './claim-ledger';
import type { EvidenceRequirement } from './evidence-plan';
import { compareExactValues, houseSenateComparisonComplete, type ExactComparison } from './exact-comparison';
import { evaluateFreshness, type FreshnessEvaluation } from './freshness';
import type { EvidencePassage } from '../jev/evidence-envelope';

export interface DeterministicClaimEvaluation {
  exact: ExactComparison;
  freshness: FreshnessEvaluation;
  houseSenateComplete: boolean;
}

/** Deterministic values and date policy run before any prose-support judge. */
export function evaluateClaimDeterministically(input: {
  claim: Pick<AssuredClaim, 'text' | 'category'>;
  evidence: ReadonlyArray<AssuredEvidence & { passage?: string }>;
  evidencePassages?: readonly (EvidencePassage | string)[];
  asOf: string;
  requirementFreshness?: EvidenceRequirement['freshness'];
}): DeterministicClaimEvaluation {
  const passages = input.evidencePassages
    ?? input.evidence.flatMap((item) => item.passage ? [item.passage] : []);
  const evaluations = input.evidence.map((evidence) => evaluateFreshness({
    category: input.claim.category,
    requirementFreshness: input.requirementFreshness,
    evidence,
    asOf: input.asOf,
  }));
  const freshness = evaluations.find((item) => item.state === 'stale')
    ?? evaluations.find((item) => item.state === 'fresh')
    ?? evaluations[0]
    ?? { state: 'unknown' as const, ageDays: null, basis: 'none' as const, reason: 'No evidence was provided.' };
  return {
    exact: compareExactValues({ claim: input.claim.text, evidencePassages: passages }),
    freshness,
    houseSenateComplete: houseSenateComparisonComplete({ claimText: input.claim.text, evidence: passages }),
  };
}
