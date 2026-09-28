import { hashEvidenceContent } from '../../grounding/evidence';
import type { EvidenceOperationalState } from '../decision-contract';
import type { JevTask } from '../jev-config';
import type { JevChoiceTaskDecision } from '../task-choice-provider';
import { JEV_TASK_REGISTRY, JEV_TASK_REGISTRY_VERSION } from '../task-registry';

export interface JevTaskEvaluationCase {
  id: string;
  task: JevTask;
  category: string;
  expected:
    { kind: 'outcome'; outcome: string } | { kind: 'failure'; state: EvidenceOperationalState };
  humanReview: { status: 'proposed' | 'approved' };
}

export interface JevTaskPrice {
  version: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

export type JevTaskEvaluationProvider = (
  item: JevTaskEvaluationCase,
) => Promise<JevChoiceTaskDecision>;

function decisionIdentity(decision: JevChoiceTaskDecision): string {
  return decision.kind === 'outcome' ? `outcome:${decision.outcome}` : `failure:${decision.state}`;
}

function matchesExpected(item: JevTaskEvaluationCase, decision: JevChoiceTaskDecision): boolean {
  return item.expected.kind === 'outcome'
    ? decision.kind === 'outcome' && decision.outcome === item.expected.outcome
    : decision.kind === 'failure' && decision.state === item.expected.state;
}

function percentile(values: readonly number[], fraction: number): number {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[
    Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1))
  ]!;
}

export async function runJevTaskPairedEvaluation(input: {
  cases: readonly JevTaskEvaluationCase[];
  providers: { jev: JevTaskEvaluationProvider; baseline: JevTaskEvaluationProvider };
  prices?: Partial<Record<'jev' | 'baseline', JevTaskPrice>>;
}) {
  const results: Array<
    JevTaskEvaluationCase & {
      jev: JevChoiceTaskDecision;
      baseline: JevChoiceTaskDecision;
      agreement: boolean;
      jevMatchesExpected: boolean;
      baselineMatchesExpected: boolean;
    }
  > = [];
  for (const item of input.cases) {
    const [jev, baseline] = await Promise.all([
      input.providers.jev(item),
      input.providers.baseline(item),
    ]);
    if (jev.task !== item.task || baseline.task !== item.task) {
      throw new Error(`task evaluation provider identity mismatch for ${item.id}`);
    }
    results.push({
      ...item,
      jev,
      baseline,
      agreement: decisionIdentity(jev) === decisionIdentity(baseline),
      jevMatchesExpected: matchesExpected(item, jev),
      baselineMatchesExpected: matchesExpected(item, baseline),
    });
  }

  const perTask = Object.fromEntries(
    [...new Set(input.cases.map((item) => item.task))].sort().map((task) => {
      const taskRows = results.filter((row) => row.task === task);
      const registration = JEV_TASK_REGISTRY[task];
      const providerMetrics = (provider: 'jev' | 'baseline') => {
        const decisions = taskRows.map((row) => row[provider]);
        const inputTokens = decisions.reduce(
          (sum, decision) =>
            sum + (decision.kind === 'outcome' ? (decision.usage?.inputTokens ?? 0) : 0),
          0,
        );
        const outputTokens = decisions.reduce(
          (sum, decision) =>
            sum + (decision.kind === 'outcome' ? (decision.usage?.outputTokens ?? 0) : 0),
          0,
        );
        const price = input.prices?.[provider];
        const estimatedCostUsd = price
          ? (inputTokens * price.inputUsdPerMillion + outputTokens * price.outputUsdPerMillion) /
            1_000_000
          : null;
        const overBudgetCases = decisions.filter(
          (decision) =>
            decision.kind === 'outcome' &&
            ((decision.usage?.inputTokens ?? 0) > registration.costBudget.maxInputTokens ||
              (decision.usage?.outputTokens ?? 0) > registration.costBudget.maxOutputTokens),
        ).length;
        return {
          calls: decisions.length,
          matchedExpected: taskRows.filter((row) =>
            provider === 'jev' ? row.jevMatchesExpected : row.baselineMatchesExpected,
          ).length,
          outcomes: decisions.filter((decision) => decision.kind === 'outcome').length,
          abstentions: decisions.filter(
            (decision) => decision.kind === 'outcome' && decision.action === 'abstain',
          ).length,
          failures: decisions.filter((decision) => decision.kind === 'failure').length,
          operationalStates: decisions.reduce<Record<string, number>>((counts, decision) => {
            if (decision.kind === 'failure')
              counts[decision.state] = (counts[decision.state] ?? 0) + 1;
            return counts;
          }, {}),
          inputTokens,
          outputTokens,
          latencyMs: {
            total: decisions.reduce((sum, decision) => sum + decision.latencyMs, 0),
            p50: percentile(
              decisions.map((decision) => decision.latencyMs),
              0.5,
            ),
            p95: percentile(
              decisions.map((decision) => decision.latencyMs),
              0.95,
            ),
          },
          priceVersion: price?.version ?? null,
          estimatedCostUsd,
          costBudget: registration.costBudget,
          overBudgetCases,
        };
      };
      return [
        task,
        {
          cases: taskRows.length,
          approvedLabels: taskRows.filter((row) => row.humanReview.status === 'approved').length,
          proposedLabels: taskRows.filter((row) => row.humanReview.status === 'proposed').length,
          agreement: taskRows.filter((row) => row.agreement).length,
          providers: { jev: providerMetrics('jev'), baseline: providerMetrics('baseline') },
        },
      ];
    }),
  );
  const output = {
    registryVersion: JEV_TASK_REGISTRY_VERSION,
    totalCases: results.length,
    results,
    perTask,
  };
  return { ...output, hash: hashEvidenceContent(output) };
}
