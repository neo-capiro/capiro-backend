/**
 * Workstream J tests — risk and decision engine.
 */
import { computeRiskScoreV1 } from './risk-engine-v1.js';
import { computeDecisionV1 } from './decision-engine-v1.js';
import type { VerificationCheckV1 } from '../verification-contract-v1.js';
import type { VerificationPolicyV1 } from '../verification-policy-v1.js';
import type { ProofFindingV1 } from '../trusted-proof/trusted-proof-types.js';

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function makeCheck(overrides: Partial<VerificationCheckV1> = {}): VerificationCheckV1 {
  return {
    checkId: 'vc1_test',
    code: 'test_rule',
    ruleVersion: 'v1',
    outcome: 'PASS',
    required: true,
    blocking: false,
    riskPoints: 0,
    message: 'test',
    assertionIds: [],
    evidenceIds: [],
    referenceArtifactIds: [],
    ...overrides,
  };
}

function makePolicy(overrides: Partial<VerificationPolicyV1> = {}): VerificationPolicyV1 {
  return {
    policyVersion: 'defense_budget_verification_policy_v1',
    family: 'rdte',
    exhibit: 'R-1',
    requiredDataCategories: [],
    requiredFundingFields: [],
    requiredLineKinds: [],
    allowedParserMethods: [],
    minimumMoneyEvidenceGranularity: 'cell_bbox',
    pageOnlyMayPassWithIndependentReconciliation: false,
    requireImmutableArchive: false,
    requireParserRunProof: false,
    requiredComparisonRules: [],
    reviewComparisonRules: [],
    arithmeticRules: [],
    manualAlwaysReview: true,
    ocrMoneyAlwaysReview: true,
    congressionalMoneyAlwaysReviewWhenUncorroborated: true,
    enactedAlwaysReviewWhenUncorroborated: true,
    highMaterialityThresholdMillions: '0',
    riskThresholds: { automaticPassMax: 10, targetedReextractionMax: 30, paidVerifierMax: 60 },
    ...overrides,
  };
}

const noProofFindings: ProofFindingV1[] = [];

/* ------------------------------------------------------------------ */
/* Risk engine                                                          */
/* ------------------------------------------------------------------ */

describe('computeRiskScoreV1', () => {
  it('returns zero when all checks pass', () => {
    const result = computeRiskScoreV1({
      checks: [makeCheck({ outcome: 'PASS' }), makeCheck({ outcome: 'PASS' })],
      reviewDiscrepancyCount: 0,
      policy: makePolicy(),
    });
    expect(result.riskScore).toBe(0);
  });

  it('SKIPPED contributes zero', () => {
    const result = computeRiskScoreV1({
      checks: [makeCheck({ outcome: 'SKIPPED', riskPoints: 50 })],
      reviewDiscrepancyCount: 0,
      policy: makePolicy(),
    });
    expect(result.riskScore).toBe(0);
  });

  it('NOT_RUN required contributes uncertainty points', () => {
    const result = computeRiskScoreV1({
      checks: [makeCheck({ outcome: 'NOT_RUN', required: true, riskPoints: 10 })],
      reviewDiscrepancyCount: 0,
      policy: makePolicy(),
    });
    expect(result.riskScore).toBe(10);
    expect(result.requiredNotRunCount).toBe(1);
  });

  it('blocking FAIL may set score to 100', () => {
    const result = computeRiskScoreV1({
      checks: [makeCheck({ outcome: 'FAIL', blocking: true, riskPoints: 30 })],
      reviewDiscrepancyCount: 0,
      policy: makePolicy(),
    });
    expect(result.riskScore).toBe(100);
    expect(result.blockingFailCount).toBe(1);
  });

  it('is bounded at 100', () => {
    const result = computeRiskScoreV1({
      checks: [
        makeCheck({ outcome: 'FAIL', blocking: true, riskPoints: 50 }),
        makeCheck({ outcome: 'FAIL', blocking: true, riskPoints: 50 }),
        makeCheck({ outcome: 'FAIL', blocking: true, riskPoints: 50 }),
      ],
      reviewDiscrepancyCount: 20,
      policy: makePolicy(),
    });
    expect(result.riskScore).toBe(100);
  });

  it('review discrepancies contribute risk points', () => {
    const result = computeRiskScoreV1({
      checks: [],
      reviewDiscrepancyCount: 3,
      policy: makePolicy(),
    });
    expect(result.riskScore).toBe(15); // 3 * 5
  });
});

/* ------------------------------------------------------------------ */
/* Decision engine — precedence rules                                   */
/* ------------------------------------------------------------------ */

describe('computeDecisionV1 — J1 precedence', () => {
  it('J1.1: blocking FAIL -> REJECT', () => {
    const result = computeDecisionV1({
      checks: [makeCheck({ outcome: 'FAIL', blocking: true })],
      discrepancies: [],
      proofFindings: noProofFindings,
      policy: makePolicy(),
      hasManualParser: false,
      hasOcrParser: false,
      hasUncorroboratedCongressionalMoney: false,
      hasUncorroboratedEnacted: false,
    });
    expect(result.decision).toBe('REJECT');
    expect(result.status).toBe('REJECTED');
    expect(result.route).toBe('none');
  });

  it('J1.2: blocking proof finding -> REJECT', () => {
    const result = computeDecisionV1({
      checks: [makeCheck({ outcome: 'PASS' })],
      discrepancies: [],
      proofFindings: [{ code: 'source_sha_mismatch', severity: 'blocking', message: 'mismatch' }],
      policy: makePolicy(),
      hasManualParser: false,
      hasOcrParser: false,
      hasUncorroboratedCongressionalMoney: false,
      hasUncorroboratedEnacted: false,
    });
    expect(result.decision).toBe('REJECT');
  });

  it('J1.2: archive-only blocking finding + no archive required -> not REJECT (falls to review)', () => {
    const result = computeDecisionV1({
      checks: [makeCheck({ outcome: 'PASS' })],
      discrepancies: [],
      proofFindings: [{ code: 'archive_version_missing', severity: 'blocking', message: 'archive missing' }],
      policy: makePolicy({ requireImmutableArchive: false }),
      hasManualParser: false,
      hasOcrParser: false,
      hasUncorroboratedCongressionalMoney: false,
      hasUncorroboratedEnacted: false,
    });
    // Should not be REJECT since archive absence is reviewable when requireImmutableArchive=false
    expect(result.decision).not.toBe('REJECT');
  });

  it('J1.3: required NOT_RUN -> REVIEW', () => {
    const result = computeDecisionV1({
      checks: [makeCheck({ outcome: 'NOT_RUN', required: true })],
      discrepancies: [],
      proofFindings: noProofFindings,
      policy: makePolicy(),
      hasManualParser: false,
      hasOcrParser: false,
      hasUncorroboratedCongressionalMoney: false,
      hasUncorroboratedEnacted: false,
    });
    expect(result.decision).toBe('REVIEW');
    expect(result.status).toBe('NEEDS_REVIEW');
  });

  it('J1.4: review discrepancy -> REVIEW', () => {
    const result = computeDecisionV1({
      checks: [makeCheck({ outcome: 'PASS' })],
      discrepancies: [{ discrepancyId: 'vd1_1', code: 'test', severity: 'review', description: 'review finding', assertionIds: [], evidenceIds: [], referenceArtifactIds: [] }],
      proofFindings: noProofFindings,
      policy: makePolicy(),
      hasManualParser: false,
      hasOcrParser: false,
      hasUncorroboratedCongressionalMoney: false,
      hasUncorroboratedEnacted: false,
    });
    expect(result.decision).toBe('REVIEW');
  });

  it('J1.5: manual parser + policy.manualAlwaysReview -> REVIEW', () => {
    const result = computeDecisionV1({
      checks: [makeCheck({ outcome: 'PASS' })],
      discrepancies: [],
      proofFindings: noProofFindings,
      policy: makePolicy({ manualAlwaysReview: true }),
      hasManualParser: true,
      hasOcrParser: false,
      hasUncorroboratedCongressionalMoney: false,
      hasUncorroboratedEnacted: false,
    });
    expect(result.decision).toBe('REVIEW');
  });

  it('J1.6: all pass, no triggers -> PASS', () => {
    const result = computeDecisionV1({
      checks: [makeCheck({ outcome: 'PASS', required: true }), makeCheck({ outcome: 'PASS', required: true })],
      discrepancies: [],
      proofFindings: noProofFindings,
      policy: makePolicy(),
      hasManualParser: false,
      hasOcrParser: false,
      hasUncorroboratedCongressionalMoney: false,
      hasUncorroboratedEnacted: false,
    });
    expect(result.decision).toBe('PASS');
    expect(result.status).toBe('VERIFICATION_PASSED');
    expect(result.route).toBe('none');
  });

  it('J2: risk score never overrides blocking failure', () => {
    const result = computeDecisionV1({
      checks: [makeCheck({ outcome: 'FAIL', blocking: true, riskPoints: 1 })],
      discrepancies: [],
      proofFindings: noProofFindings,
      policy: makePolicy(),
      hasManualParser: false,
      hasOcrParser: false,
      hasUncorroboratedCongressionalMoney: false,
      hasUncorroboratedEnacted: false,
    });
    expect(result.decision).toBe('REJECT');
    expect(result.riskScore).toBe(100); // blocking failure sets score to 100
  });
});

/* ------------------------------------------------------------------ */
/* Decision engine — route determination (J3)                          */
/* ------------------------------------------------------------------ */

describe('computeDecisionV1 — J3 route', () => {
  it('REVIEW low risk -> targeted_local_reextraction', () => {
    const result = computeDecisionV1({
      checks: [makeCheck({ outcome: 'NOT_RUN', required: true, riskPoints: 5 })],
      discrepancies: [],
      proofFindings: noProofFindings,
      policy: makePolicy({ riskThresholds: { automaticPassMax: 10, targetedReextractionMax: 30, paidVerifierMax: 60 } }),
      hasManualParser: false,
      hasOcrParser: false,
      hasUncorroboratedCongressionalMoney: false,
      hasUncorroboratedEnacted: false,
    });
    expect(result.decision).toBe('REVIEW');
    expect(result.route).toBe('targeted_local_reextraction');
  });

  it('REVIEW high risk -> human_review', () => {
    // Use many NOT_RUN required checks to accumulate risk > paidVerifierMax
    const notRunChecks: VerificationCheckV1[] = Array.from({ length: 7 }, (_, i) =>
      makeCheck({ checkId: `vc1_${i}`, outcome: 'NOT_RUN', required: true, riskPoints: 10 }),
    );
    const result = computeDecisionV1({
      checks: notRunChecks,
      discrepancies: [],
      proofFindings: noProofFindings,
      policy: makePolicy({ riskThresholds: { automaticPassMax: 10, targetedReextractionMax: 30, paidVerifierMax: 60 } }),
      hasManualParser: false,
      hasOcrParser: false,
      hasUncorroboratedCongressionalMoney: false,
      hasUncorroboratedEnacted: false,
    });
    expect(result.decision).toBe('REVIEW');
    // 7 * 10 = 70 > 60 (paidVerifierMax) -> human_review
    expect(result.route).toBe('human_review');
  });
});

/* ------------------------------------------------------------------ */
/* Decision engine — stable ordering (J4)                              */
/* ------------------------------------------------------------------ */

describe('computeDecisionV1 — J4 stable ordering', () => {
  it('sorts accepted assertion IDs', () => {
    const result = computeDecisionV1({
      checks: [
        makeCheck({ outcome: 'PASS', assertionIds: ['c', 'a', 'b'] }),
        makeCheck({ outcome: 'PASS', assertionIds: ['z', 'y'] }),
      ],
      discrepancies: [],
      proofFindings: noProofFindings,
      policy: makePolicy(),
      hasManualParser: false,
      hasOcrParser: false,
      hasUncorroboratedCongressionalMoney: false,
      hasUncorroboratedEnacted: false,
    });
    expect(result.acceptedAssertionIds).toEqual(['a', 'b', 'c', 'y', 'z']);
  });

  it('rejected result exposes no accepted assertion IDs', () => {
    const result = computeDecisionV1({
      checks: [
        makeCheck({ outcome: 'PASS', assertionIds: ['a'] }),
        makeCheck({ outcome: 'FAIL', blocking: true, assertionIds: ['b'] }),
      ],
      discrepancies: [],
      proofFindings: noProofFindings,
      policy: makePolicy(),
      hasManualParser: false,
      hasOcrParser: false,
      hasUncorroboratedCongressionalMoney: false,
      hasUncorroboratedEnacted: false,
    });
    expect(result.decision).toBe('REJECT');
    expect(result.acceptedAssertionIds).toEqual([]);
  });
});
