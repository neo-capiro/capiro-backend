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
  return {
    exact: compareExactValues({ claim: input.claim.text, evidencePassages: passages }),
    freshness: aggregateFreshness(evaluations),
    houseSenateComplete: houseSenateComparisonComplete({ claimText: input.claim.text, evidence: passages }),
  };
}

/**
 * A claim is as fresh as its freshest supporting source. One current source
 * keeps the claim fresh; the claim is stale only when no source is fresh and the
 * freshest dated source is itself stale. Undated sources prove nothing either way.
 */
export function aggregateFreshness(evaluations: readonly FreshnessEvaluation[]): FreshnessEvaluation {
  const fresh = evaluations.filter((item) => item.state === 'fresh');
  if (fresh.length) return freshest(fresh);
  const stale = evaluations.filter((item) => item.state === 'stale');
  if (stale.length) return freshest(stale);
  return evaluations[0]
    ?? { state: 'unknown', ageDays: null, basis: 'none', reason: 'No evidence was provided.' };
}

function freshest(evaluations: readonly FreshnessEvaluation[]): FreshnessEvaluation {
  return [...evaluations].sort((a, b) => (a.ageDays ?? Number.POSITIVE_INFINITY) - (b.ageDays ?? Number.POSITIVE_INFINITY))[0]!;
}
