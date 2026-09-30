import { describe, expect, it } from '@jest/globals';
import { bdTaskEvaluationFixtureSchema } from './bd-fixture-schema';

describe('bd fixture schema discipline', () => {
  it('accepts proposed-only fixture metadata and rejects approved status', () => {
    const valid = {
      version: 'bd_task_evaluation_fixture_v1',
      registryVersion: 'jev-task-registry.v5',
      cases: [
        {
          id: 'case-1',
          split: 'tuning',
          task: 'bd_entity',
          organizationA: { name: 'A' },
          organizationB: { name: 'B' },
          expectedOutcome: 'insufficient_evidence',
          rationale: 'shape-only placeholder',
          humanReview: { status: 'proposed', reviewer: null, reviewedAt: null },
        },
      ],
    };
    expect(() => bdTaskEvaluationFixtureSchema.parse(valid)).not.toThrow();
    const approved = {
      ...valid,
      cases: [
        {
          ...valid.cases[0]!,
          humanReview: { status: 'approved', reviewer: 'r', reviewedAt: '2026-09-25T00:00:00Z' },
        },
      ],
    };
    expect(() => bdTaskEvaluationFixtureSchema.parse(approved)).toThrow();
  });

  it('rejects unregistered expected outcomes', () => {
    const invalid = {
      version: 'bd_task_evaluation_fixture_v1',
      registryVersion: 'jev-task-registry.v5',
      cases: [
        {
          id: 'case-1',
          split: 'heldout',
          task: 'bd_signal',
          companyName: 'A',
          signalRecordType: 'award',
          expectedOutcome: 'maybe',
          rationale: 'x',
          humanReview: { status: 'proposed', reviewer: null, reviewedAt: null },
        },
      ],
    };
    expect(() => bdTaskEvaluationFixtureSchema.parse(invalid)).toThrow();
  });
});
