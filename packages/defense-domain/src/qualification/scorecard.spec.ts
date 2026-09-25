import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildQualificationScorecard,
  wilsonLowerBound,
  type QualificationEvidence,
} from './scorecard.js';

const RELEASE = 'a'.repeat(40);
const binding = {
  reviewed: true as const,
  evidenceRecordId: 'evidence-record-1',
  reviewerId: 'independent-reviewer-1',
  reviewedAt: '2026-09-25T00:00:00.000Z',
  releaseRevision: RELEASE,
};

const passing: QualificationEvidence = {
  qualificationManifest: {
    id: 'manifest-1',
    contentHash: 'b'.repeat(64),
    releaseRevision: RELEASE,
    approvalRecordId: 'manifest-approval-1',
    approvedBy: 'release-authority-1',
    expectedMarketedFamilies: ['rdte'],
    expectedMandatorySourceIds: ['source-1'],
  },
  financialCorrectness: {
    ...binding,
    displayedFactCount: 1_000,
    criticalErrorCount: 0,
    factsWithCompleteLineage: 1_000,
  },
  semanticAccuracy: {
    ...binding,
    families: [
      {
        family: 'rdte',
        candidateTruePositives: 1_000,
        candidateFalseNegatives: 0,
        truePositives: 1_000,
        falsePositives: 0,
        falseNegatives: 0,
        abstentions: 0,
      },
    ],
  },
  moneyAttribution: {
    ...binding,
    inferredAuthoritativeAllocationCount: 0,
    exactAllocatedAmount: 1_000,
    sourceAllocatedAmount: 1_000,
    unexplainedResidualsVisible: true,
  },
  coverage: {
    ...binding,
    denominatorComplete: true,
    qualifiedMandatorySourceIds: ['source-1'],
    families: [
      { family: 'rdte', eligibleUnits: 100, qualifiedPublishedUnits: 95, supported: true },
    ],
  },
  lifecycle: { ...binding, requiredScenarios: 6, passedScenarios: 6 },
  annualReuse: {
    ...binding,
    historicalCycles: 2,
    simulatedNextCycle: true,
    yearSpecificCodeEdits: 0,
    duplicateIdentities: 0,
    lostHistoryRecords: 0,
  },
  reliability: {
    ...binding,
    requiredFailureScenarios: 8,
    passedFailureScenarios: 8,
    lostAcceptedFacts: 0,
    duplicateLogicalNotifications: 0,
    peakPendingRows: 100,
    peakDeadLetterRows: 0,
    oldestPendingAgeMinutes: 1,
    maxConcurrentDrainTasks: 4,
    verifiedProgramUpdateP95Minutes: 1,
    commonQueryP95Milliseconds: 100,
  },
  economics: {
    ...binding,
    savingsPercent: 30,
    qualityMaintained: true,
    coverageMaintained: true,
    independentlyAdjudicated: true,
    approvedPriceSchedule: true,
    adjudicationRecordId: 'economics-adjudication-1',
    priceScheduleApprovalRecordId: 'price-approval-1',
    economicsRunId: 'economics-run-1',
  },
  userOutcome: {
    ...binding,
    medianTimeReductionPercent: 30,
    completionRateMaintained: true,
    criticalErrorRateNoHigher: true,
    allAssignedTasksIncluded: true,
    abstentionsRescuesTimeoutsReported: true,
    p95TimeReported: true,
    independentlyAdjudicated: true,
    assignedWorkflows: 6,
    completedWorkflows: 6,
    minimumCasesPerWorkflow: 30,
    criticalErrors: 0,
    adjudicationRecordId: 'buyer-adjudication-1',
    benchmarkManifestId: 'buyer-benchmark-1',
  },
  ownership: {
    ...binding,
    sourceAdapterOwnersComplete: true,
    ingestionPublicationOwner: 'ingestion lead',
    legislativeDeliveryOwner: 'legislative lead',
    modelEconomicsOwner: 'model/evaluation lead',
    accepted: true,
    acceptanceRecordId: 'owner-acceptance-1',
  },
  rollback: {
    ...binding,
    tested: true,
    preservesImmutableEvidence: true,
    recoveryTargetMinutes: 15,
    rehearsalRecordId: 'rollback-rehearsal-1',
  },
  costBudgets: {
    ...binding,
    incrementalAwsAnnualProjectedUsd: 900,
    paidProviderAnnualProjectedUsd: 0,
    paidProviderAuthorizedUsd: 0,
    paidRunManifestId: null,
  },
  activationControls: {
    ...binding,
    taskScope: 'program_identity',
    familyScope: 'rdte',
    tenantScope: 'qualification-tenant',
    frozenQuestionModelPolicy: true,
    shadowBeforeCanary: true,
    evaluationRunManifestId: 'evaluation-run-1',
    releaseAuthorizationRecordId: 'release-authorization-1',
  },
};

describe('Package 9 qualification scorecard', () => {
  it('allows only a bounded canary when every bound, reviewed gate meets the declared threshold', () => {
    const result = buildQualificationScorecard(passing);
    assert.equal(result.status, 'PASS');
    assert.equal(result.activation, 'bounded_canary');
    assert.deepEqual(result.reasons, []);
  });

  it('fails missing, null and unreviewed evidence closed in shadow-only mode', () => {
    const result = buildQualificationScorecard({
      ...passing,
      annualReuse: null,
      reliability: { reviewed: false },
      rollback: undefined,
    });
    assert.equal(result.status, 'NO_GO');
    assert.equal(result.activation, 'shadow_only');
    assert.ok(result.gates.annualReuse.reasons.includes('evidence_missing'));
    assert.ok(result.gates.reliability.reasons.includes('evidence_unreviewed'));
    assert.ok(result.gates.rollback.reasons.includes('evidence_missing'));
  });

  it('uses sample-supported 95% Wilson lower bounds for final and candidate recall', () => {
    const insufficient = buildQualificationScorecard({
      ...passing,
      semanticAccuracy: {
        ...binding,
        families: [
          {
            family: 'rdte',
            candidateTruePositives: 50,
            candidateFalseNegatives: 0,
            truePositives: 100,
            falsePositives: 0,
            falseNegatives: 0,
            abstentions: 0,
          },
        ],
      },
    });
    assert.equal(insufficient.gates.semanticAccuracy.status, 'NO_GO');
    assert.ok(
      insufficient.gates.semanticAccuracy.reasons.includes(
        'rdte:precision_95_ci_lower_below_99_percent_or_sample_missing',
      ),
    );
    assert.ok(
      insufficient.gates.semanticAccuracy.reasons.includes(
        'rdte:candidate_recall_95_ci_lower_below_95_percent_or_sample_missing',
      ),
    );
    const lower = wilsonLowerBound(1_000, 1_000);
    assert.ok(lower !== null && lower > 0.99);
  });

  it('rejects omitted manifest cohorts and incomplete family coverage', () => {
    const result = buildQualificationScorecard({
      ...passing,
      qualificationManifest: {
        ...passing.qualificationManifest!,
        expectedMarketedFamilies: ['rdte', 'procurement'],
        expectedMandatorySourceIds: ['source-1', 'source-2'],
      },
      semanticAccuracy: {
        ...binding,
        families: [
          {
            family: 'rdte',
            candidateTruePositives: 1_000,
            candidateFalseNegatives: 0,
            truePositives: 1_000,
            falsePositives: 0,
            falseNegatives: 0,
            abstentions: 100,
          },
        ],
      },
      coverage: {
        ...binding,
        denominatorComplete: true,
        qualifiedMandatorySourceIds: ['source-1'],
        families: [
          { family: 'rdte', eligibleUnits: 100, qualifiedPublishedUnits: 94, supported: true },
        ],
      },
    });
    assert.equal(result.gates.semanticAccuracy.status, 'NO_GO');
    assert.equal(result.gates.semanticAccuracy.metrics?.['rdte.abstentions'], 100);
    assert.ok(
      result.gates.semanticAccuracy.reasons.includes(
        'semantic_family_scope_does_not_match_manifest',
      ),
    );
    assert.ok(
      result.gates.coverage.reasons.includes('mandatory_available_sources_not_all_qualified'),
    );
    assert.ok(
      result.gates.coverage.reasons.includes('coverage_family_scope_does_not_match_manifest'),
    );
  });

  it('rejects unbound evidence, over-budget cost, missing authorization, and excluded buyer work', () => {
    const result = buildQualificationScorecard({
      ...passing,
      moneyAttribution: {
        reviewed: true,
        inferredAuthoritativeAllocationCount: 1,
        exactAllocatedAmount: 999,
        sourceAllocatedAmount: 1_000,
        unexplainedResidualsVisible: false,
      },
      reliability: {
        ...passing.reliability!,
        passedFailureScenarios: 4,
        duplicateLogicalNotifications: 1,
      },
      economics: {
        ...passing.economics!,
        independentlyAdjudicated: false,
        approvedPriceSchedule: false,
      },
      userOutcome: { ...passing.userOutcome!, allAssignedTasksIncluded: false },
      costBudgets: {
        ...binding,
        incrementalAwsAnnualProjectedUsd: 1_001,
        paidProviderAnnualProjectedUsd: 1,
        paidProviderAuthorizedUsd: 0,
        paidRunManifestId: null,
      },
      activationControls: { ...passing.activationControls!, releaseAuthorizationRecordId: null },
    });
    assert.equal(result.status, 'NO_GO');
    assert.ok(result.gates.moneyAttribution.reasons.includes('evidence_record_id_missing'));
    assert.ok(result.gates.reliability.reasons.includes('failure_recovery_scenarios_incomplete'));
    assert.ok(result.gates.economics.reasons.includes('economics_not_independently_adjudicated'));
    assert.ok(result.gates.userOutcome.reasons.includes('assigned_tasks_excluded'));
    assert.ok(
      result.gates.costBudgets.reasons.includes('incremental_aws_annual_cost_over_1000_or_unknown'),
    );
    assert.ok(result.gates.activationControls.reasons.includes('release_authorization_missing'));
  });
});
