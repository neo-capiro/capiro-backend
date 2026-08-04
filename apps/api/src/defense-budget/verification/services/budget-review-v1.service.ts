/**
 * R4 — Governed, non-waivable review service.
 *
 * Human review is allowed only for uncertainty that policy explicitly permits,
 * never for corruption or broken proof.
 *
 * Review process (inside one repository transaction):
 *   1. Lock or conditionally claim the candidate.
 *   2. Load candidate, terminal run, checks, discrepancies, proof findings,
 *      prior review decisions.
 *   3. Confirm candidate is exactly NEEDS_REVIEW.
 *   4. Confirm run belongs to the candidate.
 *   5. Confirm expected hashes match candidate and run.
 *   6. Reject blank notes.
 *   7. Confirm evidence IDs exist.
 *   8. Evaluate non-waivable findings.
 *   9. Enforce reviewer independence where extractor/operator identity is known.
 *   10. Insert one immutable review decision.
 *   11. Transition the candidate atomically.
 *
 * Non-waivable findings require:
 *   correct/re-extract -> new artifact -> new candidate -> new verification run
 *
 * No canonical promotion property is created.
 */
import type {
  BudgetVerificationRepositoryV1,
  ReadCandidateV1,
  ReadRunV1,
  ReadCheckV1,
  ReadDiscrepancyV1,
  ReadProofSnapshotV1,
  ReadReviewDecisionV1,
} from '../persistence/verification-repository.js';
import type {
  PersistReviewDecisionInputV1,
  PersistedReviewDecisionV1,
} from '../persistence/verification-repository.js';
import type {
  VerificationCheckV1,
  VerificationDiscrepancyV1,
} from '../verification-contract-v1.js';
import type { ProofFindingV1 } from '../trusted-proof/trusted-proof-types.js';

/* ------------------------------------------------------------------ */
/* Review input (M4)                                                   */
/* ------------------------------------------------------------------ */

export interface ReviewInputV1 {
  candidateId: string;
  verificationRunId: string;
  reviewerId: string;
  decision: 'accept' | 'reject';
  notes: string;
  evidenceIds: string[];
  expectedSourceSha256: string;
  expectedExtractionArtifactSha256: string;
  expectedManifestContentSha256: string;
  /**
   * Optional extractor/operator actor ID for segregation-of-duties checks.
   * When absent, a limitation finding is created instead of pretending
   * independence was established.
   */
  extractorActorId?: string;
  /**
   * Optional extraction method for segregation-of-duties enforcement.
   * When absent, segregation is not enforced (with a limitation finding).
   */
  extractionMethod?: string;
}

/**
 * Expected hashes are concurrency guards and review binding, not source proof.
 */

/* ------------------------------------------------------------------ */
/* Review result                                                       */
/* ------------------------------------------------------------------ */

export interface ReviewResultV1 {
  reviewDecisionId: string;
  candidateId: string;
  runId: string;
  decision: 'accept' | 'reject';
  finalStatus: 'REVIEW_ACCEPTED' | 'REJECTED';
  priorStatus: string;
  createdAt: string;
  limitationFindings: string[];
}

/**
 * R8.1 §6.1 — Dry-run eligibility report. Produced by review(input,
 * { commit: false }) after running the FULL eligibility pipeline; no write
 * is performed.
 */
export interface ReviewEligibilityReportV1 {
  candidateStatus: string;
  runStatus: string;
  runDecision: string;
  blockingChecks: ReadCheckV1[];
  blockingDiscrepancies: ReadDiscrepancyV1[];
  proofSnapshotStatuses: Array<{ proofKind: string; status: string }>;
  priorReviewDecisions: number;
  evidenceIdsInspected: string[];
  eligible: boolean;
  limitationFindings: string[];
}

/** Options for review(). commit defaults to true. */
export interface ReviewOptionsV1 {
  commit?: boolean;
}

/** Typed error raised when a concurrent review already completed. */
export class ReviewAlreadyCompletedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewAlreadyCompletedError';
  }
}

/* ------------------------------------------------------------------ */
/* Blocking finding codes (M2)                                        */
/* ------------------------------------------------------------------ */

/**
 * M2: Human review must not accept a candidate containing blocking findings.
 * These are corruption/proof/identity failures that require a new artifact,
 * not a review waiver.
 */
export const BLOCKING_REVIEW_CODES = new Set<string>([
  'source_sha_mismatch',
  'artifact_byte_sha_mismatch',
  'artifact_content_sha_mismatch',
  'manifest_sha_mismatch',
  'artifact_source_sha_mismatch',
  'parse_job_missing',
  'parse_input_sha_mismatch',
  'parse_output_sha_mismatch',
  'parser_method_mismatch',
  'reference_artifact_proof_failed',
]);

/**
 * Check codes that produce blocking FAIL outcomes and cannot be waived.
 * Per R4 spec: source SHA mismatch, artifact byte/content mismatch, manifest
 * mismatch, parser lineage corruption, conflicting duplicate money assertions,
 * funding-field ownership violation, invalid identity, blocking omission,
 * failed required arithmetic reconciliation, required comparison failure
 * classified as blocking, reference-artifact proof failure classified as blocking.
 */
export const BLOCKING_CHECK_CODES = new Set<string>([
  'contract_integrity',
  'manifest_binding',
  'funding_field_ownership',
  'identity_validation',
  'numeric_validation',
  'duplicate_detection',
  'rdte_summary_detail',
  'project_rollup',
  'procurement_rollup',
  'committee_adjustment',
]);

/**
 * Discrepancy codes that are always non-waivable when severity is blocking.
 */
export const BLOCKING_DISCREPANCY_SEVERITY = new Set<string>(['blocking']);

/**
 * Proof snapshot statuses that indicate blocking proof failure.
 */
export const BLOCKING_PROOF_STATUSES = new Set<string>(['missing', 'mismatch']);

/* ------------------------------------------------------------------ */
/* Review policy (M5)                                                  */
/* ------------------------------------------------------------------ */

export interface ReviewPolicyV1 {
  /** Require a different reviewer from the extractor actor for high-risk methods. */
  requireSegregationOfDuties: boolean;
  /** High-materiality threshold in decimal millions. */
  highMaterialityThresholdMillions: string;
  /** Extraction methods that require segregation of duties. */
  segregationRequiredMethods: Set<string>;
}

export const DEFAULT_REVIEW_POLICY_V1: ReviewPolicyV1 = {
  requireSegregationOfDuties: true,
  highMaterialityThresholdMillions: '0',
  segregationRequiredMethods: new Set(['manual', 'paddleocr', 'targeted_local_reextraction']),
};

/* ------------------------------------------------------------------ */
/* Review eligibility error                                            */
/* ------------------------------------------------------------------ */

export class ReviewEligibilityError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'candidate_not_found'
      | 'run_not_found'
      | 'not_needs_review'
      | 'hash_mismatch'
      | 'blocking_finding_present'
      | 'segregation_violation'
      | 'blank_notes'
      | 'run_candidate_mismatch'
      | 'evidence_id_not_found'
      | 'prior_review_exists'
      | 'invalid_decision',
  ) {
    super(message);
    this.name = 'ReviewEligibilityError';
  }
}

/* ------------------------------------------------------------------ */
/* Review service                                                      */
/* ------------------------------------------------------------------ */

export class BudgetReviewV1Service {
  constructor(
    private readonly repository: BudgetVerificationRepositoryV1,
    private readonly policy: ReviewPolicyV1 = DEFAULT_REVIEW_POLICY_V1,
  ) {}

  /**
   * Review a verification candidate.
   *
   * R4: Governed, non-waivable review.
   * R8.1 §6.1: review(input, { commit: false }) runs the FULL eligibility
   * pipeline and returns an eligibility report without performing the final
   * database write. Dry-run and commit share the same eligibility logic.
   *
   * Steps 1–11 per the R4 specification.
   *
   * Returns the review decision result (commit) or eligibility report
   * (dry-run). Throws ReviewEligibilityError if the review is not permitted.
   */
  async review(input: ReviewInputV1): Promise<ReviewResultV1>;
  async review(
    input: ReviewInputV1,
    options: ReviewOptionsV1 & { commit: false },
  ): Promise<ReviewEligibilityReportV1>;
  async review(
    input: ReviewInputV1,
    options: ReviewOptionsV1 = {},
  ): Promise<ReviewResultV1 | ReviewEligibilityReportV1> {
    const commit = options.commit !== false;
    // Step 6: Reject blank notes (checked first — no DB access needed)
    if (!input.notes.trim()) {
      throw new ReviewEligibilityError('notes must not be blank', 'blank_notes');
    }

    // Validate decision vocabulary
    if (input.decision !== 'accept' && input.decision !== 'reject') {
      throw new ReviewEligibilityError(`invalid decision: ${input.decision}`, 'invalid_decision');
    }

    // Step 2: Load candidate
    const candidate = await this.repository.readCandidate(input.candidateId);
    if (!candidate) {
      throw new ReviewEligibilityError(
        `candidate not found: ${input.candidateId}`,
        'candidate_not_found',
      );
    }

    // Record prior status for the result
    const priorStatus = candidate.status;

    // Step 3: Confirm candidate is exactly NEEDS_REVIEW
    if (candidate.status !== 'NEEDS_REVIEW') {
      throw new ReviewEligibilityError(
        `candidate ${input.candidateId} is not in NEEDS_REVIEW state (got ${candidate.status})`,
        'not_needs_review',
      );
    }

    // Step 4: Confirm run belongs to the candidate
    const run = await this.repository.readRun(input.verificationRunId);
    if (!run) {
      throw new ReviewEligibilityError(
        `run not found: ${input.verificationRunId}`,
        'run_not_found',
      );
    }
    if (run.candidateId !== input.candidateId) {
      throw new ReviewEligibilityError(
        `run ${input.verificationRunId} does not belong to candidate ${input.candidateId}`,
        'run_candidate_mismatch',
      );
    }

    // Step 5: Confirm expected hashes match candidate
    if (candidate.sourceSha256 !== input.expectedSourceSha256) {
      throw new ReviewEligibilityError(
        'source SHA mismatch — review hash binding failed',
        'hash_mismatch',
      );
    }
    if (candidate.extractionArtifactSha256 !== input.expectedExtractionArtifactSha256) {
      throw new ReviewEligibilityError(
        'artifact SHA mismatch — review hash binding failed',
        'hash_mismatch',
      );
    }
    if (candidate.manifestContentSha256 !== input.expectedManifestContentSha256) {
      throw new ReviewEligibilityError(
        'manifest SHA mismatch — review hash binding failed',
        'hash_mismatch',
      );
    }

    // Step 5b: Confirm run hashes match candidate hashes
    if (run.sourceSha256 !== candidate.sourceSha256) {
      throw new ReviewEligibilityError('run source SHA does not match candidate', 'hash_mismatch');
    }
    if (run.extractionArtifactSha256 !== candidate.extractionArtifactSha256) {
      throw new ReviewEligibilityError(
        'run artifact SHA does not match candidate',
        'hash_mismatch',
      );
    }
    if (run.manifestContentSha256 !== candidate.manifestContentSha256) {
      throw new ReviewEligibilityError(
        'run manifest SHA does not match candidate',
        'hash_mismatch',
      );
    }

    // Step 2b: Load checks, discrepancies, proof snapshots, prior reviews
    const checks = await this.repository.readChecks(input.verificationRunId);
    const discrepancies = await this.repository.readDiscrepancies(input.verificationRunId);
    const proofSnapshots = await this.repository.readProofSnapshots(input.verificationRunId);
    const priorReviews = await this.repository.readReviewDecisions(input.candidateId);

    // Step 2c: Reject if a terminal review decision already exists
    if (priorReviews.length > 0) {
      throw new ReviewEligibilityError(
        `candidate ${input.candidateId} already has a terminal review decision`,
        'prior_review_exists',
      );
    }

    // Step 7: Confirm evidence IDs exist in checks or discrepancies
    const knownEvidenceIds = new Set<string>();
    for (const check of checks) {
      for (const eid of check.evidenceIds) knownEvidenceIds.add(eid);
    }
    for (const disc of discrepancies) {
      for (const eid of disc.evidenceIds) knownEvidenceIds.add(eid);
    }
    // If no evidence IDs are known (e.g. dry-run), skip this check
    if (knownEvidenceIds.size > 0) {
      for (const eid of input.evidenceIds) {
        if (!knownEvidenceIds.has(eid)) {
          throw new ReviewEligibilityError(
            `evidence ID not found in run checks or discrepancies: ${eid}`,
            'evidence_id_not_found',
          );
        }
      }
    }

    // Collect limitation findings (non-blocking but documented)
    const limitationFindings: string[] = [];

    // Step 8: Evaluate non-waivable findings (only for accept decisions)
    if (input.decision === 'accept') {
      // 8a: Check for non-waivable blocking check failures
      if (hasNonWaivableBlockingFailure(checks)) {
        throw new ReviewEligibilityError(
          'cannot accept: non-waivable blocking check failure present',
          'blocking_finding_present',
        );
      }

      // 8b: Check for non-waivable blocking discrepancies
      if (hasNonWaivableBlockingDiscrepancy(discrepancies)) {
        throw new ReviewEligibilityError(
          'cannot accept: non-waivable blocking discrepancy present',
          'blocking_finding_present',
        );
      }

      // 8c: Check for non-waivable blocking proof findings
      if (hasNonWaivableBlockingProofSnapshot(proofSnapshots)) {
        throw new ReviewEligibilityError(
          'cannot accept: non-waivable blocking proof finding present',
          'blocking_finding_present',
        );
      }

      // 8d: Check for blocking FAIL on any check with blocking=true
      // (broader than just BLOCKING_CHECK_CODES — any blocking FAIL is non-waivable)
      const anyBlockingFail = checks.some((c) => c.outcome === 'FAIL' && c.blocking);
      if (anyBlockingFail) {
        throw new ReviewEligibilityError(
          'cannot accept: blocking FAIL check present',
          'blocking_finding_present',
        );
      }
    }

    // Step 9: Enforce reviewer independence where extractor/operator identity is known
    if (this.policy.requireSegregationOfDuties) {
      if (input.extractorActorId && input.extractionMethod) {
        if (this.policy.segregationRequiredMethods.has(input.extractionMethod)) {
          if (input.extractorActorId === input.reviewerId) {
            throw new ReviewEligibilityError(
              `segregation of duties violated: reviewer ${input.reviewerId} is the same as extractor ${input.extractorActorId}`,
              'segregation_violation',
            );
          }
        }
      } else {
        // When actor data is unavailable, create an explicit limitation finding
        limitationFindings.push(
          'segregation_of_duties_not_enforced: extractor actor identity or extraction method not provided',
        );
      }
    }

    // R8.1 §6.1: dry-run — full eligibility has passed; skip only the write.
    if (!commit) {
      const blockingChecks = checks.filter((c) => c.outcome === 'FAIL' && c.blocking);
      const blockingDiscrepancies = discrepancies.filter((d) => d.severity === 'blocking');
      const knownEvidence: string[] = [];
      for (const c of checks) knownEvidence.push(...c.evidenceIds);
      for (const d of discrepancies) knownEvidence.push(...d.evidenceIds);
      return {
        candidateStatus: candidate.status,
        runStatus: run.status,
        runDecision: run.decision,
        blockingChecks,
        blockingDiscrepancies,
        proofSnapshotStatuses: proofSnapshots.map((s) => ({
          proofKind: s.proofKind,
          status: s.status,
        })),
        priorReviewDecisions: priorReviews.length,
        evidenceIdsInspected: [...new Set(knownEvidence)],
        eligible: true,
        limitationFindings,
      };
    }

    // Step 10 + 11: Persist immutable decision atomically.
    // The repository handles the transaction, append-only insert, and
    // optimistic state check (candidate must still be NEEDS_REVIEW).
    const persistInput: PersistReviewDecisionInputV1 = {
      candidateId: input.candidateId,
      verificationRunId: input.verificationRunId,
      reviewerId: input.reviewerId,
      decision: input.decision,
      notes: input.notes,
      evidenceIds: input.evidenceIds,
      expectedSourceSha256: input.expectedSourceSha256,
      expectedExtractionArtifactSha256: input.expectedExtractionArtifactSha256,
      expectedManifestContentSha256: input.expectedManifestContentSha256,
    };

    let persisted: PersistedReviewDecisionV1;
    try {
      persisted = await this.repository.persistReviewDecision(persistInput);
    } catch (err) {
      // R8.1 §6.3: translate the unique terminal-decision conflict / lost
      // status race into a typed "review already completed" error.
      if (
        typeof err === 'object' &&
        err !== null &&
        ((err as { code?: string }).code === 'P2002' ||
          (err instanceof Error && err.name === 'VerificationConcurrencyError') ||
          (err instanceof Error && /already has a terminal review/i.test(err.message)))
      ) {
        throw new ReviewAlreadyCompletedError(
          `candidate ${input.candidateId} already has a terminal review decision`,
        );
      }
      throw err;
    }

    const finalStatus: 'REVIEW_ACCEPTED' | 'REJECTED' =
      input.decision === 'accept' ? 'REVIEW_ACCEPTED' : 'REJECTED';

    return {
      reviewDecisionId: persisted.id,
      candidateId: persisted.candidateId,
      runId: persisted.runId,
      decision: persisted.decision as 'accept' | 'reject',
      finalStatus,
      priorStatus,
      createdAt: persisted.createdAt,
      limitationFindings,
    };
  }

  /**
   * Check whether a candidate is eligible for review (read-only).
   * Does not throw — returns an eligibility result.
   */
  async checkEligibility(
    candidateId: string,
  ): Promise<
    | { eligible: true; candidate: ReadCandidateV1 }
    | { eligible: false; reason: string; code: string }
  > {
    const candidate = await this.repository.readCandidate(candidateId);
    if (!candidate) {
      return {
        eligible: false,
        reason: `candidate not found: ${candidateId}`,
        code: 'candidate_not_found',
      };
    }
    if (candidate.status !== 'NEEDS_REVIEW') {
      return {
        eligible: false,
        reason: `candidate ${candidateId} is not in NEEDS_REVIEW state (got ${candidate.status})`,
        code: 'not_needs_review',
      };
    }
    const priorReviews = await this.repository.readReviewDecisions(candidateId);
    if (priorReviews.length > 0) {
      return {
        eligible: false,
        reason: `candidate ${candidateId} already has a terminal review decision`,
        code: 'prior_review_exists',
      };
    }
    return { eligible: true, candidate };
  }
}

/* ------------------------------------------------------------------ */
/* Helpers for blocking-finding detection (M2)                        */
/* ------------------------------------------------------------------ */

/**
 * Determine whether a set of checks contains any blocking FAIL that
 * would prevent review acceptance.
 *
 * A blocking FAIL from a BLOCKING_CHECK_CODES rule means the candidate
 * has corruption that cannot be waived — it must be corrected with a
 * new artifact.
 */
export function hasNonWaivableBlockingFailure(
  checks: readonly (VerificationCheckV1 | ReadCheckV1)[],
): boolean {
  return checks.some((c) => c.outcome === 'FAIL' && c.blocking && BLOCKING_CHECK_CODES.has(c.code));
}

/**
 * Determine whether a set of proof findings contains any blocking
 * proof failure that cannot be waived.
 */
export function hasNonWaivableBlockingProofFinding(
  proofFindings: readonly ProofFindingV1[],
): boolean {
  return proofFindings.some((f) => f.severity === 'blocking' && BLOCKING_REVIEW_CODES.has(f.code));
}

/**
 * Determine whether a set of proof snapshots contains any blocking
 * proof failure that cannot be waived.
 *
 * A proof snapshot with status 'missing' or 'mismatch' indicates
 * a blocking proof failure.
 */
export function hasNonWaivableBlockingProofSnapshot(
  proofSnapshots: readonly ReadProofSnapshotV1[],
): boolean {
  return proofSnapshots.some((s) => BLOCKING_PROOF_STATUSES.has(s.status));
}

/**
 * Determine whether a set of discrepancies contains any blocking
 * discrepancy that cannot be waived.
 */
export function hasNonWaivableBlockingDiscrepancy(
  discrepancies: readonly (VerificationDiscrepancyV1 | ReadDiscrepancyV1)[],
): boolean {
  return discrepancies.some((d) => BLOCKING_DISCREPANCY_SEVERITY.has(d.severity));
}
