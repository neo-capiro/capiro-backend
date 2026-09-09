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
 *   - Same (old, new) pair replayed (e.g. a CLI retry) -> the second
 *     attempt's transaction loses the unique-index race to the first, rolls
 *     back entirely (nothing re-superseded, no second row), reads back the
 *     existing link, finds `newCandidateId` matches what was just
 *     requested, and returns `mode: 'already_recorded'` with the ORIGINAL
 *     persisted result.
 *   - A DIFFERENT new (or old) candidate collision (two genuinely concurrent
 *     correction attempts, or an operator error) -> the losing attempt's
 *     transaction rolls back entirely -- its own supersession attempt is
 *     undone along with the failed insert -- reads back the existing link,
 *     finds it does not match, and throws
 *     `already_corrected_by_different_candidate` naming the winning link --
 *     an explicit, auditable resolution with no side effect left behind.
 *     The loser's own new candidate row is NOT deleted or hidden; it simply
 *     is not registered as THE correction, and can itself be linked to a
 *     further correction attempt by an operator who reviews the conflict.
 */
import type { ReadCandidateV1, BudgetVerificationRepositoryV1 } from '../../verification/persistence/verification-repository.js';
import {
  evaluateCandidateCorrectionEligibilityV1,
  type CandidateCorrectionEligibilityResultV1,
} from './candidate-correction-policy-v1.js';
import type {
  CandidateCorrectionRepositoryV1,
  CandidateCorrectionRowV1,
} from './candidate-correction-repository-v1.js';

export type CandidateCorrectionErrorCodeV1 =
  | 'old_candidate_not_found'
  | 'new_candidate_not_found'
  | 'blank_reason'
  | 'blank_actor'
  | 'ineligible'
  | 'already_corrected_by_different_candidate';

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
      oldCandidateSourceDocumentId: oldCandidate.sourceDocumentId,
      oldCandidateSourceSha256: oldCandidate.sourceSha256,
      newCandidateSourceDocumentId: newCandidate.sourceDocumentId,
      newCandidateSourceSha256: newCandidate.sourceSha256,
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

    // Lost the race (or this is a literal retry of an already-completed
    // correction) -- the transaction rolled back, so THIS attempt superseded
    // nothing and inserted nothing. Read back whichever row actually won and decide.
    const winner = await this.corrections.readByOldCandidateId(oldCandidate.id);
    if (winner == null) {
      // Should be unreachable (a unique-violation on insert implies a row
      // exists), but never silently succeed on an assumption.
      throw new CandidateCorrectionError(
        'already_corrected_by_different_candidate',
        `correction insert for old candidate ${oldCandidate.id} conflicted, but no existing link could be read back`,
      );
    }
    if (winner.newCandidateId === newCandidate.id) {
      // Same pair, replayed. Idempotent success -- return the ORIGINAL
      // persisted result, not a new row.
      return {
        ...basePreview,
        mode: 'already_recorded',
        supersededScopedFactReviewIds: winner.supersededScopedFactReviewIds,
        persisted: winner,
      };
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
