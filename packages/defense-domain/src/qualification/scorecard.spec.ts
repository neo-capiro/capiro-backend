import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildQualificationScorecard, wilsonLowerBound, type QualificationEvidence } from './scorecard.js';

const passing: QualificationEvidence = {
  financialCorrectness: { reviewed: true, sampleCount: 1000, incorrectCount: 0 },
  semanticAccuracy: { reviewed: true, truePositives: 1000, falsePositives: 0, falseNegatives: 0, abstentions: 0 },
  moneyAttribution: { reviewed: true, attributedAmount: 1000, expectedAmount: 1000 },
  coverage: { reviewed: true, coveredUnits: 100, requiredUnits: 100, denominatorComplete: true },
  lifecycle: { reviewed: true, requiredStages: 5, completedStages: 5 },
  annualReuse: { reviewed: true, demonstratedFiscalYears: 2 },
  reliability: { reviewed: true, availabilityPercent: 99.9, criticalIncidents: 0 },
  economics: { reviewed: true, savingsPercent: 30, qualityMaintained: true, coverageMaintained: true },
  userOutcome: { reviewed: true, medianTimeReductionPercent: 30, completionRateMaintained: true, criticalErrorRateNoHigher: true },
  ownership: { reviewed: true, accountableOwner: 'team@example.test', accepted: true },
  rollback: { reviewed: true, tested: true, recoveryTargetMinutes: 15 },
};

describe('Package 9 qualification scorecard', () => {
  it('passes only when every reviewed gate meets its threshold and remains shadow-only', () => {
    const result = buildQualificationScorecard(passing);
    assert.equal(result.status, 'PASS');
    assert.equal(result.activation, 'shadow_only');
    assert.deepEqual(result.reasons, []);
  });

  it('fails missing, null and unreviewed evidence with explicit reasons', () => {
    const result = buildQualificationScorecard({
      ...passing,
      annualReuse: null,
      reliability: { reviewed: false, availabilityPercent: 100, criticalIncidents: 0 },
      rollback: undefined,
    });
    assert.equal(result.status, 'NO_GO');
    assert.ok(result.gates.annualReuse.reasons.includes('evidence_missing'));
    assert.ok(result.gates.reliability.reasons.includes('evidence_unreviewed'));
    assert.ok(result.gates.rollback.reasons.includes('evidence_missing'));
  });

  it('uses sample-supported 95% Wilson lower bounds for precision and recall', () => {
    const insufficient = buildQualificationScorecard({ ...passing,
      semanticAccuracy: { reviewed: true, truePositives: 100, falsePositives: 0, falseNegatives: 0, abstentions: 0 },
    });
    assert.equal(insufficient.gates.semanticAccuracy.status, 'NO_GO');
    assert.ok(insufficient.gates.semanticAccuracy.reasons.includes('precision_95_ci_lower_below_99_percent_or_sample_missing'));
    const lower = wilsonLowerBound(1000, 1000);
    assert.ok(lower !== null && lower > 0.99);
  });

  it('reports abstentions and counts them against recall', () => {
    const result = buildQualificationScorecard({ ...passing,
      semanticAccuracy: { reviewed: true, truePositives: 1000, falsePositives: 0, falseNegatives: 0, abstentions: 1 },
    });
    assert.equal(result.gates.semanticAccuracy.status, 'PASS');
    assert.equal(result.gates.semanticAccuracy.metrics?.abstentions, 1);
    assert.ok((result.gates.semanticAccuracy.metrics?.recall ?? 1) < 1);
  });

  it('fails economic and user thresholds, incomplete coverage, attribution mismatch, and critical incidents', () => {
    const result = buildQualificationScorecard({ ...passing,
      moneyAttribution: { reviewed: true, attributedAmount: 999, expectedAmount: 1000 },
      coverage: { reviewed: true, coveredUnits: 99, requiredUnits: 100, denominatorComplete: true },
      reliability: { reviewed: true, availabilityPercent: 99.9, criticalIncidents: 1 },
      economics: { reviewed: true, savingsPercent: 29.9, qualityMaintained: true, coverageMaintained: true },
      userOutcome: { reviewed: true, medianTimeReductionPercent: 30, completionRateMaintained: false, criticalErrorRateNoHigher: true },
    });
    assert.equal(result.status, 'NO_GO');
    assert.ok(result.gates.moneyAttribution.reasons.includes('money_attribution_mismatch'));
    assert.ok(result.gates.coverage.reasons.includes('required_coverage_incomplete'));
    assert.ok(result.gates.reliability.reasons.includes('critical_reliability_incidents'));
    assert.ok(result.gates.economics.reasons.includes('jeV_savings_below_30_percent_or_invalid'));
    assert.ok(result.gates.userOutcome.reasons.includes('completion_rate_not_maintained'));
  });
});
