/**
 * Workstream M tests — immutable audit-only review workflow.
 *
 * Tests M1–M7:
 * - M1: only NEEDS_REVIEW eligible
 * - M2: blocking finding cannot be accepted
 * - M4: hash mismatch blocks review
 * - M5: segregation of duties (documented limitation when actor absent)
 * - M6: accepted/rejected statuses
 * - M7: concurrent double review prevented
 */
import {
  BudgetReviewV1Service,
  ReviewEligibilityError,
  hasNonWaivableBlockingFailure,
  hasNonWaivableBlockingProofFinding,
  hasNonWaivableBlockingDiscrepancy,
  BLOCKING_CHECK_CODES,
  BLOCKING_REVIEW_CODES,
} from './budget-review-v1.service.js';
import type {
  BudgetVerificationRepositoryV1,
  ReadCandidateV1,
  ReadRunV1,
  PersistReviewDecisionInputV1,
  PersistedReviewDecisionV1,
} from '../persistence/verification-repository.js';
import type {
  VerificationCheckV1,
  VerificationDiscrepancyV1,
} from '../verification-contract-v1.js';
import type { ProofFindingV1 } from '../trusted-proof/trusted-proof-types.js';

/* ------------------------------------------------------------------ */
/* Fake repository for testing                                        */
/* ------------------------------------------------------------------ */

class FakeReviewRepo implements BudgetVerificationRepositoryV1 {
  candidate: ReadCandidateV1 | null = null;
  run: ReadRunV1 | null = null;
  persistedReview: PersistedReviewDecisionV1 | null = null;
  persistCallCount = 0;
  shouldFailPersist = false;

  async findTerminalRunByIdentity(): Promise<{
    candidate: ReadCandidateV1;
    run: ReadRunV1;
  } | null> {
    return null;
  }

  async persistCompletedVerification(): Promise<{
    candidate: { id: string; status: string; currentRunId: string | null };
    run: {
      id: string;
      candidateId: string;
      decision: string;
      status: string;
      route: string;
      riskScore: number;
    };
  }> {
    throw new Error('not implemented in review tests');
  }

  async persistReviewDecision(
    input: PersistReviewDecisionInputV1,
  ): Promise<PersistedReviewDecisionV1> {
    this.persistCallCount++;
    if (this.shouldFailPersist) {
      throw new Error('simulated concurrent modification');
    }
    // Simulate the optimistic check: if candidate status changed, fail
    if (this.candidate && this.candidate.status !== 'NEEDS_REVIEW') {
      throw new Error('candidate is not in NEEDS_REVIEW state');
    }
    this.persistedReview = {
      id: `rev_${this.persistCallCount}`,
      candidateId: input.candidateId,
      runId: input.verificationRunId,
      decision: input.decision,
      createdAt: new Date().toISOString(),
    };
    // Update candidate status to simulate the transaction
    if (this.candidate) {
      this.candidate = {
        ...this.candidate,
        status: input.decision === 'accept' ? 'REVIEW_ACCEPTED' : 'REJECTED',
      };
    }
    return this.persistedReview;
  }

  async readCandidate(candidateId: string): Promise<ReadCandidateV1 | null> {
    if (this.candidate && this.candidate.id === candidateId) return this.candidate;
    return null;
  }

  async readRun(runId: string): Promise<ReadRunV1 | null> {
    if (this.run && this.run.id === runId) return this.run;
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function makeCandidate(overrides: Partial<ReadCandidateV1> = {}): ReadCandidateV1 {
  return {
    id: 'cand-1',
    cycleId: 'fy2027',
    manifestContentSha256: 'a'.repeat(64),
    manifestDocumentKey: 'r1_fy2027',
    extractionArtifactId: 'art-1',
    extractionArtifactSha256: 'b'.repeat(64),
    sourceDocumentId: 'src-1',
    sourceSha256: 'c'.repeat(64),
    verifierVersion: 'defense_budget_verifier_v1',
    policyVersion: 'defense_budget_verification_policy_v1',
    policySha256: 'd'.repeat(64),
    status: 'NEEDS_REVIEW',
    currentRunId: 'run-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeRun(overrides: Partial<ReadRunV1> = {}): ReadRunV1 {
  return {
    id: 'run-1',
    candidateId: 'cand-1',
    verifierVersion: 'defense_budget_verifier_v1',
    policyVersion: 'defense_budget_verification_policy_v1',
    policySha256: 'd'.repeat(64),
    decision: 'REVIEW',
    status: 'NEEDS_REVIEW',
    route: 'targeted_local_reextraction',
    riskScore: 20,
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:01:00Z',
    manifestContentSha256: 'a'.repeat(64),
    extractionArtifactSha256: 'b'.repeat(64),
    sourceSha256: 'c'.repeat(64),
    resultSnapshot: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeReviewInput(
  overrides: Record<string, unknown> = {},
): Parameters<BudgetReviewV1Service['review']>[0] {
  return {
    candidateId: 'cand-1',
    verificationRunId: 'run-1',
    reviewerId: 'reviewer-1',
    decision: 'accept',
    notes: 'Reviewed and accepted — source page manually inspected.',
    evidenceIds: ['e1', 'e2'],
    expectedSourceSha256: 'c'.repeat(64),
    expectedExtractionArtifactSha256: 'b'.repeat(64),
    expectedManifestContentSha256: 'a'.repeat(64),
    ...overrides,
  } as Parameters<BudgetReviewV1Service['review']>[0];
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('BudgetReviewV1Service', () => {
  it('accepts a valid NEEDS_REVIEW candidate', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = makeCandidate();
    repo.run = makeRun();
    const service = new BudgetReviewV1Service(repo);

    const result = await service.review(makeReviewInput());

    expect(result.decision).toBe('accept');
    expect(result.finalStatus).toBe('REVIEW_ACCEPTED');
    expect(result.candidateId).toBe('cand-1');
    expect(result.runId).toBe('run-1');
    expect(repo.persistCallCount).toBe(1);
  });

  it('rejects a candidate (reject is always allowed)', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = makeCandidate();
    repo.run = makeRun();
    const service = new BudgetReviewV1Service(repo);

    const result = await service.review(makeReviewInput({ decision: 'reject' }));

    expect(result.decision).toBe('reject');
    expect(result.finalStatus).toBe('REJECTED');
  });

  // M1: only NEEDS_REVIEW is eligible
  it('throws when candidate is not in NEEDS_REVIEW (M1)', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = makeCandidate({ status: 'VERIFICATION_PASSED' });
    repo.run = makeRun();
    const service = new BudgetReviewV1Service(repo);

    await expect(service.review(makeReviewInput())).rejects.toThrow(ReviewEligibilityError);
    await expect(service.review(makeReviewInput())).rejects.toMatchObject({
      code: 'not_needs_review',
    });
  });

  it('throws when candidate is REJECTED (M1)', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = makeCandidate({ status: 'REJECTED' });
    repo.run = makeRun();
    const service = new BudgetReviewV1Service(repo);

    await expect(service.review(makeReviewInput())).rejects.toMatchObject({
      code: 'not_needs_review',
    });
  });

  it('throws when candidate is REVIEW_ACCEPTED (M1)', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = makeCandidate({ status: 'REVIEW_ACCEPTED' });
    repo.run = makeRun();
    const service = new BudgetReviewV1Service(repo);

    await expect(service.review(makeReviewInput())).rejects.toMatchObject({
      code: 'not_needs_review',
    });
  });

  it('throws when candidate is not found (M1)', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = null;
    const service = new BudgetReviewV1Service(repo);

    await expect(service.review(makeReviewInput())).rejects.toMatchObject({
      code: 'candidate_not_found',
    });
  });

  // M4: hash binding
  it('throws on source SHA mismatch (M4)', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = makeCandidate();
    repo.run = makeRun();
    const service = new BudgetReviewV1Service(repo);

    await expect(
      service.review(makeReviewInput({ expectedSourceSha256: 'x'.repeat(64) })),
    ).rejects.toMatchObject({ code: 'hash_mismatch' });
  });

  it('throws on artifact SHA mismatch (M4)', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = makeCandidate();
    repo.run = makeRun();
    const service = new BudgetReviewV1Service(repo);

    await expect(
      service.review(makeReviewInput({ expectedExtractionArtifactSha256: 'x'.repeat(64) })),
    ).rejects.toMatchObject({ code: 'hash_mismatch' });
  });

  it('throws on manifest SHA mismatch (M4)', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = makeCandidate();
    repo.run = makeRun();
    const service = new BudgetReviewV1Service(repo);

    await expect(
      service.review(makeReviewInput({ expectedManifestContentSha256: 'x'.repeat(64) })),
    ).rejects.toMatchObject({ code: 'hash_mismatch' });
  });

  // M4: blank notes
  it('throws on blank notes', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = makeCandidate();
    repo.run = makeRun();
    const service = new BudgetReviewV1Service(repo);

    await expect(service.review(makeReviewInput({ notes: '   ' }))).rejects.toMatchObject({
      code: 'blank_notes',
    });
  });

  // M1: run/candidate mismatch
  it('throws when run belongs to a different candidate', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = makeCandidate();
    repo.run = makeRun({ candidateId: 'cand-other' });
    const service = new BudgetReviewV1Service(repo);

    await expect(service.review(makeReviewInput())).rejects.toMatchObject({
      code: 'run_candidate_mismatch',
    });
  });

  it('throws when run is not found', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = makeCandidate();
    repo.run = null;
    const service = new BudgetReviewV1Service(repo);

    await expect(service.review(makeReviewInput())).rejects.toMatchObject({
      code: 'run_not_found',
    });
  });

  // M2: blocking finding cannot be accepted
  it('throws when accepting a run with REJECT decision (M2)', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = makeCandidate();
    repo.run = makeRun({ decision: 'REJECT' });
    const service = new BudgetReviewV1Service(repo);

    await expect(service.review(makeReviewInput({ decision: 'accept' }))).rejects.toMatchObject({
      code: 'blocking_finding_present',
    });
  });

  it('allows rejecting a run with REJECT decision (M2)', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = makeCandidate();
    repo.run = makeRun({ decision: 'REJECT' });
    const service = new BudgetReviewV1Service(repo);

    const result = await service.review(makeReviewInput({ decision: 'reject' }));
    expect(result.decision).toBe('reject');
  });

  // M7: concurrent double review prevented
  it('second review fails after first review changes status (M7)', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = makeCandidate();
    repo.run = makeRun();
    const service = new BudgetReviewV1Service(repo);

    // First review succeeds
    await service.review(makeReviewInput());

    // Second review should fail — candidate is now REVIEW_ACCEPTED
    await expect(service.review(makeReviewInput())).rejects.toThrow(ReviewEligibilityError);
  });

  // checkEligibility
  it('checkEligibility returns eligible for NEEDS_REVIEW candidate', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = makeCandidate();
    const service = new BudgetReviewV1Service(repo);

    const result = await service.checkEligibility('cand-1');
    expect(result.eligible).toBe(true);
  });

  it('checkEligibility returns not eligible for VERIFICATION_PASSED', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = makeCandidate({ status: 'VERIFICATION_PASSED' });
    const service = new BudgetReviewV1Service(repo);

    const result = await service.checkEligibility('cand-1');
    expect(result.eligible).toBe(false);
  });

  it('checkEligibility returns not eligible for missing candidate', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = null;
    const service = new BudgetReviewV1Service(repo);

    const result = await service.checkEligibility('missing');
    expect(result.eligible).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Blocking finding helper tests (M2)                                  */
/* ------------------------------------------------------------------ */

describe('hasNonWaivableBlockingFailure', () => {
  const makeCheck = (code: string, outcome: string, blocking: boolean): VerificationCheckV1 => ({
    checkId: `vc1_${code}`,
    code,
    ruleVersion: 'v1',
    outcome: outcome as 'PASS' | 'FAIL' | 'NOT_RUN' | 'SKIPPED',
    required: true,
    blocking,
    riskPoints: 0,
    message: 'test',
    assertionIds: [],
    evidenceIds: [],
    referenceArtifactIds: [],
  });

  it('returns true for blocking FAIL on a non-waivable code', () => {
    expect(hasNonWaivableBlockingFailure([makeCheck('identity_validation', 'FAIL', true)])).toBe(
      true,
    );
  });

  it('returns false for non-blocking FAIL', () => {
    expect(hasNonWaivableBlockingFailure([makeCheck('completeness', 'FAIL', false)])).toBe(false);
  });

  it('returns false for PASS', () => {
    expect(hasNonWaivableBlockingFailure([makeCheck('identity_validation', 'PASS', true)])).toBe(
      false,
    );
  });

  it('returns false for FAIL on a non-blocking-severity code', () => {
    // completeness can be blocking but is not in the non-waivable set
    expect(hasNonWaivableBlockingFailure([makeCheck('completeness', 'FAIL', true)])).toBe(false);
  });
});

describe('hasNonWaivableBlockingProofFinding', () => {
  const makeFinding = (code: string, severity: 'blocking' | 'review'): ProofFindingV1 => ({
    code: code as ProofFindingV1['code'],
    severity,
    message: 'test',
  });

  it('returns true for blocking source_sha_mismatch', () => {
    expect(
      hasNonWaivableBlockingProofFinding([makeFinding('source_sha_mismatch', 'blocking')]),
    ).toBe(true);
  });

  it('returns false for review-severity finding', () => {
    expect(hasNonWaivableBlockingProofFinding([makeFinding('source_sha_mismatch', 'review')])).toBe(
      false,
    );
  });

  it('returns false for no findings', () => {
    expect(hasNonWaivableBlockingProofFinding([])).toBe(false);
  });
});

describe('hasNonWaivableBlockingDiscrepancy', () => {
  const makeDiscrepancy = (
    severity: 'blocking' | 'review' | 'informational',
  ): VerificationDiscrepancyV1 => ({
    discrepancyId: 'vd1_1',
    code: 'test',
    severity,
    description: 'test',
    assertionIds: [],
    evidenceIds: [],
    referenceArtifactIds: [],
  });

  it('returns true for blocking discrepancy', () => {
    expect(hasNonWaivableBlockingDiscrepancy([makeDiscrepancy('blocking')])).toBe(true);
  });

  it('returns false for review discrepancy', () => {
    expect(hasNonWaivableBlockingDiscrepancy([makeDiscrepancy('review')])).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Blocking code set tests                                             */
/* ------------------------------------------------------------------ */

describe('BLOCKING_CHECK_CODES', () => {
  it('contains identity_validation', () => {
    expect(BLOCKING_CHECK_CODES.has('identity_validation')).toBe(true);
  });
  it('contains duplicate_detection', () => {
    expect(BLOCKING_CHECK_CODES.has('duplicate_detection')).toBe(true);
  });
  it('does not contain completeness', () => {
    expect(BLOCKING_CHECK_CODES.has('completeness')).toBe(false);
  });
});

describe('BLOCKING_REVIEW_CODES', () => {
  it('contains source_sha_mismatch', () => {
    expect(BLOCKING_REVIEW_CODES.has('source_sha_mismatch')).toBe(true);
  });
  it('contains parse_job_missing', () => {
    expect(BLOCKING_REVIEW_CODES.has('parse_job_missing')).toBe(true);
  });
  it('does not contain archive_version_missing', () => {
    expect(BLOCKING_REVIEW_CODES.has('archive_version_missing')).toBe(false);
  });
});
