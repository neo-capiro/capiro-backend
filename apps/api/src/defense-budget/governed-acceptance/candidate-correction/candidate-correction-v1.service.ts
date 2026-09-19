/**
 * candidate-correction-v1.service -- Phase 10B-35c.
 *
 * Orchestrates recording that a NEW candidate corrects an OLD one:
 *   1. load both candidates through the existing `BudgetVerificationRepositoryV1`
 *      (read-only contract, same one `ScopedFactReviewV1Service` uses);
 *   2. evaluate `evaluateCandidateCorrectionEligibilityV1`;
 *   3. dry-run by default -- `commit: true` calls
 *      `CandidateCorrectionRepositoryV1.commitCorrection()`, which
 *      ATOMICALLY (one DB transaction) supersedes the OLD candidate's
 *      currently-active scoped-fact-review rows AND inserts the link row.
 *      The DB's unique index on `old_candidate_id` (and, independently, on
 *      `new_candidate_id`) is the single source of truth for "has this
 *      pairing already been claimed" -- this method never trusts a prior
 *      read for that decision, and a refused/conflicting attempt performs
 *      ZERO writes because the whole transaction rolls back together. (An
 *      earlier version called supersede-then-insert as two separate
 *      top-level statements; independent review found that a losing insert
 *      -- e.g. the new candidate was already claimed by correcting a
 *      DIFFERENT old candidate -- left the supersession already committed,
 *      silently destroying a real decision with no link to explain why.
 *      Fixed 2026-09-09 by moving both writes into one transaction.)
 *
 * Never touches `budget_review_decision_v1`, never changes ANY candidate's
 * status, never writes canonical/legacy tables, never issues a bulk
 * operation (exactly one named old/new pair per call).
 *
 * Idempotency / concurrency, precisely:
 *   - Same (old, new) pair replayed -> the graph-serialized transaction
 *     returns the authoritative existing link and this service reports
 *     `mode: 'already_recorded'` with its ORIGINAL persisted result.
 *   - A different old/new collision returns which uniqueness rail owns the
 *     conflict. Old-candidate and new-candidate claims have distinct typed
 *     errors; neither is mislabeled as a winner on a different rail.
 *   - Eligibility drift and reverse/cycle state are rechecked under the graph
 *     and candidate locks and returned as named, zero-write refusals.
 *   Every refused transaction leaves existing approvals and links unchanged.
 *
 *   The loser's own new candidate row is NOT deleted or hidden; it simply
 *   is not registered as THE correction, and can itself be linked to a
 *   further correction attempt by an operator who reviews the conflict.
 */
import type { ReadCandidateV1, BudgetVerificationRepositoryV1 } from '../../verification/persistence/verification-repository.js';
import {
  evaluateCandidateCorrectionEligibilityV1,
  type CandidateCorrectionEligibilityResultV1,
} from './candidate-correction-policy-v1.js';
import type {
  CandidateCorrectionReviewedScopeV1,
  CandidateCorrectionRepositoryV1,
  CandidateCorrectionRowV1,
} from './candidate-correction-repository-v1.js';
import {
  buildCandidateCorrectionReviewedIntentV1,
  computeCandidateCorrectionReviewedIntentCanonicalSha256V1,
} from './candidate-correction-repository-v1.js';

export type CandidateCorrectionErrorCodeV1 =
  | 'old_candidate_not_found'
  | 'new_candidate_not_found'
  | 'blank_reason'
  | 'blank_actor'
  | 'ineligible'
  | 'already_corrected_by_different_candidate'
  | 'new_candidate_already_claimed'
  | 'reverse_or_cycle_conflict'
  | 'correction_intent_mismatch'
  | 'stale_eligibility';

export class CandidateCorrectionError extends Error {
  constructor(
    public readonly code: CandidateCorrectionErrorCodeV1,
    message: string,
    public readonly eligibility?: CandidateCorrectionEligibilityResultV1,
    public readonly existingLink?: CandidateCorrectionRowV1,
  ) {
    super(message);
    this.name = 'CandidateCorrectionError';
  }
}

export interface CandidateCorrectionInputV1 {
  oldCandidateId: string;
  newCandidateId: string;
  actor: string;
  reason: string;
  /** Operator-reviewed immutable intent. When supplied, both the preview and
   * the transactional repository boundary must still match these exact
   * run/source/artifact/manifest identities. */
  expectedOldCandidateIdentity?: CandidateCorrectionExpectedCandidateIdentityV1;
  expectedNewCandidateIdentity?: CandidateCorrectionExpectedCandidateIdentityV1;
  /** Exact manifest scopes reviewed as part of this operation. Persisted on
   * the append-only correction link; an empty list means this correction was
   * not coupled to a scoped-approval replacement batch. */
  selectedScopes?: CandidateCorrectionReviewedScopeV1[];
}

export interface CandidateCorrectionExpectedCandidateIdentityV1 {
  currentRunId: string | null;
  sourceDocumentId: string;
  sourceSha256: string;
  extractionArtifactId: string;
  extractionArtifactSha256: string;
  manifestContentSha256: string;
}

function candidateIdentitySnapshotV1(candidate: ReadCandidateV1): CandidateCorrectionExpectedCandidateIdentityV1 {
  return {
    currentRunId: candidate.currentRunId,
    sourceDocumentId: candidate.sourceDocumentId,
    sourceSha256: candidate.sourceSha256,
    extractionArtifactId: candidate.extractionArtifactId,
    extractionArtifactSha256: candidate.extractionArtifactSha256,
    manifestContentSha256: candidate.manifestContentSha256,
  };
}

function candidateIdentityDifferencesV1(
  label: 'old' | 'new',
  expected: CandidateCorrectionExpectedCandidateIdentityV1,
  observed: ReadCandidateV1,
): string[] {
  const differences: string[] = [];
  const compare = (field: keyof CandidateCorrectionExpectedCandidateIdentityV1): void => {
    if (observed[field] !== expected[field]) {
      differences.push(`${label}.${field}=${String(observed[field])} expected ${String(expected[field])}`);
    }
  };
  compare('currentRunId');
  compare('sourceDocumentId');
  compare('sourceSha256');
  compare('extractionArtifactId');
  compare('extractionArtifactSha256');
  compare('manifestContentSha256');
  return differences;
}

export interface CandidateCorrectionPreviewV1 {
  mode: 'dry-run' | 'committed' | 'already_recorded';
  oldCandidateId: string;
  oldCandidateStatus: string;
  newCandidateId: string;
  newCandidateStatus: string;
  eligibility: CandidateCorrectionEligibilityResultV1;
  existingLinkForOldCandidate: CandidateCorrectionRowV1 | null;
  supersededScopedFactReviewIds: string[];
  persisted: CandidateCorrectionRowV1 | null;
}

export class CandidateCorrectionV1Service {
  constructor(
    private readonly verification: BudgetVerificationRepositoryV1,
    private readonly corrections: CandidateCorrectionRepositoryV1,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  /** Dry-run by default. `commit: true` persists the correction link when eligible. */
  async correct(input: CandidateCorrectionInputV1, options: { commit?: boolean } = {}): Promise<CandidateCorrectionPreviewV1> {
    if (input.actor.trim().length === 0) {
      throw new CandidateCorrectionError('blank_actor', 'actor must not be blank');
    }
    if (input.reason.trim().length === 0) {
      throw new CandidateCorrectionError('blank_reason', 'reason must not be blank');
    }

    const oldCandidate = await this.verification.readCandidate(input.oldCandidateId);
    if (oldCandidate == null) {
      throw new CandidateCorrectionError('old_candidate_not_found', `candidate ${input.oldCandidateId} not found`);
    }
    const newCandidate = await this.verification.readCandidate(input.newCandidateId);
    if (newCandidate == null) {
      throw new CandidateCorrectionError('new_candidate_not_found', `candidate ${input.newCandidateId} not found`);
    }

    const expectedOldCandidateIdentity = input.expectedOldCandidateIdentity ?? candidateIdentitySnapshotV1(oldCandidate);
    const expectedNewCandidateIdentity = input.expectedNewCandidateIdentity ?? candidateIdentitySnapshotV1(newCandidate);
    const reviewedIdentityDifferences = [
      ...candidateIdentityDifferencesV1('old', expectedOldCandidateIdentity, oldCandidate),
      ...candidateIdentityDifferencesV1('new', expectedNewCandidateIdentity, newCandidate),
    ];
    if (reviewedIdentityDifferences.length > 0) {
      throw new CandidateCorrectionError(
        'stale_eligibility',
        `correction refused because reviewed candidate intent is stale: ${reviewedIdentityDifferences.join(', ')}`,
      );
    }

    // Reverse-correction guard (fires BEFORE any write, including for a
    // dry-run preview): read whether the NEW candidate already stands as the
    // OLD side of some other existing link. Pure I/O read, no mutation --
    // the actual refusal is decided by the pure policy function below.
    const newCandidateExistingOldLink = await this.corrections.readByOldCandidateId(newCandidate.id);

    const eligibility = evaluateCandidateCorrectionEligibilityV1({
      oldCandidate: {
        id: oldCandidate.id,
        status: oldCandidate.status,
        sourceDocumentId: oldCandidate.sourceDocumentId,
        sourceSha256: oldCandidate.sourceSha256,
      },
      newCandidate: {
        id: newCandidate.id,
        status: newCandidate.status,
        sourceDocumentId: newCandidate.sourceDocumentId,
        sourceSha256: newCandidate.sourceSha256,
      },
    });

    const existingLinkForOldCandidate = await this.corrections.readByOldCandidateId(oldCandidate.id);

    const basePreview = {
      oldCandidateId: oldCandidate.id,
      oldCandidateStatus: oldCandidate.status,
      newCandidateId: newCandidate.id,
      newCandidateStatus: newCandidate.status,
      eligibility,
      existingLinkForOldCandidate,
    };

    if (!options.commit) {
      return {
        ...basePreview,
        mode: 'dry-run',
        supersededScopedFactReviewIds: existingLinkForOldCandidate?.supersededScopedFactReviewIds ?? [],
        persisted: null,
      };
    }

    if (!eligibility.eligible) {
      throw new CandidateCorrectionError(
        'ineligible',
        `correction refused for old candidate ${oldCandidate.id} -> new candidate ${newCandidate.id}: ${eligibility.refusalReasons.map((r) => r.code).join(', ')}`,
        eligibility,
      );
    }

    // Atomically (one DB transaction): supersede the old candidate's active
    // scoped-fact-review rows AND insert the correction link. If the insert
    // loses the unique-index race on EITHER column, the whole transaction
    // rolls back -- the supersession never happens either. See this file's
    // top-of-file comment for why this must be one operation, not two.
    const reasonForSupersession = `superseded: candidate ${oldCandidate.id} corrected by candidate ${newCandidate.id} (${input.reason})`;
    const commitResult = await this.corrections.commitCorrection({
      oldCandidateId: oldCandidate.id,
      newCandidateId: newCandidate.id,
      oldCandidateStatusAtCorrection: oldCandidate.status,
      oldCandidateCurrentRunId: expectedOldCandidateIdentity.currentRunId,
      oldCandidateSourceDocumentId: expectedOldCandidateIdentity.sourceDocumentId,
      oldCandidateSourceSha256: expectedOldCandidateIdentity.sourceSha256,
      oldCandidateExtractionArtifactId: expectedOldCandidateIdentity.extractionArtifactId,
      oldCandidateExtractionArtifactSha256: expectedOldCandidateIdentity.extractionArtifactSha256,
      oldCandidateManifestContentSha256: expectedOldCandidateIdentity.manifestContentSha256,
      newCandidateCurrentRunId: expectedNewCandidateIdentity.currentRunId,
      newCandidateSourceDocumentId: expectedNewCandidateIdentity.sourceDocumentId,
      newCandidateSourceSha256: expectedNewCandidateIdentity.sourceSha256,
      newCandidateExtractionArtifactId: expectedNewCandidateIdentity.extractionArtifactId,
      newCandidateExtractionArtifactSha256: expectedNewCandidateIdentity.extractionArtifactSha256,
      newCandidateManifestContentSha256: expectedNewCandidateIdentity.manifestContentSha256,
      selectedScopes: input.selectedScopes ?? [],
      actor: input.actor,
      reason: input.reason,
      supersessionReason: reasonForSupersession,
      now: this.clock(),
    });

    if (commitResult.outcome === 'inserted') {
      return {
        ...basePreview,
        mode: 'committed',
        supersededScopedFactReviewIds: commitResult.supersededScopedFactReviewIds,
        persisted: commitResult.row,
      };
    }

    if (commitResult.outcome === 'stale_eligibility') {
      throw new CandidateCorrectionError(
        'stale_eligibility',
        `correction refused at the transactional write boundary for old candidate ${oldCandidate.id} -> ` +
          `new candidate ${newCandidate.id}: ${commitResult.detail}. Re-run the preview against current candidate state.`,
        eligibility,
      );
    }

    if (commitResult.outcome === 'reverse_or_cycle_conflict') {
      const authoritativeEligibility = evaluateCandidateCorrectionEligibilityV1({
        oldCandidate: {
          id: oldCandidate.id,
          status: oldCandidate.status,
          sourceDocumentId: oldCandidate.sourceDocumentId,
          sourceSha256: oldCandidate.sourceSha256,
        },
        newCandidate: {
          id: newCandidate.id,
          status: newCandidate.status,
          sourceDocumentId: newCandidate.sourceDocumentId,
          sourceSha256: newCandidate.sourceSha256,
        },
        newCandidateAlreadyCorrectedIntoAnotherCandidate: true,
      });
      throw new CandidateCorrectionError(
        'reverse_or_cycle_conflict',
        `correction refused at the transactional write boundary: new candidate ${newCandidate.id} already stands ` +
          `on the corrected-away side of the correction graph${commitResult.existingLink == null ? '' : ` (link ${commitResult.existingLink.id})`}. ` +
          'Continue forward from the latest candidate; do not reverse an append-only correction.',
        authoritativeEligibility,
        commitResult.existingLink ?? undefined,
      );
    }

    const winner = commitResult.existingLink;
    if (commitResult.conflictOn === 'old_candidate' && winner.newCandidateId === newCandidate.id) {
      const requestedIntent = buildCandidateCorrectionReviewedIntentV1({
        oldCandidateId: oldCandidate.id,
        newCandidateId: newCandidate.id,
        oldCandidateCurrentRunId: expectedOldCandidateIdentity.currentRunId,
        oldCandidateSourceDocumentId: expectedOldCandidateIdentity.sourceDocumentId,
        oldCandidateSourceSha256: expectedOldCandidateIdentity.sourceSha256,
        oldCandidateExtractionArtifactId: expectedOldCandidateIdentity.extractionArtifactId,
        oldCandidateExtractionArtifactSha256: expectedOldCandidateIdentity.extractionArtifactSha256,
        oldCandidateManifestContentSha256: expectedOldCandidateIdentity.manifestContentSha256,
        newCandidateCurrentRunId: expectedNewCandidateIdentity.currentRunId,
        newCandidateSourceDocumentId: expectedNewCandidateIdentity.sourceDocumentId,
        newCandidateSourceSha256: expectedNewCandidateIdentity.sourceSha256,
        newCandidateExtractionArtifactId: expectedNewCandidateIdentity.extractionArtifactId,
        newCandidateExtractionArtifactSha256: expectedNewCandidateIdentity.extractionArtifactSha256,
        newCandidateManifestContentSha256: expectedNewCandidateIdentity.manifestContentSha256,
        selectedScopes: input.selectedScopes ?? [],
      });
      const requestedIntentSha256 = computeCandidateCorrectionReviewedIntentCanonicalSha256V1(requestedIntent);
      const persistedIntentSha256 =
        winner.reviewedIntent == null
          ? null
          : computeCandidateCorrectionReviewedIntentCanonicalSha256V1(winner.reviewedIntent);
      if (
        winner.reviewedIntentVersion !== 1 ||
        winner.reviewedIntent == null ||
        persistedIntentSha256 !== requestedIntentSha256
      ) {
        throw new CandidateCorrectionError(
          'correction_intent_mismatch',
          `same-pair correction link ${winner.id} exists, but its immutable reviewed operation intent ` +
            `${persistedIntentSha256 ?? 'legacy/unbound'} does not match requested intent ${requestedIntentSha256}; ` +
            'the existing link was preserved and this attempt made zero writes',
          eligibility,
          winner,
        );
      }
      // Same pair, replayed. Idempotent success -- return the ORIGINAL
      // persisted result, not a new row.
      return {
        ...basePreview,
        mode: 'already_recorded',
        supersededScopedFactReviewIds: winner.supersededScopedFactReviewIds,
        persisted: winner,
      };
    }

    if (commitResult.conflictOn === 'new_candidate') {
      throw new CandidateCorrectionError(
        'new_candidate_already_claimed',
        `new candidate ${newCandidate.id} already corrects old candidate ${winner.oldCandidateId} ` +
          `(link ${winner.id}, recorded ${winner.createdAt}); requested old candidate ${oldCandidate.id} was refused. ` +
          'The existing append-only link was preserved and this attempt made zero writes.',
        eligibility,
        winner,
      );
    }

    throw new CandidateCorrectionError(
      'already_corrected_by_different_candidate',
      `old candidate ${oldCandidate.id} was already corrected by candidate ${winner.newCandidateId} (link ${winner.id}, recorded ${winner.createdAt}); ` +
        `requested new candidate ${newCandidate.id} was refused. This is an explicit conflict, not silently resolved -- ` +
        'an operator must decide whether the existing link or this attempt is correct.',
      eligibility,
      winner,
    );
  }

  async readByOldCandidateId(oldCandidateId: string): Promise<CandidateCorrectionRowV1 | null> {
    return this.corrections.readByOldCandidateId(oldCandidateId);
  }

  async readByNewCandidateId(newCandidateId: string): Promise<CandidateCorrectionRowV1 | null> {
    return this.corrections.readByNewCandidateId(newCandidateId);
  }
}

// Re-exported for callers that only need the candidate snapshot shape (e.g.
// CLI scripts formatting a preview) without importing the whole verification
// repository module.
export type { ReadCandidateV1 };
