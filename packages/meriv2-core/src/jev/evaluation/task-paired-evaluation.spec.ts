import { describe, expect, it } from '@jest/globals';
import type { JevChoiceTaskDecision } from '../task-choice-provider';
import { runJevTaskPairedEvaluation, type JevTaskEvaluationCase } from './task-paired-evaluation';

const cases: JevTaskEvaluationCase[] = [
  {
    id: 'alias',
    task: 'program_identity',
    category: 'ambiguous_alias',
    expected: { kind: 'outcome', outcome: 'insufficient_evidence' },
    humanReview: { status: 'proposed' },
  },
  {
    id: 'timeout',
    task: 'program_identity',
    category: 'provider_timeout',
    expected: { kind: 'failure', state: 'timeout' },
    humanReview: { status: 'proposed' },
  },
];

function decision(item: JevTaskEvaluationCase): JevChoiceTaskDecision {
  if (item.expected.kind === 'failure')
    return {
      kind: 'failure',
      task: item.task,
      state: item.expected.state,
      reasonCodes: [item.expected.state],
      provider: { name: 'fixture', model: 'jev-1.13.0', questionVersion: 'program_identity.v1' },
      latencyMs: 8,
    };
  return {
    kind: 'outcome',
    task: item.task,
    outcome: item.expected.outcome,
    probabilities: { [item.expected.outcome]: 1 },
    confidence: 1,
    action: 'abstain',
    reasonCodes: [],
    evidenceIds: [],
    provider: { name: 'fixture', model: 'jev-1.13.0', questionVersion: 'program_identity.v1' },
    latencyMs: 4,
    usage: { inputTokens: 100, outputTokens: 10 },
  };
}

describe('task paired evaluation', () => {
  it('is deterministic and reports task-specific cost and operational failures', async () => {
    const input = {
      cases,
      providers: {
        jev: async (item: JevTaskEvaluationCase) => decision(item),
        baseline: async (item: JevTaskEvaluationCase) => decision(item),
      },
      prices: {
        jev: { version: 'test-price.v1', inputUsdPerMillion: 10, outputUsdPerMillion: 20 },
      },
    };
    const first = await runJevTaskPairedEvaluation(input);
    expect((await runJevTaskPairedEvaluation(input)).hash).toBe(first.hash);
    expect(first.perTask.program_identity).toMatchObject({
      cases: 2,
      proposedLabels: 2,
      providers: {
        jev: {
          calls: 2,
          matchedExpected: 2,
          failures: 1,
          operationalStates: { timeout: 1 },
          inputTokens: 100,
          outputTokens: 10,
          priceVersion: 'test-price.v1',
          estimatedCostUsd: 0.0012,
        },
        baseline: { estimatedCostUsd: null },
      },
    });
  });
});
