import { describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import { runJevPackage9Economics } from './package9-economics';

function evidence(jevCost = 60) {
  const cases = [1, 2, 3, 4].map((n) => ({
    id: `case-${n}`,
    jev: {
      completed: true,
      correct: true,
      covered: true,
      cost: { modelUsd: jevCost / 4, humanReviewUsd: 0, rescueUsd: 0 },
    },
    baseline: {
      completed: true,
      correct: true,
      covered: true,
      cost: { modelUsd: 25, humanReviewUsd: 0, rescueUsd: 0 },
    },
  }));
  return {
    version: 'jev_package9_economics_v1',
    evaluationSet: {
      id: 'heldout-1',
      version: '1',
      contentHash: createHash('sha256').update(JSON.stringify(cases)).digest('hex'),
      status: 'approved',
      frozen: true,
      independentAdjudication: { status: 'complete', recordId: 'adjudication-record-1' },
    },
    priceSchedule: {
      id: 'approved-schedule',
      version: 'v4',
      status: 'approved',
      currency: 'USD',
      approvalRecordId: 'price-approval-1',
      contentHash: 'a'.repeat(64),
    },
    cases,
  };
}

describe('Package 9 Jev matched-work economics qualification', () => {
  it('qualifies only maintained quality and at least 30% all-in savings on approved evidence', () => {
    const input = evidence();
    const result = runJevPackage9Economics(input);
    expect(result.decision).toBe('GO');
    expect(result.totalCostReduction).toBe(0.4);
    expect(runJevPackage9Economics(input).hash).toBe(result.hash);
  });

  it('fails closed for proposed, unpriced, and unreviewed evidence', () => {
    const input = evidence();
    input.evaluationSet.status = 'proposed';
    input.evaluationSet.frozen = false;
    input.evaluationSet.independentAdjudication.status = 'proposed';
    input.priceSchedule.status = 'proposed';
    input.cases[0]!.jev.cost.humanReviewUsd = 100;
    const result = runJevPackage9Economics(input);
    expect(result.decision).toBe('NO_GO');
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        'evaluation_set_not_approved',
        'evaluation_set_not_frozen',
        'independent_adjudication_incomplete',
        'price_schedule_not_approved',
        'total_cost_reduction_below_30_percent',
      ]),
    );
  });

  it('counts human review and rescue costs and rejects degraded accuracy or coverage', () => {
    const input = evidence(20);
    input.cases[0]!.jev.cost.humanReviewUsd = 15;
    input.cases[1]!.jev.cost.rescueUsd = 15;
    input.cases[0]!.jev.correct = false;
    input.cases[1]!.jev.covered = false;
    input.evaluationSet.contentHash = createHash('sha256')
      .update(JSON.stringify(input.cases))
      .digest('hex');
    const result = runJevPackage9Economics(input);
    expect(result.jev.costs).toMatchObject({ humanReviewUsd: 15, rescueUsd: 15, totalUsd: 50 });
    expect(result.decision).toBe('NO_GO');
    expect(result.blockers).toEqual(
      expect.arrayContaining(['accuracy_not_maintained', 'coverage_not_maintained']),
    );
  });

  it('includes every assigned case in completion and coverage gates', () => {
    const input = evidence(20);
    input.cases[0]!.jev.completed = false;
    input.cases[0]!.jev.covered = false;
    input.evaluationSet.contentHash = createHash('sha256')
      .update(JSON.stringify(input.cases))
      .digest('hex');
    const result = runJevPackage9Economics(input);
    expect(result.jev.completionRate).toBe(0.75);
    expect(result.jev.coverage).toBe(0.75);
    expect(result.decision).toBe('NO_GO');
    expect(result.blockers).toEqual(
      expect.arrayContaining(['completion_rate_not_maintained', 'coverage_not_maintained']),
    );
  });
});
