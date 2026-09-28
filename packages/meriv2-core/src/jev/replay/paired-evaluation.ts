import { hashEvidenceContent } from '../../grounding/evidence';
import { runSkeptic, type SkepticJudge } from '../../grounding/skeptic';
import { CLAIM_SUPPORT_QUESTION_VERSION } from '../claim-support-question';
import {
  decisionFromSkepticVerdict,
  LEGACY_SKEPTIC_ADAPTER_V1,
  type LegacySkepticAdapterVersion,
} from '../skeptic-adapter';
import type {
  DecisionProvider,
  EvidenceDecision,
  EvidenceEnvelope,
  EvidenceOutcome,
  EvidenceQuestion,
} from '../decision-contract';

export interface PairedEvaluationCase {
  id: string;
  category: string;
  claimKind: string;
  expectedOutcome: EvidenceOutcome;
  humanReview: { status: string };
  envelope: EvidenceEnvelope;
}

interface PairedResult {
  id: string;
  category: string;
  claimKind: string;
  expectedOutcome: EvidenceOutcome;
  humanReviewStatus: string;
  jev: EvidenceDecision;
  legacy: EvidenceDecision;
  agreement: boolean;
  jevMatchesExpected: boolean;
  legacyMatchesExpected: boolean;
}

export function createSkepticDecisionProvider(
  judge: SkepticJudge,
  model = 'deterministic-stub',
  adapterVersion: LegacySkepticAdapterVersion = LEGACY_SKEPTIC_ADAPTER_V1,
): DecisionProvider {
  return {
    name: 'legacy-skeptic',
    available: () => true,
    async assess(envelope) {
      const started = Date.now();
      const verdict = await runSkeptic(
        {
          claim: envelope.claimText,
          evidence: envelope.sources.map((source) => source.passage).join('\n'),
        },
        judge,
      );
      return decisionFromSkepticVerdict(verdict, {
        provider: {
          name: 'legacy-skeptic',
          model,
          questionVersion: CLAIM_SUPPORT_QUESTION_VERSION,
        },
        latencyMs: Math.max(0, Date.now() - started),
        evidenceIds: envelope.sources.map((source) => source.evidenceId),
        hasBoundEvidence: envelope.sources.some((source) => source.passage.trim().length > 0),
        adapterVersion,
      });
    },
  };
}

function resultKind(decision: EvidenceDecision): string {
  return decision.kind === 'outcome' ? decision.outcome : `failure:${decision.state}`;
}

export async function runPairedEvaluation(input: {
  cases: readonly PairedEvaluationCase[];
  providers: { jev: DecisionProvider; legacy: DecisionProvider };
  question: (envelope: EvidenceEnvelope) => EvidenceQuestion;
}) {
  const results: PairedResult[] = [];
  for (const item of input.cases) {
    const question = input.question(item.envelope);
    const [jev, legacy] = await Promise.all([
      input.providers.jev.assess(item.envelope, question),
      input.providers.legacy.assess(item.envelope, question),
    ]);
    results.push({
      id: item.id,
      category: item.category,
      claimKind: item.claimKind,
      expectedOutcome: item.expectedOutcome,
      humanReviewStatus: item.humanReview.status,
      jev,
      legacy,
      agreement: resultKind(jev) === resultKind(legacy),
      jevMatchesExpected: jev.kind === 'outcome' && jev.outcome === item.expectedOutcome,
      legacyMatchesExpected: legacy.kind === 'outcome' && legacy.outcome === item.expectedOutcome,
    });
  }
  const dimensions = (provider: 'jev' | 'legacy', field: 'category' | 'claimKind') =>
    Object.fromEntries(
      [...new Set(results.map((r) => r[field]))].sort().map((value) => [
        value,
        results
          .filter((r) => r[field] === value)
          .reduce(
            (counts, row) => {
              const decision = row[provider];
              if (decision.kind === 'failure') counts.failure += 1;
              else if (decision.outcome === row.expectedOutcome) counts.correct += 1;
              else counts.incorrect += 1;
              return counts;
            },
            { correct: 0, incorrect: 0, failure: 0 },
          ),
      ]),
    );
  const summary = {
    totalCases: results.length,
    byCategory: { jev: dimensions('jev', 'category'), legacy: dimensions('legacy', 'category') },
    byClaimKind: { jev: dimensions('jev', 'claimKind'), legacy: dimensions('legacy', 'claimKind') },
    agreementMatrix: results.reduce<Record<string, number>>((matrix, row) => {
      const key = `${resultKind(row.jev)}|${resultKind(row.legacy)}`;
      matrix[key] = (matrix[key] ?? 0) + 1;
      return matrix;
    }, {}),
    totalInputTokens: results.reduce(
      (sum, row) =>
        sum +
        (row.jev.kind === 'outcome' ? (row.jev.usage?.inputTokens ?? 0) : 0) +
        (row.legacy.kind === 'outcome' ? (row.legacy.usage?.inputTokens ?? 0) : 0),
      0,
    ),
  };
  const output = {
    results,
    summary: { ...summary, estimatedCostUsd: (summary.totalInputTokens * 0.042) / 1_000_000 },
  };
  return { ...output, hash: hashEvidenceContent(output) };
}
