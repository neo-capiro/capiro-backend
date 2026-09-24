/**
 * scoped-fact-review-v1.service -- Phase 10B-35.
 *
 * Orchestrates a SCOPED human review decision over a small explicit set of
 * verified R-2 PE-total assertions:
 *   1. load candidate / run / checks / discrepancies / proof snapshots through
 *      the existing `BudgetVerificationRepositoryV1` (read-only contract);
 *   2. reload the extraction artifact from its durable locator and recompute
 *      its content hash against the candidate's persisted hash (an artifact
 *      that no longer hashes identically is refused, never partially trusted);
 *   3. evaluate the structured policy `evaluateScopedFactReviewEligibilityV1`;
 *   4. dry-run by default -- `commit: true` persists exactly one
 *      `budget_scoped_fact_review_v1` row (approve or reject), superseding any
 *      other active approval for the same scope key in the same transaction.
 *
 * Never touches `budget_review_decision_v1`, never changes candidate status,
 * never marks the outbox row, never writes canonical or legacy PE tables. A
 * reviewer's expected hashes must all equal the candidate's own (explicit
 * binding: an approval can never silently attach to a different artifact).
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';
import { parseDefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.semantic.js';
import { sha256CanonicalJson } from '../../contracts/canonical-json.js';
import type { JsonValue } from '../../contracts/canonical-json.js';
import type { TrustedByteLocatorReader } from '../../verification/trusted-proof/trusted-byte-locator-reader.js';
import type {
  BudgetVerificationRepositoryV1,
  ReadCandidateV1,
} from '../../verification/persistence/verification-repository.js';
import {
  evaluateScopedFactReviewEligibilityV1,
  scopedFactReviewScopeKeyV1,
  type ScopedFactReviewEligibilityResultV1,
  type ScopedFactReviewScopeV1,
} from './scoped-fact-review-policy-v1.js';
import {
  computeScopedFactReviewVerificationStateHashV1,
  SCOPED_FACT_REVIEW_ELIGIBILITY_STATE_VERSION_V1,
  ScopedFactReviewWriteConflictV1,
  type ScopedFactReviewRepositoryV1,
  type ScopedFactReviewRowV1,
} from './scoped-fact-review-repository-v1.js';

/* ------------------------------------------------------------------ */
/* Ports                                                               */
/* ------------------------------------------------------------------ */

/** Loads the raw artifact bytes for a candidate's durable locator. */
export interface ScopedFactReviewArtifactLoaderV1 {
  load(input: { locator: string; candidate: ReadCandidateV1 }): Promise<Buffer>;
}

/** Filesystem locators only (local isolation / tests). S3 callers supply their own loader. */
export class FilesystemScopedFactReviewArtifactLoaderV1 implements ScopedFactReviewArtifactLoaderV1 {
  async load(input: { locator: string }): Promise<Buffer> {
    if (input.locator.startsWith('s3://')) {
      throw new ScopedFactReviewError('artifact_locator_unsupported', `filesystem loader cannot read ${input.locator}`);
    }
    return readFile(input.locator);
  }
}

/**
 * Production-capable loader: filesystem or version-pinned `s3://` (via the
 * same `TrustedByteLocatorReader` that `wireProductionProofBoundary` uses for
 * every other production_proof read in this program). No new S3 client, no
 * new locator format -- every real candidate's `extraction_artifact_locator`
 * is already written by `S3ExtractionArtifactStore` as
 * `s3://bucket/key?versionId=...`, and this reader parses that exact
 * versionId and pins the read to it rather than the bucket's current/latest
 * object. Any other scheme, a missing object, or a denied/failed read
 * surfaces as a plain `Error` from the reader, which the caller
 * (`ScopedFactReviewV1Service.review`) already wraps as `artifact_unreadable`
 * -- never a silent fallback to another version or another scheme.
 */
export class TrustedByteLocatorScopedFactReviewArtifactLoaderV1 implements ScopedFactReviewArtifactLoaderV1 {
  constructor(private readonly reader: TrustedByteLocatorReader) {}

  async load(input: { locator: string }): Promise<Buffer> {
    const located = await this.reader.read(input.locator);
    return located.bytes;
  }
}

/** Candidate row extension: the repository read contract does not expose the locator, so this service reads it separately. */
export interface ScopedFactReviewCandidateLocatorReaderV1 {
  readExtractionArtifactLocator(candidateId: string): Promise<string | null>;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export type ScopedFactReviewErrorCodeV1 =
  | 'candidate_not_found'
  | 'run_not_found'
  | 'run_candidate_mismatch'
  | 'run_not_current_for_candidate'
  | 'expected_hash_mismatch'
  | 'artifact_locator_missing'
  | 'artifact_locator_unsupported'
  | 'artifact_unreadable'
  | 'artifact_hash_mismatch'
  | 'reviewed_fact_mismatch'
  | 'blank_rationale'
  | 'scope_already_decided_on_candidate'
  | 'revocation_state_changed'
  | 'scope_state_changed'
  | 'eligibility_state_changed'
  | 'candidate_corrected_away'
  | 'ineligible'
  | 'not_active';

export class ScopedFactReviewError extends Error {
  constructor(
    public readonly code: ScopedFactReviewErrorCodeV1,
    message: string,
    public readonly eligibility?: ScopedFactReviewEligibilityResultV1,
  ) {
    super(message);
    this.name = 'ScopedFactReviewError';
  }
}

/* ------------------------------------------------------------------ */
/* Inputs / outputs                                                    */
/* ------------------------------------------------------------------ */

export interface ScopedFactReviewInputV1 {
  candidateId: string;
  runId: string;
  scope: ScopedFactReviewScopeV1;
  decision: 'approve' | 'reject';
  reviewerId: string;
  rationale: string;
  /** Reviewer-supplied limitations appended to the policy-derived ones. */
  limitations?: string[];
  expectedSourceSha256: string;
  expectedExtractionArtifactSha256: string;
  expectedManifestContentSha256: string;
  /** Exact revoked review deliberately acknowledged by this decision. Omit
   * (or null) for an initial approval; a stale/scope-only acknowledgement is
   * refused again inside the repository transaction. */
  acknowledgedRevokedReviewId?: string | null;
  /** Optional operator-reviewed fact intent. The service compares this to the
   * freshly loaded artifact projection before any repository write, so a
   * preflight-to-commit fact/citation change cannot silently authorize a
   * different value. */
  expectedReviewedFact?: ScopedFactReviewExpectedReviewedFactV1;
}

export interface ScopedFactReviewExpectedReviewedFactV1 {
  totalMillions: string;
  physicalPage: number;
  assertionIds: string[];
  evidenceIds: string[];
}

/** Decimal strings are reviewed as numeric values, not formatting tokens. */
export function scopedFactReviewDecimalValuesEqualV1(left: string, right: string): boolean {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  return Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && Math.abs(leftNumber - rightNumber) <= 1e-9;
}

export interface ScopedFactReviewPreviewV1 {
  mode: 'dry-run' | 'committed';
  candidateId: string;
  candidateStatus: string;
  runId: string;
  runDecision: string;
  scopeKey: string;
  decision: 'approve' | 'reject';
  eligibility: ScopedFactReviewEligibilityResultV1;
  eligibilityStateVersion: typeof SCOPED_FACT_REVIEW_ELIGIBILITY_STATE_VERSION_V1;
  eligibilityStateSha256: string;
  existingActiveDecisionsForScope: Array<{ id: string; candidateId: string; decision: string; createdAt: string }>;
  persisted: { id: string; decisionHash: string; supersededIds: string[] } | null;
}

/** Deterministic hash over the decision's own bound identity fields (canonical JSON). */
export function computeScopedFactReviewDecisionHashV1(input: {
  candidateId: string;
  runId: string;
  sourceSha256: string;
  extractionArtifactSha256: string;
  manifestContentSha256: string;
  policyId: string;
  policyVersion: string;
  policySha256: string;
  scopeKind: string;
  scopeKey: string;
  assertionIds: string[];
  decision: 'approve' | 'reject';
  reviewerId: string;
  rationale: string;
  acknowledgedRevokedReviewId: string | null;
  eligibilityStateVersion?: string | null;
  eligibilityStateSha256?: string | null;
}): string {
  // `rationale` itself is deliberately excluded from the hashed payload (free
  // text shouldn't gate the decision's identity hash byte-for-byte) -- but
  // `sha256CanonicalJson` refuses any `undefined` value as not JSON-safe, so
  // the key must be OMITTED, never set to `undefined`.
  const {
    rationale,
    acknowledgedRevokedReviewId,
    eligibilityStateVersion,
    eligibilityStateSha256,
    ...rest
  } = input;
  return sha256CanonicalJson({
    ...rest,
    // Backward-compatible hash-v1 semantics: every row created before the
    // exact-revocation-ack column existed omitted this key entirely. NULL
    // acknowledgements must continue to hash identically; only an intentional
    // reapproval binds the new key/value into its immutable decision hash.
    ...(acknowledgedRevokedReviewId == null ? {} : { acknowledgedRevokedReviewId }),
    ...(eligibilityStateVersion == null || eligibilityStateSha256 == null
      ? {}
      : { eligibilityStateVersion, eligibilityStateSha256 }),
    assertionIds: [...input.assertionIds].sort(),
    rationaleSha256: createHash('sha256').update(rationale, 'utf8').digest('hex'),
  } as unknown as JsonValue);
}

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

export class ScopedFactReviewV1Service {
  constructor(
    private readonly verification: BudgetVerificationRepositoryV1,
    private readonly locators: ScopedFactReviewCandidateLocatorReaderV1,
    private readonly artifacts: ScopedFactReviewArtifactLoaderV1,
    private readonly reviews: ScopedFactReviewRepositoryV1,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  /** Dry-run by default. `commit: true` persists the decision when eligible (approve) or always (reject). */
  async review(input: ScopedFactReviewInputV1, options: { commit?: boolean } = {}): Promise<ScopedFactReviewPreviewV1> {
    if (input.rationale.trim().length === 0) {
      throw new ScopedFactReviewError('blank_rationale', 'rationale must not be blank');
    }
    const candidate = await this.verification.readCandidate(input.candidateId);
    if (candidate == null) throw new ScopedFactReviewError('candidate_not_found', `candidate ${input.candidateId} not found`);
    const run = await this.verification.readRun(input.runId);
    if (run == null) throw new ScopedFactReviewError('run_not_found', `run ${input.runId} not found`);
  if (run.candidateId !== candidate.id) {
    throw new ScopedFactReviewError('run_candidate_mismatch', `run ${run.id} belongs to candidate ${run.candidateId}`);
  }
    if (candidate.currentRunId == null || candidate.currentRunId !== run.id) {
      throw new ScopedFactReviewError(
        'run_not_current_for_candidate',
        `run ${run.id} is not candidate ${candidate.id}'s exact current run (${candidate.currentRunId ?? 'none'})`,
      );
    }
    if (
      input.expectedSourceSha256 !== candidate.sourceSha256 ||
      input.expectedExtractionArtifactSha256 !== candidate.extractionArtifactSha256 ||
      input.expectedManifestContentSha256 !== candidate.manifestContentSha256
    ) {
      throw new ScopedFactReviewError(
        'expected_hash_mismatch',
        `reviewer-supplied hashes do not match candidate ${candidate.id} (source ${candidate.sourceSha256}, artifact ${candidate.extractionArtifactSha256}, manifest ${candidate.manifestContentSha256})`,
      );
    }

    const locator = await this.locators.readExtractionArtifactLocator(candidate.id);
    if (locator == null) throw new ScopedFactReviewError('artifact_locator_missing', `candidate ${candidate.id} has no extraction artifact locator`);
    let artifact: DefenseBudgetExtractionArtifactV1;
    try {
      const bytes = await this.artifacts.load({ locator, candidate });
      artifact = parseDefenseBudgetExtractionArtifactV1(JSON.parse(bytes.toString('utf8')));
    } catch (error) {
      if (error instanceof ScopedFactReviewError) throw error;
      throw new ScopedFactReviewError('artifact_unreadable', `could not load artifact ${locator}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (artifact.artifactId !== candidate.extractionArtifactId) {
      throw new ScopedFactReviewError(
        'artifact_hash_mismatch',
        `reloaded artifact id ${artifact.artifactId} != candidate artifact id ${candidate.extractionArtifactId}`,
      );
    }

    const [checks, discrepancies, proofSnapshots] = await Promise.all([
      this.verification.readChecks(run.id),
      this.verification.readDiscrepancies(run.id),
      this.verification.readProofSnapshots(run.id),
    ]);
    const eligibilityStateSha256 = computeScopedFactReviewVerificationStateHashV1({
      run,
      checks,
      discrepancies,
      proofSnapshots,
    });

    const eligibility = evaluateScopedFactReviewEligibilityV1({
      candidate,
      run,
      checks,
      discrepancies,
      proofSnapshots,
      artifact,
      scope: input.scope,
    });
    if (input.expectedReviewedFact != null) {
      const expected = input.expectedReviewedFact;
      const differences: string[] = [];
      if (eligibility.projection == null) {
        differences.push('projection is unavailable');
      } else {
        if (!scopedFactReviewDecimalValuesEqualV1(eligibility.projection.totalMillions, expected.totalMillions)) {
          differences.push(
            `totalMillions=${eligibility.projection.totalMillions} expected ${expected.totalMillions}`,
          );
        }
        if (eligibility.projection.source.physicalPage !== expected.physicalPage) {
          differences.push(
            `physicalPage=${eligibility.projection.source.physicalPage} expected ${expected.physicalPage}`,
          );
        }
      }
      const observedAssertionIds = [...eligibility.assertionIds].sort();
      const expectedAssertionIds = [...expected.assertionIds].sort();
      if (JSON.stringify(observedAssertionIds) !== JSON.stringify(expectedAssertionIds)) {
        differences.push(
          `assertionIds=${JSON.stringify(observedAssertionIds)} expected ${JSON.stringify(expectedAssertionIds)}`,
        );
      }
      const observedEvidenceIds = [...eligibility.evidenceIds].sort();
      const expectedEvidenceIds = [...expected.evidenceIds].sort();
      if (JSON.stringify(observedEvidenceIds) !== JSON.stringify(expectedEvidenceIds)) {
        differences.push(
          `evidenceIds=${JSON.stringify(observedEvidenceIds)} expected ${JSON.stringify(expectedEvidenceIds)}`,
        );
      }
      if (differences.length > 0) {
        throw new ScopedFactReviewError(
          'reviewed_fact_mismatch',
          `reviewed fact intent no longer matches ${scopedFactReviewScopeKeyV1(input.scope)}: ${differences.join(', ')}`,
          eligibility,
        );
      }
    }
    const scopeKey = scopedFactReviewScopeKeyV1(input.scope);
    const existing = await this.reviews.listActiveByScopeKey(input.scope.scopeKind, scopeKey);
    const existingForCandidate = existing.filter((r) => r.candidateId === candidate.id);

    const preview: ScopedFactReviewPreviewV1 = {
      mode: 'dry-run',
      candidateId: candidate.id,
      candidateStatus: candidate.status,
      runId: run.id,
      runDecision: run.decision,
      scopeKey,
      decision: input.decision,
      eligibility,
      eligibilityStateVersion: SCOPED_FACT_REVIEW_ELIGIBILITY_STATE_VERSION_V1,
      eligibilityStateSha256,
      existingActiveDecisionsForScope: existing.map((r) => ({ id: r.id, candidateId: r.candidateId, decision: r.decision, createdAt: r.createdAt })),
      persisted: null,
    };

    if (!options.commit) return preview;

    if (existingForCandidate.length > 0) {
      throw new ScopedFactReviewError(
        'scope_already_decided_on_candidate',
        `candidate ${candidate.id} already has an active scoped decision for ${scopeKey} (${existingForCandidate.map((r) => `${r.id}:${r.decision}`).join(', ')}); revoke it first`,
      );
    }
    if (input.decision === 'approve' && !eligibility.eligible) {
      throw new ScopedFactReviewError(
        'ineligible',
        `scoped approval refused for ${scopeKey}: ${eligibility.refusalReasons.map((r) => r.code).join(', ')}`,
        eligibility,
      );
    }

    const limitations = [...eligibility.limitations, ...(input.limitations ?? [])];
    const decisionHash = computeScopedFactReviewDecisionHashV1({
      candidateId: candidate.id,
      runId: run.id,
      sourceSha256: candidate.sourceSha256,
      extractionArtifactSha256: candidate.extractionArtifactSha256,
      manifestContentSha256: candidate.manifestContentSha256,
      policyId: eligibility.policy.id,
      policyVersion: eligibility.policy.version,
      policySha256: eligibility.policy.sha256,
      scopeKind: input.scope.scopeKind,
      scopeKey,
      assertionIds: eligibility.assertionIds,
      decision: input.decision,
      reviewerId: input.reviewerId,
      rationale: input.rationale,
      acknowledgedRevokedReviewId: input.acknowledgedRevokedReviewId ?? null,
      eligibilityStateVersion: SCOPED_FACT_REVIEW_ELIGIBILITY_STATE_VERSION_V1,
      eligibilityStateSha256,
    });
    let persisted;
    try {
      persisted = await this.reviews.insertDecision({
        candidateId: candidate.id,
        runId: run.id,
        sourceDocumentId: candidate.sourceDocumentId,
        sourceSha256: candidate.sourceSha256,
        extractionArtifactId: candidate.extractionArtifactId,
        extractionArtifactSha256: candidate.extractionArtifactSha256,
        manifestContentSha256: candidate.manifestContentSha256,
        policyId: eligibility.policy.id,
        policyVersion: eligibility.policy.version,
        policySha256: eligibility.policy.sha256,
        scopeKind: input.scope.scopeKind,
        scopeKey,
        scope: input.scope,
        assertionIds: eligibility.assertionIds,
        evidenceIds: eligibility.evidenceIds,
        projection: eligibility.projection,
        independence: eligibility.independence,
        limitations,
        decision: input.decision,
        reviewerId: input.reviewerId,
        rationale: input.rationale,
        decisionHash,
        eligibilityStateVersion: SCOPED_FACT_REVIEW_ELIGIBILITY_STATE_VERSION_V1,
        eligibilityStateSha256,
        acknowledgedRevokedReviewId: input.acknowledgedRevokedReviewId ?? null,
        now: this.clock(),
      });
    } catch (error) {
      if (error instanceof ScopedFactReviewWriteConflictV1) {
        const code =
          error.code === 'revocation_precondition_changed'
            ? 'revocation_state_changed'
            : error.code === 'active_decision_changed'
              ? 'scope_state_changed'
              : error.code === 'eligibility_state_changed'
                ? 'eligibility_state_changed'
              : error.code === 'candidate_corrected_away'
                ? 'candidate_corrected_away'
                : 'expected_hash_mismatch';
        throw new ScopedFactReviewError(code, error.message, eligibility);
      }
      throw error;
    }
    return {
      ...preview,
      mode: 'committed',
      persisted: { id: persisted.row.id, decisionHash, supersededIds: persisted.supersededIds },
    };
  }

  async revoke(input: { id: string; actor: string; reason: string }): Promise<ScopedFactReviewRowV1> {
    if (input.reason.trim().length === 0) throw new ScopedFactReviewError('blank_rationale', 'revocation reason must not be blank');
    const row = await this.reviews.revoke({ ...input, now: this.clock() });
    if (row == null) throw new ScopedFactReviewError('not_active', `scoped review ${input.id} is not active (or does not exist)`);
    return row;
  }
}
