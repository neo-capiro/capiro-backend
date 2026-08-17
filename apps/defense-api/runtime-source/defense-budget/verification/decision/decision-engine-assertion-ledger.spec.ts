import { describe, expect, it } from '@jest/globals';
import type {
  VerificationCheckV1,
  VerificationDiscrepancyV1,
} from '../verification-contract-v1.js';
import type { VerificationPolicyV1 } from '../verification-policy-v1.js';
import { computeDecisionV1 } from './decision-engine-v1.js';

const policy = {
  requireImmutableArchive: false,
  manualAlwaysReview: false,
  ocrMoneyAlwaysReview: false,
  congressionalMoneyAlwaysReviewWhenUncorroborated: false,
  enactedAlwaysReviewWhenUncorroborated: false,
  riskThresholds: {
    automaticPassMax: 0,
    targetedReextractionMax: 25,
    paidVerifierMax: 60,
  },
} as unknown as VerificationPolicyV1;

function check(
  code: string,
  outcome: VerificationCheckV1['outcome'],
  assertionIds: string[],
): VerificationCheckV1 {
  return {
    checkId: `check-${code}`,
    code,
    ruleVersion: 'audit-v1',
    outcome,
    required: true,
    blocking: outcome === 'FAIL',
    riskPoints: outcome === 'FAIL' ? 50 : 10,
    message: code,
    assertionIds,
    evidenceIds: [],
    referenceArtifactIds: [],
  };
}

describe('Phase 2 assertion outcome ledger', () => {
  it('does not accept an assertion that also has a required NOT_RUN control', () => {
    const result = computeDecisionV1({
      checks: [
        check('identity_validation', 'PASS', ['assertion-a']),
        check('required_comparison', 'NOT_RUN', ['assertion-a']),
      ],
      discrepancies: [],
      proofFindings: [],
      policy,
      hasManualParser: false,
      hasOcrParser: false,
      hasUncorroboratedCongressionalMoney: false,
      hasUncorroboratedEnacted: false,
    });

    expect(result.decision).toBe('REVIEW');
    expect(result.acceptedAssertionIds).not.toContain('assertion-a');
  });

  it('does not accept an assertion carrying a review discrepancy', () => {
    const discrepancies: VerificationDiscrepancyV1[] = [
      {
        discrepancyId: 'discrepancy-review',
        code: 'page_only_review',
        severity: 'review',
        description: 'requires review',
        assertionIds: ['assertion-a'],
        evidenceIds: [],
        referenceArtifactIds: [],
      },
    ];
    const result = computeDecisionV1({
      checks: [check('identity_validation', 'PASS', ['assertion-a'])],
      discrepancies,
      proofFindings: [],
      policy,
      hasManualParser: false,
      hasOcrParser: false,
      hasUncorroboratedCongressionalMoney: false,
      hasUncorroboratedEnacted: false,
    });

    expect(result.decision).toBe('REVIEW');
    expect(result.acceptedAssertionIds).toEqual([]);
  });

  it('accepts a clean assertion only after all applicable controls pass', () => {
    const result = computeDecisionV1({
      checks: [
        check('identity_validation', 'PASS', ['assertion-a']),
        check('required_comparison', 'PASS', ['assertion-a']),
      ],
      discrepancies: [],
      proofFindings: [],
      policy,
      hasManualParser: false,
      hasOcrParser: false,
      hasUncorroboratedCongressionalMoney: false,
      hasUncorroboratedEnacted: false,
    });

    expect(result.decision).toBe('PASS');
    expect(result.acceptedAssertionIds).toEqual(['assertion-a']);
  });
});
