import type { SkepticConfidence, SkepticVerdict } from '../grounding/skeptic';
import {
  EVIDENCE_OUTCOMES,
  type DecisionProviderMetadata,
  type EvidenceDecision,
  type EvidenceOutcome,
} from './decision-contract';

export interface SkepticDecisionMeta {
  provider: DecisionProviderMetadata;
  latencyMs: number;
  evidenceIds?: string[];
}

const CONFIDENCE_PROBABILITY: Record<SkepticConfidence, number> = {
  high: 0.9,
  medium: 0.7,
  low: 0.55,
};

function emptyProbabilities(): Record<EvidenceOutcome, number> {
  return Object.fromEntries(EVIDENCE_OUTCOMES.map((outcome) => [outcome, 0])) as Record<
    EvidenceOutcome,
    number
  >;
}

export function decisionFromSkepticVerdict(
  verdict: SkepticVerdict,
  meta: SkepticDecisionMeta,
): EvidenceDecision {
  const probabilities = emptyProbabilities();
  const probability = CONFIDENCE_PROBABILITY[verdict.confidence];
  const outcome: EvidenceOutcome = verdict.refuted ? 'contradicted' : 'insufficient_evidence';
  probabilities[outcome] = probability;
  probabilities.insufficient_evidence += 1 - probability;
  return {
    kind: 'outcome',
    outcome,
    probabilities,
    confidence: probability,
    reasonCodes: verdict.refuted ? ['legacy_refuted'] : ['legacy_not_refuted'],
    evidenceIds: meta.evidenceIds ?? [],
    provider: meta.provider,
    latencyMs: meta.latencyMs,
  };
}

export function skepticVerdictFromDecision(decision: EvidenceDecision): SkepticVerdict {
  const refuted = decision.kind === 'outcome' && decision.outcome === 'contradicted';
  const probability =
    decision.kind === 'outcome'
      ? decision.probabilities[refuted ? 'contradicted' : decision.outcome]
      : 0;
  const confidence: SkepticConfidence =
    probability >= 0.8 ? 'high' : probability >= 0.5 ? 'medium' : 'low';
  return {
    refuted,
    confidence,
    reason: decision.reasonCodes.join(', '),
  };
}
