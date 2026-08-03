/**
 * R4 remediation tests — governed, non-waivable review.
 *
 * Tests:
 * - M1: only NEEDS_REVIEW eligible
 * - M2: blocking finding cannot be accepted (checks, discrepancies, proof snapshots)
 * - M4: hash mismatch blocks review (candidate + run)
 * - M5: segregation of duties (enforced when actor data present, limitation when absent)
 * - M6: accepted/rejected statuses, immutable decision
 * - M7: concurrent double review prevented
 * - R4: prior review prevents second review
 * - R4: evidence ID validation
 * - R4: blocking discrepancy prevents acceptance
 * - R4: blocking proof snapshot prevents acceptance
 * - R4: limitation findings documented
 */
import {
  BudgetReviewV1Service,
  ReviewEligibilityError,
  hasNonWaivableBlockingFailure,
  hasNonWaivableBlockingProofFinding,
  hasNonWaivableBlockingProofSnapshot,
  hasNonWaivableBlockingDiscrepancy,
  BLOCKING_CHECK_CODES,
  BLOCKING_REVIEW_CODES,
} from './budget-review-v1.service.js';
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
  CandidateIdentityV1,
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
  checks: ReadCheckV1[] = [];
  discrepancies: ReadDiscrepancyV1[] = [];
  proofSnapshots: ReadProofSnapshotV1[] = [];
  reviewDecisions: ReadReviewDecisionV1[] = [];
  persistedReview: PersistedReviewDecisionV1 | null = null;
  persistCallCount = 0;
  shouldFailPersist = false;
  /** Simulate concurrent modification: candidate status changes between read and persist */
  concurrentStatusChange: string | null = null;

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
    if (this.candidate) {
      const currentStatus = this.concurrentStatusChange ?? this.candidate.status;
      if (currentStatus !== 'NEEDS_REVIEW') {
        throw new Error('candidate is not in NEEDS_REVIEW state');
      }
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
    // Record the review decision
    this.reviewDecisions = [
      ...this.reviewDecisions,
      {
        id: this.persistedReview.id,
        candidateId: input.candidateId,
        runId: input.verificationRunId,
        reviewerId: input.reviewerId,
        decision: input.decision,
        notes: input.notes,
        sourceSha256: input.expectedSourceSha256,
        extractionArtifactSha256: input.expectedExtractionArtifactSha256,
        manifestContentSha256: input.expectedManifestContentSha256,
        createdAt: this.persistedReview.createdAt,
      },
    ];
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

  async readChecks(runId: string): Promise<ReadCheckV1[]> {
    if (this.run && this.run.id === runId) return this.checks;
    return [];
  }

  async readDiscrepancies(runId: string): Promise<ReadDiscrepancyV1[]> {
    if (this.run && this.run.id === runId) return this.discrepancies;
    return [];
  }

  async readProofSnapshots(runId: string): Promise<ReadProofSnapshotV1[]> {
    if (this.run && this.run.id === runId) return this.proofSnapshots;
    return [];
  }

  async readReviewDecisions(candidateId: string): Promise<ReadReviewDecisionV1[]> {
    if (this.candidate && this.candidate.id === candidateId) return this.reviewDecisions;
    return [];
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

function makeCheck(overrides: Partial<ReadCheckV1> = {}): ReadCheckV1 {
  return {
    checkId: 'vc1_test',
    code: 'completeness',
    ruleVersion: 'v1',
    outcome: 'PASS',
    required: true,
    blocking: false,
    riskPoints: 0,
    message: 'test',
    assertionIds: [],
    evidenceIds: ['e1'],
    referenceArtifactIds: [],
    ...overrides,
  };
}

function makeDiscrepancy(overrides: Partial<ReadDiscrepancyV1> = {}): ReadDiscrepancyV1 {
  return {
    discrepancyId: 'vd1_1',
    code: 'test',
    severity: 'review',
    description: 'test',
    assertionIds: [],
    evidenceIds: [],
    referenceArtifactIds: [],
    ...overrides,
  };
}

function makeProofSnapshot(overrides: Partial<ReadProofSnapshotV1> = {}): ReadProofSnapshotV1 {
  return {
    proofKind: 'manifest',
    status: 'verified',
    sourceDocumentId: null,
    artifactId: null,
    referenceArtifactId: null,
    evidenceJson: {},
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
    evidenceIds: [],
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
    expect(result.priorStatus).toBe('NEEDS_REVIEW');
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

  // M4: run hash mismatch with candidate
  it('throws when run source SHA does not match candidate (M4)', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = makeCandidate();
    repo.run = makeRun({ sourceSha256: 'z'.repeat(64) });
    const service = new BudgetReviewV1Service(repo);

    await expect(service.review(makeReviewInput())).rejects.toMatchObject({
      code: 'hash_mismatch',
    });
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

  // R4: prior review prevents second review
  it('throws when a prior terminal review decision exists (R4)', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = makeCandidate();
    repo.run = makeRun();
    repo.reviewDecisions = [
      {
        id: 'rev_prior',
        candidateId: 'cand-1',
        runId: 'run-1',
        reviewerId: 'reviewer-old',
        decision: 'accept',
        notes: 'prior review',
        sourceSha256: 'c'.repeat(64),
        extractionArtifactSha256: 'b'.repeat(64),
        manifestContentSha256: 'a'.repeat(64),
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];
    const service = new BudgetReviewV1Service(repo);

    await expect(service.review(makeReviewInput())).rejects.toMatchObject({
      code: 'prior_review_exists',
    });
  });

  // R4: evidence ID validation
  it('throws when evidence ID is not found in checks or discrepancies (R4)', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = makeCandidate();
    repo.run = makeRun();
    repo.checks = [makeCheck({ evidenceIds: ['e1', 'e2'] })];
    const service = new BudgetReviewV1Service(repo);

    await expect(
      service.review(makeReviewInput({ evidenceIds: ['e_nonexistent'] })),
    ).rejects.toMatchObject({ code: 'evidence_id_not_found' });
  });

  it('accepts when evidence IDs are all found in checks (R4)', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = makeCandidate();
    repo.run = makeRun();
    repo.checks = [makeCheck({ evidenceIds: ['e1', 'e2'] })];
    const service = new BudgetReviewV1Service(repo);

    const result = await service.review(makeReviewInput({ evidenceIds: ['e1'] }));
    expect(result.decision).toBe('accept');
  });

  // M2: blocking finding cannot be accepted — blocking check
  it('throws when accepting with a non-waivable blocking check failure (M2)', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = makeCandidate();
    repo.run = makeRun();
    repo.checks = [
      makeCheck({
        code: 'identity_validation',
        outcome: 'FAIL',
        blocking: true,
      }),
    ];
    const service = new BudgetReviewV1Service(repo);

    await expect(service.review(makeReviewInput({ decision: 'accept' }))).rejects.toMatchObject({
      code: 'blocking_finding_present',
    });
  });

  // M2: blocking discrepancy prevents acceptance
  it('throws when accepting with a blocking discrepancy (M2)', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = makeCandidate();
    repo.run = makeRun();
    repo.discrepancies = [makeDiscrepancy({ severity: 'blocking' })];
    const service = new BudgetReviewV1Service(repo);

    await expect(service.review(makeReviewInput({ decision: 'accept' }))).rejects.toMatchObject({
      code: 'blocking_finding_present',
    });
  });

  // M2: blocking proof snapshot prevents acceptance
  it('throws when accepting with a blocking proof snapshot (M2)', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = makeCandidate();
    repo.run = makeRun();
    repo.proofSnapshots = [makeProofSnapshot({ status: 'mismatch' })];
    const service = new BudgetReviewV1Service(repo);

    await expect(service.review(makeReviewInput({ decision: 'accept' }))).rejects.toMatchObject({
      code: 'blocking_finding_present',
    });
  });

  // M2: any blocking FAIL (even outside BLOCKING_CHECK_CODES) prevents acceptance
  it('throws when accepting with any blocking FAIL check (M2)', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = makeCandidate();
    repo.run = makeRun();
    repo.checks = [
      makeCheck({
        code: 'completeness', // not in BLOCKING_CHECK_CODES but blocking=true
        outcome: 'FAIL',
        blocking: true,
      }),
    ];
    const service = new BudgetReviewV1Service(repo);

    await expect(service.review(makeReviewInput({ decision: 'accept' }))).rejects.toMatchObject({
      code: 'blocking_finding_present',
    });
  });

  // M2: reject is allowed even with blocking findings
  it('allows rejecting a candidate with blocking findings (M2)', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = makeCandidate();
    repo.run = makeRun();
    repo.checks = [
      makeCheck({
        code: 'identity_validation',
        outcome: 'FAIL',
        blocking: true,
      }),
    ];
    const service = new BudgetReviewV1Service(repo);

    const result = await service.review(makeReviewInput({ decision: 'reject' }));
    expect(result.decision).toBe('reject');
    expect(result.finalStatus).toBe('REJECTED');
  });

  // M5: segregation of duties — enforced when actor data present
  it('throws when reviewer is same as extractor for manual extraction (M5)', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = makeCandidate();
    repo.run = makeRun();
    const service = new BudgetReviewV1Service(repo);

    await expect(
      service.review(
        makeReviewInput({
          reviewerId: 'extractor-1',
          extractorActorId: 'extractor-1',
          extractionMethod: 'manual',
        }),
      ),
    ).rejects.toMatchObject({ code: 'segregation_violation' });
  });

  // M5: segregation of duties — different reviewer is allowed
  it('accepts when reviewer is different from extractor for manual extraction (M5)', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = makeCandidate();
    repo.run = makeRun();
    const service = new BudgetReviewV1Service(repo);

    const result = await service.review(
      makeReviewInput({
        reviewerId: 'reviewer-1',
        extractorActorId: 'extractor-1',
        extractionMethod: 'manual',
      }),
    );
    expect(result.decision).toBe('accept');
  });

  // M5: segregation of duties — limitation finding when actor data absent
  it('documents limitation finding when actor data is absent (M5)', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = makeCandidate();
    repo.run = makeRun();
    const service = new BudgetReviewV1Service(repo);

    const result = await service.review(makeReviewInput());
    expect(result.limitationFindings).toContain(
      'segregation_of_duties_not_enforced: extractor actor identity or extraction method not provided',
    );
  });

  // M5: segregation of duties — not enforced for non-high-risk methods
  it('does not enforce segregation for non-high-risk methods (M5)', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = makeCandidate();
    repo.run = makeRun();
    const service = new BudgetReviewV1Service(repo);

    const result = await service.review(
      makeReviewInput({
        reviewerId: 'extractor-1',
        extractorActorId: 'extractor-1',
        extractionMethod: 'llamaparse', // not in segregationRequiredMethods
      }),
    );
    expect(result.decision).toBe('accept');
    // No limitation finding because actor data was provided
    expect(result.limitationFindings).toHaveLength(0);
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

  // M7: concurrent modification simulated — candidate status changes between read and persist
  it('fails when candidate status changes between read and persist (M7)', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = makeCandidate();
    repo.run = makeRun();
    repo.concurrentStatusChange = 'REVIEW_ACCEPTED'; // simulate concurrent modification
    const service = new BudgetReviewV1Service(repo);

    await expect(service.review(makeReviewInput())).rejects.toThrow(
      'candidate is not in NEEDS_REVIEW state',
    );
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

  it('checkEligibility returns not eligible when prior review exists', async () => {
    const repo = new FakeReviewRepo();
    repo.candidate = makeCandidate();
    repo.reviewDecisions = [
      {
        id: 'rev_prior',
        candidateId: 'cand-1',
        runId: 'run-1',
        reviewerId: 'reviewer-old',
        decision: 'accept',
        notes: 'prior',
        sourceSha256: 'c'.repeat(64),
        extractionArtifactSha256: 'b'.repeat(64),
        manifestContentSha256: 'a'.repeat(64),
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];
    const service = new BudgetReviewV1Service(repo);

    const result = await service.checkEligibility('cand-1');
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
    expect(hasNonWaivableBlockingFailure([makeCheck('completeness', 'FAIL', true)])).toBe(false);
  });

  it('returns true for rdte_summary_detail blocking FAIL', () => {
    expect(hasNonWaivableBlockingFailure([makeCheck('rdte_summary_detail', 'FAIL', true)])).toBe(
      true,
    );
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

describe('hasNonWaivableBlockingProofSnapshot', () => {
  it('returns true for status mismatch', () => {
    expect(
      hasNonWaivableBlockingProofSnapshot([
        {
          proofKind: 'archive',
          status: 'mismatch',
          sourceDocumentId: null,
          artifactId: null,
          referenceArtifactId: null,
          evidenceJson: {},
        },
      ]),
    ).toBe(true);
  });

  it('returns true for status missing', () => {
    expect(
      hasNonWaivableBlockingProofSnapshot([
        {
          proofKind: 'archive',
          status: 'missing',
          sourceDocumentId: null,
          artifactId: null,
          referenceArtifactId: null,
          evidenceJson: {},
        },
      ]),
    ).toBe(true);
  });

  it('returns false for status verified', () => {
    expect(
      hasNonWaivableBlockingProofSnapshot([
        {
          proofKind: 'manifest',
          status: 'verified',
          sourceDocumentId: null,
          artifactId: null,
          referenceArtifactId: null,
          evidenceJson: {},
        },
      ]),
    ).toBe(false);
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
  it('contains rdte_summary_detail', () => {
    expect(BLOCKING_CHECK_CODES.has('rdte_summary_detail')).toBe(true);
  });
  it('contains procurement_rollup', () => {
    expect(BLOCKING_CHECK_CODES.has('procurement_rollup')).toBe(true);
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
  it('contains reference_artifact_proof_failed', () => {
    expect(BLOCKING_REVIEW_CODES.has('reference_artifact_proof_failed')).toBe(true);
  });
  it('does not contain archive_version_missing', () => {
    expect(BLOCKING_REVIEW_CODES.has('archive_version_missing')).toBe(false);
  });
});
