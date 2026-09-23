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
  /** Whether at least one evidence id is bound to a non-empty passage. */
  hasBoundEvidence?: boolean;
  adapterVersion?: LegacySkepticAdapterVersion;
}

export const LEGACY_SKEPTIC_ADAPTER_V1 = 'legacy-skeptic-adapter.v1' as const;
export const LEGACY_SKEPTIC_BASELINE_ADAPTER_VERSION = 'legacy-skeptic-adapter.v2' as const;
export type LegacySkepticAdapterVersion =
  | typeof LEGACY_SKEPTIC_ADAPTER_V1
  | typeof LEGACY_SKEPTIC_BASELINE_ADAPTER_VERSION;

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
  const couldNotConfirm = verdict.refuted
    && meta.adapterVersion === LEGACY_SKEPTIC_BASELINE_ADAPTER_VERSION
    && meta.hasBoundEvidence === false;
  const outcome: EvidenceOutcome = verdict.refuted && !couldNotConfirm
    ? 'contradicted'
    : 'insufficient_evidence';
  probabilities[outcome] = probability;
  probabilities.insufficient_evidence += 1 - probability;
  return {
    kind: 'outcome',
    outcome,
    probabilities,
    confidence: probability,
    reasonCodes: couldNotConfirm
      ? ['legacy_could_not_confirm']
      : verdict.refuted ? ['legacy_refuted'] : ['legacy_not_refuted'],
    evidenceIds: meta.evidenceIds ?? [],
    provider: meta.provider,
    latencyMs: meta.latencyMs,
    ...(verdict.usage ? { usage: verdict.usage } : {}),
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
