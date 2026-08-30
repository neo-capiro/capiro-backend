import {
  evaluateR1ReviewAcceptanceEligibilityV1,
  ALLOWED_IRREDUCIBLE_OMISSION_CLASS_V1,
} from './rdte-r1-review-acceptance-eligibility-v1.js';
import type { ReadCheckV1, ReadDiscrepancyV1 } from '../verification/persistence/verification-repository.js';

function passingCheck(code: string, overrides: Partial<ReadCheckV1> = {}): ReadCheckV1 {
  return {
    checkId: `chk-${code}`,
    code,
    ruleVersion: 'v1',
    outcome: 'PASS',
    required: true,
    blocking: true,
    riskPoints: 0,
    message: 'ok',
    assertionIds: [],
    evidenceIds: [],
    referenceArtifactIds: [],
    ...overrides,
  };
}

const REQUIRED_CODES = [
  'identity_validation',
  'numeric_validation',
  'r1_specific',
  'duplicate_detection',
  'warning_policy',
  'money_evidence_policy',
  'page_only_reconciliation',
  'rdte_summary_detail',
];

function allPassingChecks(): ReadCheckV1[] {
  return REQUIRED_CODES.map((c) => passingCheck(c));
}

function omissionDiscrepancy(overrides: Partial<ReadDiscrepancyV1> = {}): ReadDiscrepancyV1 {
  return {
    discrepancyId: 'disc-1',
    code: 'review_omission',
    severity: 'review',
    description:
      'review omission for source fact "sf1": R-1 omission: 3 trailing numeric tokens (need 4 or 5 for a confident column mapping) -- ambiguous, not guessed at page 56: 54 1201017SF Global Sensor Integrated on Network (GSIN) 07 U 4,574 5,321 5,321',
    assertionIds: [],
    evidenceIds: [],
    referenceArtifactIds: [],
    ...overrides,
  };
}

describe('evaluateR1ReviewAcceptanceEligibilityV1', () => {
  test('all required checks PASS + only allowed irreducible omissions -> eligible', () => {
    const result = evaluateR1ReviewAcceptanceEligibilityV1({
      runDecision: 'REVIEW',
      checks: allPassingChecks(),
      discrepancies: [omissionDiscrepancy()],
    });
    expect(result.eligible).toBe(true);
    expect(result.refusalReasons).toHaveLength(0);
    expect(result.allowedIrreducibleDiscrepancyIds).toEqual(['disc-1']);
  });

  test('recognizes the 4-token collapse-identity-violation omission shape too', () => {
    const result = evaluateR1ReviewAcceptanceEligibilityV1({
      runDecision: 'REVIEW',
      checks: allPassingChecks(),
      discrepancies: [
        omissionDiscrepancy({
          description:
            'review omission for source fact "sf2": R-1 omission: 4 trailing numeric tokens but Enacted (12,010) != Total Enacted (13,010) -- the proven zero-supplemental collapse identity does not hold, so column alignment for this row is not trustworthy at page 10',
        }),
      ],
    });
    expect(result.eligible).toBe(true);
  });

  test('a non-REVIEW run decision is ineligible', () => {
    const result = evaluateR1ReviewAcceptanceEligibilityV1({
      runDecision: 'PASS',
      checks: allPassingChecks(),
      discrepancies: [],
    });
    expect(result.eligible).toBe(false);
    expect(result.refusalReasons.some((r) => r.includes('REVIEW'))).toBe(true);
  });

  test.each(REQUIRED_CODES)('required check "%s" not PASS -> ineligible', (code) => {
    const checks = allPassingChecks().map((c) => (c.code === code ? { ...c, outcome: 'NOT_RUN' } : c));
    const result = evaluateR1ReviewAcceptanceEligibilityV1({
      runDecision: 'REVIEW',
      checks,
      discrepancies: [],
    });
    expect(result.eligible).toBe(false);
    expect(result.refusalReasons.some((r) => r.includes(code))).toBe(true);
  });

  test('rdte_summary_detail NOT_RUN and not required -> does not block eligibility on its own', () => {
    const checks = allPassingChecks().map((c) =>
      c.code === 'rdte_summary_detail' ? { ...c, outcome: 'NOT_RUN', required: false } : c,
    );
    const result = evaluateR1ReviewAcceptanceEligibilityV1({
      runDecision: 'REVIEW',
      checks,
      discrepancies: [],
    });
    expect(result.eligible).toBe(true);
  });

  test('any FAIL check makes it ineligible, even one not in the required list', () => {
    const checks = [...allPassingChecks(), passingCheck('contract_integrity', { outcome: 'FAIL' })];
    const result = evaluateR1ReviewAcceptanceEligibilityV1({
      runDecision: 'REVIEW',
      checks,
      discrepancies: [],
    });
    expect(result.eligible).toBe(false);
  });

  test('an unrecognized review-severity discrepancy fails closed -- never a generic accept-any-REVIEW bypass', () => {
    const result = evaluateR1ReviewAcceptanceEligibilityV1({
      runDecision: 'REVIEW',
      checks: allPassingChecks(),
      discrepancies: [omissionDiscrepancy({ discrepancyId: 'disc-unknown', description: 'some brand new review condition never seen before' })],
    });
    expect(result.eligible).toBe(false);
    expect(result.unrecognizedDiscrepancyIds).toEqual(['disc-unknown']);
    expect(result.refusalReasons.some((r) => r.includes(ALLOWED_IRREDUCIBLE_OMISSION_CLASS_V1))).toBe(
      true,
    );
  });

  test('an unrecognized blocking-severity discrepancy also fails closed', () => {
    const result = evaluateR1ReviewAcceptanceEligibilityV1({
      runDecision: 'REVIEW',
      checks: allPassingChecks(),
      discrepancies: [
        omissionDiscrepancy({ discrepancyId: 'disc-blk', severity: 'blocking', description: 'some other real issue' }),
      ],
    });
    expect(result.eligible).toBe(false);
  });

  test('informational-severity discrepancies are ignored entirely', () => {
    const result = evaluateR1ReviewAcceptanceEligibilityV1({
      runDecision: 'REVIEW',
      checks: allPassingChecks(),
      discrepancies: [omissionDiscrepancy({ severity: 'informational', description: 'fyi only' })],
    });
    expect(result.eligible).toBe(true);
  });

  test('missing required check entirely -> ineligible', () => {
    const checks = allPassingChecks().filter((c) => c.code !== 'r1_specific');
    const result = evaluateR1ReviewAcceptanceEligibilityV1({
      runDecision: 'REVIEW',
      checks,
      discrepancies: [],
    });
    expect(result.eligible).toBe(false);
  });
});
