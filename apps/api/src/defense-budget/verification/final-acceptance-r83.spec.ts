import { computeDecisionV1 } from './decision/decision-engine-v1.js';
import { lookupPolicyForManifestDocument } from './authority-policy-resolution.js';

const policy = lookupPolicyForManifestDocument({
  documentKey: 'r3_fy2027',
  family: 'rdte',
  exhibit: 'R-3',
  authority: 'dod-comptroller',
  documentType: 'r3',
} as never)!;

function check(
  code: string,
  outcome: 'PASS' | 'FAIL' | 'NOT_RUN' | 'SKIPPED',
  overrides: Record<string, unknown> = {},
) {
  return {
    checkId: `check-${code}`,
    code,
    ruleVersion: 'defense_budget_verification_rule_v1',
    outcome,
    required: true,
    blocking: true,
    riskPoints: outcome === 'PASS' ? 0 : 25,
    message: code,
    assertionIds: ['assertion-1'],
    evidenceIds: ['evidence-1'],
    referenceArtifactIds: [],
    ...overrides,
  } as never;
}

function decide(overrides: Record<string, unknown> = {}) {
  return computeDecisionV1({
    checks: [
      check('contract_integrity', 'PASS'),
      check('manifest_binding', 'PASS'),
      check('archive_proof', 'PASS'),
      check('parser_run_proof', 'PASS'),
      check('page_only_reconciliation', 'SKIPPED', {
        required: false,
        blocking: false,
      }),
    ],
    discrepancies: [],
    proofFindings: [],
    policy,
    hasManualParser: false,
    hasOcrParser: false,
    hasUncorroboratedCongressionalMoney: false,
    hasUncorroboratedEnacted: false,
    ...overrides,
  } as never);
}

describe('Phase 2 R8.3 final decision acceptance', () => {
  it('returns exact PASS only when every required control passes', () => {
    const result = decide();
    expect(result.decision).toBe('PASS');
    expect(result.status).toBe('VERIFICATION_PASSED');
    expect(result.route).toBe('none');
    expect(result.requiredNotRunCount).toBe(0);
    expect(result.blockingFailCount).toBe(0);
  });

  it('returns exact REVIEW for required unresolved reconciliation', () => {
    const result = decide({
      checks: [
        check('contract_integrity', 'PASS'),
        check('page_only_reconciliation', 'NOT_RUN'),
      ],
    });
    expect(result.decision).toBe('REVIEW');
    expect(result.status).toBe('NEEDS_REVIEW');
  });

  it('returns exact REJECT for blocking parser-output corruption', () => {
    const result = decide({
      checks: [check('parser_run_proof', 'FAIL')],
      proofFindings: [
        {
          code: 'parse_output_sha_mismatch',
          severity: 'blocking',
          message: 'parser output mismatch',
        },
      ],
    });
    expect(result.decision).toBe('REJECT');
    expect(result.status).toBe('REJECTED');
    expect(result.route).toBe('none');
  });
});
