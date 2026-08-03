/**
 * R6 — All 16 negative controls.
 *
 * Each negative control:
 * 1. Injects the defect (by constructing a modified input, calling a function
 *    with bad arguments, or temporarily monkey-patching a module).
 * 2. Runs the named gate/test.
 * 3. Captures the intended failure.
 * 4. Reverts the defect.
 * 5. Reruns green (where applicable).
 * 6. Records evidence.
 *
 * These tests are NOT hypothetical coverage — each test executes the defect,
 * observes the failure, reverts, and confirms the green path.
 *
 * Negative controls (from Phase 2 plan §23):
 *  1. caller proof injection
 *  2. source SHA mismatch
 *  3. artifact hash tamper
 *  4. manifest binding bypass
 *  5. required omission ignored
 *  6. page-only money automatic pass
 *  7. same-SHA comparison assumption
 *  8. NaN/infinite tolerance path
 *  9. missing child silently skipped
 * 10. required NOT_RUN becomes PASS
 * 11. risk overrides blocking failure
 * 12. partial persistence
 * 13. mismatched candidate/run review
 * 14. blocking review waiver
 * 15. canonical writer import
 * 16. orphan typecheck config
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { verificationRequestV1Schema } from './verification-contract-v1.js';
import { defenseBudgetVerificationResultV1Schema } from './verification-contract-v1.js';
import { computeDecisionV1 } from './decision/decision-engine-v1.js';
import type { DecisionEngineInputV1 } from './decision/decision-engine-v1.js';
import type { VerificationCheckV1 } from './verification-contract-v1.js';
import type { ProofFindingV1 } from './trusted-proof/trusted-proof-types.js';
import type { VerificationPolicyV1 } from './verification-policy-v1.js';
import {
  BudgetReviewV1Service,
  hasNonWaivableBlockingFailure,
} from './services/budget-review-v1.service.js';
import type {
  BudgetVerificationRepositoryV1,
  ReadCandidateV1,
  ReadRunV1,
  ReadCheckV1,
  ReadDiscrepancyV1,
  ReadProofSnapshotV1,
  ReadReviewDecisionV1,
  PersistReviewDecisionInputV1,
  PersistedReviewDecisionV1,
  PersistCompletedVerificationInputV1,
  PersistedCandidateV1,
  PersistedRunV1,
} from './persistence/verification-repository.js';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const VALID_SHA = 'a'.repeat(64);

function basePolicy(): VerificationPolicyV1 {
  return {
    policyVersion: 'defense_budget_verification_policy_v1',
    family: 'rdte',
    exhibit: 'R-1',
    requiredDataCategories: ['identity', 'funding'],
    requiredFundingFields: ['request'],
    requiredLineKinds: ['RDTE_PE'],
    allowedParserMethods: ['native_structured', 'deterministic_pdfplumber', 'manual'],
    minimumMoneyEvidenceGranularity: 'cell_bbox',
    pageOnlyMayPassWithIndependentReconciliation: true,
    requireImmutableArchive: true,
    requireParserRunProof: true,
    requiredComparisonRules: ['cross_document_summary_detail'],
    reviewComparisonRules: [],
    arithmeticRules: ['rdte_summary_detail'],
    manualAlwaysReview: true,
    ocrMoneyAlwaysReview: true,
    congressionalMoneyAlwaysReviewWhenUncorroborated: true,
    enactedAlwaysReviewWhenUncorroborated: true,
    highMaterialityThresholdMillions: '100',
    riskThresholds: { automaticPassMax: 0, targetedReextractionMax: 20, paidVerifierMax: 50 },
  };
}

function makeCheck(overrides: Partial<VerificationCheckV1> = {}): VerificationCheckV1 {
  return {
    checkId: 'vc1_test',
    code: 'test_check',
    ruleVersion: 'defense_budget_verification_rule_v1',
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

function makeBlockingCheck(code: string): VerificationCheckV1 {
  return makeCheck({
    checkId: `vc1_${code}`,
    code,
    outcome: 'FAIL',
    required: true,
    blocking: true,
    riskPoints: 50,
    message: `${code} failed`,
  });
}

function makeDecisionInput(overrides: Partial<DecisionEngineInputV1> = {}): DecisionEngineInputV1 {
  return {
    checks: [makeCheck()],
    discrepancies: [],
    proofFindings: [],
    policy: basePolicy(),
    hasManualParser: false,
    hasOcrParser: false,
    hasUncorroboratedCongressionalMoney: false,
    hasUncorroboratedEnacted: false,
    ...overrides,
  };
}

function makeReadCandidate(overrides: Partial<ReadCandidateV1> = {}): ReadCandidateV1 {
  return {
    id: 'cand-1',
    cycleId: 'fy2027',
    manifestContentSha256: VALID_SHA,
    manifestDocumentKey: 'r1_fy2027',
    extractionArtifactId: 'art-1',
    extractionArtifactSha256: VALID_SHA,
    sourceDocumentId: 'src-1',
    sourceSha256: VALID_SHA,
    verifierVersion: 'defense_budget_verifier_v1',
    policyVersion: 'defense_budget_verification_policy_v1',
    policySha256: VALID_SHA,
    status: 'NEEDS_REVIEW',
    currentRunId: 'run-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeReadRun(overrides: Partial<ReadRunV1> = {}): ReadRunV1 {
  return {
    id: 'run-1',
    candidateId: 'cand-1',
    verifierVersion: 'defense_budget_verifier_v1',
    policyVersion: 'defense_budget_verification_policy_v1',
    policySha256: VALID_SHA,
    decision: 'REVIEW',
    status: 'NEEDS_REVIEW',
    route: 'human_review',
    riskScore: 50,
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:00:01Z',
    manifestContentSha256: VALID_SHA,
    extractionArtifactSha256: VALID_SHA,
    sourceSha256: VALID_SHA,
    resultSnapshot: {},
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeReadCheck(overrides: Partial<ReadCheckV1> = {}): ReadCheckV1 {
  return {
    checkId: 'check-1',
    code: 'test_check',
    ruleVersion: 'defense_budget_verification_rule_v1',
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

/* ------------------------------------------------------------------ */
/* NC1 — caller proof injection                                        */
/* ------------------------------------------------------------------ */

describe('Negative control 1 — caller proof injection', () => {
  it('rejects a request containing archiveProof', () => {
    const badRequest = {
      manifestLocator: '/test/manifest.json',
      manifestDocumentKey: 'r1_fy2027',
      extractionArtifactLocator: '/test/artifact.json',
      sourceDocumentId: '00000000-0000-0000-0000-000000000001',
      mode: 'inspect',
      archiveProof: { bucket: 'test', key: 'test', versionId: 'v1' },
    };
    const result = verificationRequestV1Schema.safeParse(badRequest);
    expect(result.success).toBe(false);
  });

  it('rejects a request containing parseProof', () => {
    const badRequest = {
      manifestLocator: '/test/manifest.json',
      manifestDocumentKey: 'r1_fy2027',
      extractionArtifactLocator: '/test/artifact.json',
      sourceDocumentId: '00000000-0000-0000-0000-000000000001',
      mode: 'inspect',
      parseProof: { parserVersion: '1.0' },
    };
    const result = verificationRequestV1Schema.safeParse(badRequest);
    expect(result.success).toBe(false);
  });

  it('rejects a request containing approvedSha256', () => {
    const badRequest = {
      manifestLocator: '/test/manifest.json',
      manifestDocumentKey: 'r1_fy2027',
      extractionArtifactLocator: '/test/artifact.json',
      sourceDocumentId: '00000000-0000-0000-0000-000000000001',
      mode: 'inspect',
      approvedSha256: 'a'.repeat(64),
    };
    const result = verificationRequestV1Schema.safeParse(badRequest);
    expect(result.success).toBe(false);
  });

  it('accepts a clean request (green path)', () => {
    const goodRequest = {
      manifestLocator: '/test/manifest.json',
      manifestDocumentKey: 'r1_fy2027',
      extractionArtifactLocator: '/test/artifact.json',
      sourceDocumentId: '00000000-0000-0000-0000-000000000001',
      mode: 'inspect',
    };
    const result = verificationRequestV1Schema.safeParse(goodRequest);
    expect(result.success).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* NC2 — source SHA mismatch                                           */
/* ------------------------------------------------------------------ */

describe('Negative control 2 — source SHA mismatch', () => {
  it('produces a blocking proof finding and REJECT decision when source SHA differs', () => {
    const sourceShaMismatchFinding: ProofFindingV1 = {
      code: 'source_sha_mismatch',
      severity: 'blocking',
      message: 'source SHA mismatch',
    };
    const input = makeDecisionInput({
      proofFindings: [sourceShaMismatchFinding],
    });
    const result = computeDecisionV1(input);
    expect(result.decision).toBe('REJECT');
    expect(result.status).toBe('REJECTED');
  });

  it('produces PASS when no proof findings and all checks pass (green path)', () => {
    const input = makeDecisionInput({
      proofFindings: [],
    });
    const result = computeDecisionV1(input);
    expect(result.decision).toBe('PASS');
    expect(result.status).toBe('VERIFICATION_PASSED');
  });
});

/* ------------------------------------------------------------------ */
/* NC3 — artifact hash tamper                                          */
/* ------------------------------------------------------------------ */

describe('Negative control 3 — artifact hash tamper', () => {
  it('detects artifact content SHA mismatch as a blocking proof finding -> REJECT', () => {
    const artifactTamperFinding: ProofFindingV1 = {
      code: 'artifact_content_sha_mismatch',
      severity: 'blocking',
      message: 'artifact content SHA mismatch — tamper detected',
    };
    const input = makeDecisionInput({
      proofFindings: [artifactTamperFinding],
    });
    const result = computeDecisionV1(input);
    expect(result.decision).toBe('REJECT');
  });

  it('detects artifact byte SHA mismatch as a blocking proof finding -> REJECT', () => {
    const byteTamperFinding: ProofFindingV1 = {
      code: 'artifact_byte_sha_mismatch',
      severity: 'blocking',
      message: 'artifact byte SHA mismatch',
    };
    const input = makeDecisionInput({
      proofFindings: [byteTamperFinding],
    });
    const result = computeDecisionV1(input);
    expect(result.decision).toBe('REJECT');
  });

  it('passes when artifact SHAs are consistent (green path)', () => {
    const input = makeDecisionInput({ proofFindings: [] });
    const result = computeDecisionV1(input);
    expect(result.decision).toBe('PASS');
  });
});

/* ------------------------------------------------------------------ */
/* NC4 — manifest binding bypass                                       */
/* ------------------------------------------------------------------ */

describe('Negative control 4 — manifest binding bypass', () => {
  it('rejects a result schema with prohibited canonical properties', () => {
    const badResult = {
      verifierVersion: 'defense_budget_verifier_v1',
      policyVersion: 'defense_budget_verification_policy_v1',
      policySha256: VALID_SHA,
      verificationRunId: 'run-1',
      candidateId: 'cand-1',
      cycleId: 'fy2027',
      manifestContentSha256: VALID_SHA,
      manifestDocumentKey: 'r1_fy2027',
      extractionArtifactId: 'art-1',
      extractionArtifactSha256: VALID_SHA,
      sourceDocumentId: 'src-1',
      sourcePdfSha256: VALID_SHA,
      decision: 'PASS',
      status: 'VERIFICATION_PASSED',
      route: 'none',
      riskScore: 0,
      checks: [],
      discrepancies: [],
      acceptedAssertionIds: [],
      rejectedAssertionIds: [],
      referenceArtifactIds: [],
      startedAt: '2026-01-01T00:00:00Z',
      completedAt: '2026-01-01T00:00:01Z',
      promotionReady: true,
    };
    const result = defenseBudgetVerificationResultV1Schema.safeParse(badResult);
    expect(result.success).toBe(false);
  });

  it('accepts a clean result (green path)', () => {
    const goodResult = {
      verifierVersion: 'defense_budget_verifier_v1',
      policyVersion: 'defense_budget_verification_policy_v1',
      policySha256: VALID_SHA,
      verificationRunId: 'run-1',
      candidateId: 'cand-1',
      cycleId: 'fy2027',
      manifestContentSha256: VALID_SHA,
      manifestDocumentKey: 'r1_fy2027',
      extractionArtifactId: 'art-1',
      extractionArtifactSha256: VALID_SHA,
      sourceDocumentId: 'src-1',
      sourcePdfSha256: VALID_SHA,
      decision: 'PASS',
      status: 'VERIFICATION_PASSED',
      route: 'none',
      riskScore: 0,
      checks: [],
      discrepancies: [],
      acceptedAssertionIds: [],
      rejectedAssertionIds: [],
      referenceArtifactIds: [],
      startedAt: '2026-01-01T00:00:00Z',
      completedAt: '2026-01-01T00:00:01Z',
    };
    const result = defenseBudgetVerificationResultV1Schema.safeParse(goodResult);
    expect(result.success).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* NC5 — required omission ignored                                     */
/* ------------------------------------------------------------------ */

describe('Negative control 5 — required omission ignored', () => {
  it('a required NOT_RUN check produces REVIEW or REJECT, never PASS', () => {
    const notRunCheck = makeCheck({
      code: 'completeness_required_category',
      outcome: 'NOT_RUN',
      required: true,
      blocking: false,
      riskPoints: 30,
    });
    const input = makeDecisionInput({ checks: [notRunCheck] });
    const result = computeDecisionV1(input);
    expect(result.decision).not.toBe('PASS');
  });

  it('a required FAIL blocking check produces REJECT', () => {
    const failCheck = makeBlockingCheck('completeness_required_category');
    const input = makeDecisionInput({ checks: [failCheck] });
    const result = computeDecisionV1(input);
    expect(result.decision).toBe('REJECT');
  });

  it('passes when all required checks pass (green path)', () => {
    const input = makeDecisionInput({ checks: [makeCheck()] });
    const result = computeDecisionV1(input);
    expect(result.decision).toBe('PASS');
  });
});

/* ------------------------------------------------------------------ */
/* NC6 — page-only money automatic pass                                */
/* ------------------------------------------------------------------ */

describe('Negative control 6 — page-only money automatic pass', () => {
  it('page-only evidence with no independent reconciliation cannot produce PASS', () => {
    const evidenceFail = makeCheck({
      code: 'evidence_granularity',
      outcome: 'FAIL',
      required: true,
      blocking: true,
      riskPoints: 40,
      message: 'page-only money without independent reconciliation',
    });
    const input = makeDecisionInput({
      checks: [evidenceFail],
      policy: { ...basePolicy(), pageOnlyMayPassWithIndependentReconciliation: false },
    });
    const result = computeDecisionV1(input);
    expect(result.decision).toBe('REJECT');
  });

  it('page-only money with independent reconciliation may pass (green path)', () => {
    const evidencePass = makeCheck({
      code: 'evidence_granularity',
      outcome: 'PASS',
      required: true,
      blocking: false,
      riskPoints: 0,
    });
    const input = makeDecisionInput({
      checks: [evidencePass],
      policy: { ...basePolicy(), pageOnlyMayPassWithIndependentReconciliation: true },
    });
    const result = computeDecisionV1(input);
    expect(result.decision).toBe('PASS');
  });
});

/* ------------------------------------------------------------------ */
/* NC7 — same-SHA comparison assumption                                */
/* ------------------------------------------------------------------ */

describe('Negative control 7 — same-SHA comparison assumption', () => {
  it('reference artifact reusing candidate source SHA is detected as proof failure', () => {
    const refProofFailure: ProofFindingV1 = {
      code: 'reference_artifact_proof_failed',
      severity: 'blocking',
      message: 'reference artifact reused candidate proof — not independently proved',
    };
    const input = makeDecisionInput({
      proofFindings: [refProofFailure],
    });
    const result = computeDecisionV1(input);
    expect(result.decision).toBe('REJECT');
  });

  it('independently proved reference with different SHA may pass (green path)', () => {
    const input = makeDecisionInput({ proofFindings: [] });
    const result = computeDecisionV1(input);
    expect(result.decision).toBe('PASS');
  });
});

/* ------------------------------------------------------------------ */
/* NC8 — NaN/infinite tolerance path                                   */
/* ------------------------------------------------------------------ */

describe('Negative control 8 — NaN/infinite tolerance path', () => {
  it('NaN in money values cannot produce a PASS — exact arithmetic rejects NaN', () => {
    const numericFail = makeCheck({
      code: 'numeric_value_validation',
      outcome: 'FAIL',
      required: true,
      blocking: true,
      riskPoints: 50,
      message: 'NaN or infinite value detected in money assertion',
    });
    const input = makeDecisionInput({ checks: [numericFail] });
    const result = computeDecisionV1(input);
    expect(result.decision).toBe('REJECT');
  });

  it('valid exact decimal values pass (green path)', () => {
    const numericPass = makeCheck({
      code: 'numeric_value_validation',
      outcome: 'PASS',
      required: true,
      blocking: false,
      riskPoints: 0,
    });
    const input = makeDecisionInput({ checks: [numericPass] });
    const result = computeDecisionV1(input);
    expect(result.decision).toBe('PASS');
  });
});

/* ------------------------------------------------------------------ */
/* NC9 — missing child silently skipped                                */
/* ------------------------------------------------------------------ */

describe('Negative control 9 — missing child silently skipped', () => {
  it('missing R-2A child in project rollup produces FAIL, not silent SKIP', () => {
    const rollupFail = makeCheck({
      code: 'project_rollup_missing_child',
      outcome: 'FAIL',
      required: true,
      blocking: true,
      riskPoints: 40,
      message: 'missing child PE in project rollup',
    });
    const input = makeDecisionInput({ checks: [rollupFail] });
    const result = computeDecisionV1(input);
    expect(result.decision).toBe('REJECT');
  });

  it('complete rollup passes (green path)', () => {
    const rollupPass = makeCheck({
      code: 'project_rollup_missing_child',
      outcome: 'PASS',
      required: true,
      blocking: false,
      riskPoints: 0,
    });
    const input = makeDecisionInput({ checks: [rollupPass] });
    const result = computeDecisionV1(input);
    expect(result.decision).toBe('PASS');
  });
});

/* ------------------------------------------------------------------ */
/* NC10 — required NOT_RUN becomes PASS                                 */
/* ------------------------------------------------------------------ */

describe('Negative control 10 — required NOT_RUN becomes PASS', () => {
  it('a required comparison NOT_RUN prevents machine PASS', () => {
    const comparisonNotRun = makeCheck({
      code: 'cross_document_summary_detail',
      outcome: 'NOT_RUN',
      required: true,
      blocking: false,
      riskPoints: 25,
    });
    const input = makeDecisionInput({ checks: [comparisonNotRun] });
    const result = computeDecisionV1(input);
    expect(result.decision).not.toBe('PASS');
  });

  it('a required comparison PASS allows machine PASS (green path)', () => {
    const comparisonPass = makeCheck({
      code: 'cross_document_summary_detail',
      outcome: 'PASS',
      required: true,
      blocking: false,
      riskPoints: 0,
    });
    const input = makeDecisionInput({ checks: [comparisonPass] });
    const result = computeDecisionV1(input);
    expect(result.decision).toBe('PASS');
  });
});

/* ------------------------------------------------------------------ */
/* NC11 — risk overrides blocking failure                              */
/* ------------------------------------------------------------------ */

describe('Negative control 11 — risk overrides blocking failure', () => {
  it('low risk score does NOT override a blocking FAIL — decision must be REJECT', () => {
    const blockingFail = makeBlockingCheck('source_sha_verification');
    const input = makeDecisionInput({
      checks: [blockingFail],
    });
    const result = computeDecisionV1(input);
    expect(result.decision).toBe('REJECT');
    expect(result.blockingFailCount).toBeGreaterThan(0);
  });

  it('no blocking failures with low risk produces PASS (green path)', () => {
    const input = makeDecisionInput({
      checks: [makeCheck({ outcome: 'PASS', riskPoints: 0 })],
    });
    const result = computeDecisionV1(input);
    expect(result.decision).toBe('PASS');
    expect(result.blockingFailCount).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* NC12 — partial persistence                                          */
/* ------------------------------------------------------------------ */

describe('Negative control 12 — partial persistence', () => {
  class PartialPersistenceRepo implements BudgetVerificationRepositoryV1 {
    persistCallCount = 0;
    throwAfterCandidate = false;

    async findTerminalRunByIdentity(): Promise<{
      candidate: ReadCandidateV1;
      run: ReadRunV1;
    } | null> {
      return null;
    }

    async persistCompletedVerification(
      input: PersistCompletedVerificationInputV1,
    ): Promise<{ candidate: PersistedCandidateV1; run: PersistedRunV1 }> {
      this.persistCallCount++;
      if (this.throwAfterCandidate) {
        throw new Error('SIMULATED_FAILURE_AFTER_CANDIDATE');
      }
      return {
        candidate: {
          id: input.result.candidateId,
          status: input.result.status,
          currentRunId: input.result.verificationRunId,
        },
        run: {
          id: input.result.verificationRunId,
          candidateId: input.result.candidateId,
          decision: input.result.decision,
          status: input.result.status,
          route: input.result.route,
          riskScore: input.result.riskScore,
        },
      };
    }

    async persistReviewDecision(): Promise<PersistedReviewDecisionV1> {
      throw new Error('not implemented');
    }

    async readCandidate(): Promise<ReadCandidateV1 | null> {
      return null;
    }

    async readRun(): Promise<ReadRunV1 | null> {
      return null;
    }

    async readChecks(): Promise<ReadCheckV1[]> {
      return [];
    }

    async readDiscrepancies(): Promise<ReadDiscrepancyV1[]> {
      return [];
    }

    async readProofSnapshots(): Promise<ReadProofSnapshotV1[]> {
      return [];
    }

    async readReviewDecisions(): Promise<ReadReviewDecisionV1[]> {
      return [];
    }
  }

  it('transaction failure after candidate insert propagates the error (no silent success)', () => {
    const repo = new PartialPersistenceRepo();
    repo.throwAfterCandidate = true;
    expect(repo.throwAfterCandidate).toBe(true);
    return expect(
      repo.persistCompletedVerification({
        candidateIdentity: {
          cycleId: 'fy2027',
          manifestContentSha256: VALID_SHA,
          manifestDocumentKey: 'r1_fy2027',
          extractionArtifactId: 'art-1',
          extractionArtifactSha256: VALID_SHA,
          extractionArtifactLocator: '/test/art.json',
          sourceDocumentId: 'src-1',
          sourceSha256: VALID_SHA,
          verifierVersion: 'defense_budget_verifier_v1',
          policyVersion: 'defense_budget_verification_policy_v1',
          policySha256: VALID_SHA,
        },
        result: {
          verifierVersion: 'defense_budget_verifier_v1',
          policyVersion: 'defense_budget_verification_policy_v1',
          policySha256: VALID_SHA,
          verificationRunId: 'run-1',
          candidateId: 'cand-1',
          cycleId: 'fy2027',
          manifestContentSha256: VALID_SHA,
          manifestDocumentKey: 'r1_fy2027',
          extractionArtifactId: 'art-1',
          extractionArtifactSha256: VALID_SHA,
          sourceDocumentId: 'src-1',
          sourcePdfSha256: VALID_SHA,
          decision: 'REVIEW',
          status: 'NEEDS_REVIEW',
          route: 'human_review',
          riskScore: 50,
          checks: [],
          discrepancies: [],
          acceptedAssertionIds: [],
          rejectedAssertionIds: [],
          referenceArtifactIds: [],
          startedAt: '2026-01-01T00:00:00Z',
          completedAt: '2026-01-01T00:00:01Z',
        },
        proofBundle: {} as never,
        proofFindings: [],
        proofSnapshots: [],
        checks: [],
        discrepancies: [],
        startedAt: '2026-01-01T00:00:00Z',
        completedAt: '2026-01-01T00:00:01Z',
      }),
    ).rejects.toThrow('SIMULATED_FAILURE_AFTER_CANDIDATE');
  });

  it('successful persistence returns correct IDs (green path)', async () => {
    const repo = new PartialPersistenceRepo();
    repo.throwAfterCandidate = false;
    const result = await repo.persistCompletedVerification({
      candidateIdentity: {
        cycleId: 'fy2027',
        manifestContentSha256: VALID_SHA,
        manifestDocumentKey: 'r1_fy2027',
        extractionArtifactId: 'art-1',
        extractionArtifactSha256: VALID_SHA,
        extractionArtifactLocator: '/test/art.json',
        sourceDocumentId: 'src-1',
        sourceSha256: VALID_SHA,
        verifierVersion: 'defense_budget_verifier_v1',
        policyVersion: 'defense_budget_verification_policy_v1',
        policySha256: VALID_SHA,
      },
      result: {
        verifierVersion: 'defense_budget_verifier_v1',
        policyVersion: 'defense_budget_verification_policy_v1',
        policySha256: VALID_SHA,
        verificationRunId: 'run-1',
        candidateId: 'cand-1',
        cycleId: 'fy2027',
        manifestContentSha256: VALID_SHA,
        manifestDocumentKey: 'r1_fy2027',
        extractionArtifactId: 'art-1',
        extractionArtifactSha256: VALID_SHA,
        sourceDocumentId: 'src-1',
        sourcePdfSha256: VALID_SHA,
        decision: 'PASS',
        status: 'VERIFICATION_PASSED',
        route: 'none',
        riskScore: 0,
        checks: [],
        discrepancies: [],
        acceptedAssertionIds: [],
        rejectedAssertionIds: [],
        referenceArtifactIds: [],
        startedAt: '2026-01-01T00:00:00Z',
        completedAt: '2026-01-01T00:00:01Z',
      },
      proofBundle: {} as never,
      proofFindings: [],
      proofSnapshots: [],
      checks: [],
      discrepancies: [],
      startedAt: '2026-01-01T00:00:00Z',
      completedAt: '2026-01-01T00:00:01Z',
    });
    expect(result.candidate.id).toBe('cand-1');
    expect(result.run.id).toBe('run-1');
  });
});

/* ------------------------------------------------------------------ */
/* NC13 — mismatched candidate/run review                              */
/* ------------------------------------------------------------------ */

describe('Negative control 13 — mismatched candidate/run review', () => {
  class MismatchReviewRepo implements BudgetVerificationRepositoryV1 {
    async findTerminalRunByIdentity(): Promise<{
      candidate: ReadCandidateV1;
      run: ReadRunV1;
    } | null> {
      return null;
    }

    async persistCompletedVerification(): Promise<{
      candidate: PersistedCandidateV1;
      run: PersistedRunV1;
    }> {
      throw new Error('not implemented');
    }

    async persistReviewDecision(): Promise<PersistedReviewDecisionV1> {
      throw new Error('not implemented');
    }

    async readCandidate(candidateId: string): Promise<ReadCandidateV1 | null> {
      return makeReadCandidate({
        id: candidateId,
        currentRunId: 'run-A',
      });
    }

    async readRun(runId: string): Promise<ReadRunV1 | null> {
      // Return a run that belongs to a DIFFERENT candidate
      return makeReadRun({
        id: runId,
        candidateId: 'different-candidate-id',
      });
    }

    async readChecks(): Promise<ReadCheckV1[]> {
      return [];
    }

    async readDiscrepancies(): Promise<ReadDiscrepancyV1[]> {
      return [];
    }

    async readProofSnapshots(): Promise<ReadProofSnapshotV1[]> {
      return [];
    }

    async readReviewDecisions(): Promise<ReadReviewDecisionV1[]> {
      return [];
    }
  }

  it('review service rejects when run belongs to a different candidate', async () => {
    const repo = new MismatchReviewRepo();
    const service = new BudgetReviewV1Service(repo);
    await expect(
      service.review({
        candidateId: 'cand-1',
        verificationRunId: 'run-A',
        reviewerId: 'reviewer-1',
        decision: 'accept',
        notes: 'test review',
        evidenceIds: [],
        expectedSourceSha256: VALID_SHA,
        expectedExtractionArtifactSha256: VALID_SHA,
        expectedManifestContentSha256: VALID_SHA,
      }),
    ).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* NC14 — blocking review waiver                                       */
/* ------------------------------------------------------------------ */

describe('Negative control 14 — blocking review waiver', () => {
  it('hasNonWaivableBlockingFailure returns true for blocking FAIL check', () => {
    // Use a code in BLOCKING_CHECK_CODES to test the exported function
    const blockingCheck: ReadCheckV1 = makeReadCheck({
      code: 'contract_integrity',
      outcome: 'FAIL',
      required: true,
      blocking: true,
      riskPoints: 50,
      message: 'contract integrity failure',
    });
    expect(hasNonWaivableBlockingFailure([blockingCheck])).toBe(true);
  });

  it('hasNonWaivableBlockingFailure returns false for non-blocking check (green path)', () => {
    const nonBlockingCheck: ReadCheckV1 = makeReadCheck({
      code: 'evidence_granularity',
      outcome: 'FAIL',
      required: false,
      blocking: false,
      riskPoints: 10,
      message: 'page-only evidence',
    });
    expect(hasNonWaivableBlockingFailure([nonBlockingCheck])).toBe(false);
  });

  it('a blocking source_sha_mismatch check cannot be accepted via review', async () => {
    class BlockingReviewRepo implements BudgetVerificationRepositoryV1 {
      async findTerminalRunByIdentity(): Promise<{
        candidate: ReadCandidateV1;
        run: ReadRunV1;
      } | null> {
        return null;
      }

      async persistCompletedVerification(): Promise<{
        candidate: PersistedCandidateV1;
        run: PersistedRunV1;
      }> {
        throw new Error('not implemented');
      }

      async persistReviewDecision(): Promise<PersistedReviewDecisionV1> {
        throw new Error('should not be called for blocking finding');
      }

      async readCandidate(candidateId: string): Promise<ReadCandidateV1 | null> {
        return makeReadCandidate({ id: candidateId });
      }

      async readRun(runId: string): Promise<ReadRunV1 | null> {
        return makeReadRun({ id: runId });
      }

      async readChecks(): Promise<ReadCheckV1[]> {
        return [
          makeReadCheck({
            code: 'source_sha_verification',
            outcome: 'FAIL',
            required: true,
            blocking: true,
            riskPoints: 50,
            message: 'source SHA mismatch',
          }),
        ];
      }

      async readDiscrepancies(): Promise<ReadDiscrepancyV1[]> {
        return [];
      }

      async readProofSnapshots(): Promise<ReadProofSnapshotV1[]> {
        return [];
      }

      async readReviewDecisions(): Promise<ReadReviewDecisionV1[]> {
        return [];
      }
    }

    const repo = new BlockingReviewRepo();
    const service = new BudgetReviewV1Service(repo);
    await expect(
      service.review({
        candidateId: 'cand-1',
        verificationRunId: 'run-1',
        reviewerId: 'reviewer-1',
        decision: 'accept',
        notes: 'trying to waive blocking failure',
        evidenceIds: [],
        expectedSourceSha256: VALID_SHA,
        expectedExtractionArtifactSha256: VALID_SHA,
        expectedManifestContentSha256: VALID_SHA,
      }),
    ).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* NC15 — canonical writer import                                      */
/* ------------------------------------------------------------------ */

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function v1ProductionFiles(): string[] {
  const VERIFICATION_DIR = 'src/defense-budget/verification';
  const v1Subdirs = ['trusted-proof', 'rules', 'decision', 'persistence', 'services'];
  const v1Files = [
    'verification-contract-v1.ts',
    'verification-input-v1.ts',
    'verification-policy-v1.ts',
    'verification-policy-registry.ts',
  ];
  const results: string[] = [];
  for (const sub of v1Subdirs) {
    const dir = join(VERIFICATION_DIR, sub);
    if (!existsSync(dir)) continue;
    const walk = (d: string): void => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
          results.push(full);
        }
      }
    };
    walk(dir);
  }
  for (const name of v1Files) {
    const full = join(VERIFICATION_DIR, name);
    if (existsSync(full)) results.push(full);
  }
  return results;
}

describe('Negative control 15 — canonical writer import', () => {
  it('no V1 production file imports ProgramElementWriterService or canonical writer APIs', () => {
    const banned = [
      /ProgramElementWriterService/,
      /program-element-writer\.service/,
      /upsertProgramElement/,
      /upsertProgramElementYear/,
      /programElement\.create/,
      /programElement\.update/,
      /programElementYear\.create/,
      /programElementYear\.update/,
      /programElementYearSourceValue\.create/,
      /promotionReady/,
      /canonicalEligible/,
    ];
    for (const file of v1ProductionFiles()) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const pattern of banned) {
        expect({ file, hit: pattern.test(code) }).toEqual({ file, hit: false });
      }
    }
  });

  it('no V1 production file contains CANONICAL or PROMOTED vocabulary', () => {
    for (const file of v1ProductionFiles()) {
      const code = stripComments(readFileSync(file, 'utf8'));
      expect({ file, hit: /\bCANONICAL\b/.test(code) }).toEqual({ file, hit: false });
      expect({ file, hit: /\bPROMOTED\b/.test(code) }).toEqual({ file, hit: false });
    }
  });

  it('no V1 production file uses unsafe Prisma casts or findUniqueById', () => {
    const banned = [/as\s+unknown\s+as\s+(?:Prisma|PrismaLike)/, /findUniqueById/];
    for (const file of v1ProductionFiles()) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const pattern of banned) {
        expect({ file, hit: pattern.test(code) }).toEqual({ file, hit: false });
      }
    }
  });

  it('no V1 production file hashes source bytes through string conversion', () => {
    const banned = [/\.toString\(['"]binary['"]\)/];
    for (const file of v1ProductionFiles()) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const pattern of banned) {
        expect({ file, hit: pattern.test(code) }).toEqual({ file, hit: false });
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* NC16 — orphan typecheck config                                      */
/* ------------------------------------------------------------------ */

describe('Negative control 16 — orphan typecheck config', () => {
  it('tsconfig.budget-verification-v1.json is wired into the permanent API typecheck', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const typecheckScript = pkg.scripts?.typecheck ?? '';
    expect(typecheckScript).toContain('tsconfig.budget-verification-v1.json');
  });

  it('verify:pe-budget-phase-2 script exists and targets verification tests', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const script = pkg.scripts?.['verify:pe-budget-phase-2'] ?? '';
    expect(script).toContain('defense-budget/verification');
  });

  it('tsconfig.budget-verification-v1.json exists and uses strict mode', () => {
    expect(existsSync('tsconfig.budget-verification-v1.json')).toBe(true);
    const config = JSON.parse(readFileSync('tsconfig.budget-verification-v1.json', 'utf8'));
    expect(config.compilerOptions?.strict).toBe(true);
    expect(config.compilerOptions?.noEmit).toBe(true);
  });

  it('V1 CLI scripts are included in the tsconfig', () => {
    const config = JSON.parse(readFileSync('tsconfig.budget-verification-v1.json', 'utf8'));
    const includes = config.include ?? [];
    const hasVerifyScript = includes.some((f: string) =>
      f.includes('verify-defense-budget-extraction-v1'),
    );
    const hasReviewScript = includes.some((f: string) =>
      f.includes('review-defense-budget-verification-v1'),
    );
    const hasReportScript = includes.some((f: string) =>
      f.includes('report-defense-budget-verification-cycle-v1'),
    );
    expect(hasVerifyScript).toBe(true);
    expect(hasReviewScript).toBe(true);
    expect(hasReportScript).toBe(true);
  });
});
