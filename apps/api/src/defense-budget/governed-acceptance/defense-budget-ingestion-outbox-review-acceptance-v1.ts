/**
 * Phase 10B-15 Parts D/E/F -- exact-row governed REVIEW acceptance for a
 * terminal `dead_letter` governed-ingestion-outbox row.
 *
 * Separate from, and never reusing, `replayDeadLetterForVerifierFixV1`
 * (governed-replay/defense-budget-ingestion-outbox-replay-v1.ts): that
 * command is intentionally for `governedDisposition:'verification_rejected'`
 * + `verifierDecision:'REJECT'` rows being retried after a code/policy fix,
 * and its own SQL predicate refuses any row whose `verifierDecision` is not
 * exactly `'REJECT'` -- it will never touch a REVIEW row, by construction.
 * This module is the mirror-image command for the opposite terminal
 * disposition: `governedDisposition:'review_required'` +
 * `verifierDecision:'REVIEW'`, advanced not by a code fix but by an
 * immutable human acceptance.
 *
 * The verifier decision itself is NEVER changed. `parserVerificationSucceeded`
 * (observation-ingestion-bridge.service.ts) continues to mean exactly
 * `decision === 'PASS'` -- untouched by this module. `verifierDecision:
 * 'REVIEW'` is preserved at the top level of the outbox row's metadata
 * forever; this transition adds a separate, additive fact
 * (`ingestionResolution: 'governed_review_accepted'`) recording HOW a
 * REVIEW row reached `succeeded`, rather than overwriting or hiding WHAT
 * the verifier actually decided. The underlying `BudgetVerificationRunV1`
 * row is read-only here and is never mutated.
 *
 * Binding (Part D): reuses the existing `BudgetReviewDecisionV1` model and
 * its FK relations exactly as they exist today -- no new human-review model,
 * no new schema field. A `BudgetReviewDecisionV1` row already binds, via its
 * own columns and FKs: the verification candidate (`candidateId`), the
 * verification run (`runId`, cross-checked in the same query to belong to
 * that candidate), the artifact content SHA (`extractionArtifactSha256`,
 * cross-checked equal to the candidate's own), and `decision='accept'`. The
 * one real gap: `BudgetReviewDecisionV1` has no direct `sourceDocumentId` or
 * policy-version column of its own -- those exist only transitively via its
 * `candidate` relation. This module closes that gap with a join rather than
 * inventing a new field, matching the source document identity against the
 * exact `sourceDocumentId` the outbox row's own metadata already carries
 * (written by the observation-ingestion-bridge at governance time) -- this
 * is what makes "wrong artifact/candidate/run/cycle" a structural
 * impossibility rather than a policy convention.
 *
 * Eligibility (Part C) is evaluated separately, against the run's own
 * immutable, already-persisted checks/discrepancies (see
 * `evaluateR1ReviewAcceptanceEligibilityV1`) -- those rows cannot change
 * after the run completes, so reading them before the atomic mutation
 * carries no race risk; the row-mutation-critical facts (outbox state,
 * lease, exact sourceDocumentId match) are re-validated inside the single
 * atomic UPDATE's own WHERE clause, under `FOR UPDATE`, exactly like the
 * replay module.
 */
import { createHash } from 'node:crypto';
import {
  evaluateR1ReviewAcceptanceEligibilityV1,
  type ReviewAcceptanceEligibilityResultV1,
} from './rdte-r1-review-acceptance-eligibility-v1.js';
import type {
  BudgetVerificationRepositoryV1,
  ReadCheckV1,
  ReadDiscrepancyV1,
} from '../verification/persistence/verification-repository.js';

export class ReviewAcceptanceValidationErrorV1 extends Error {}

export interface ReviewAcceptanceRequestV1 {
  rowId: string;
  reviewDecisionId: string;
  now: Date;
  /** Explicit operator identity. Required -- fails closed if blank. */
  actor: string;
  /** Explicit operator reason. Required -- fails closed if blank. */
  reason: string;
}

export interface ReviewAcceptancePreviewV1 {
  id: string;
  state: string;
  governedDisposition: string | null;
  verifierDecision: string | null;
  sourceDocumentId: string | null;
  leasedBy: string | null;
}

export type ReviewAcceptanceOutcomeV1 =
  | { ok: true; id: string; readinessPhase: 'pending' }
  | {
      ok: false;
      reason:
        | 'row_not_found'
        | 'row_not_eligible_disposition'
        | 'review_decision_not_found'
        | 'review_decision_not_accept'
        | 'review_run_not_review_decision'
        | 'review_binding_mismatch'
        | 'source_document_mismatch'
        | 'acceptance_ineligible'
        | 'concurrent_mutation_lost';
      detail: string;
      eligibility?: ReviewAcceptanceEligibilityResultV1;
    };

export type ReviewAcceptanceEligibilityCheckV1 =
  | {
      ok: true;
      outboxSourceDocumentId: string;
      runId: string;
      reviewDecisionHash: string;
      eligibility: ReviewAcceptanceEligibilityResultV1;
    }
  | Extract<ReviewAcceptanceOutcomeV1, { ok: false }>;

export interface ReviewAcceptanceRepositoryV1 {
  /** Read-only. Prints the exact target row's current disposition before any mutation. */
  previewAcceptanceTarget(rowId: string): Promise<ReviewAcceptancePreviewV1 | null>;
  /**
   * Read-only. Runs the FULL binding + eligibility pipeline
   * `acceptReviewedIngestionV1` would, stopping just short of the mutating
   * UPDATE -- true dry-run support: an operator or CLI can see exactly
   * whether an acceptance would succeed without ever issuing a write.
   */
  previewAcceptanceEligibility(input: {
    rowId: string;
    reviewDecisionId: string;
  }): Promise<ReviewAcceptanceEligibilityCheckV1>;
  /**
   * Requires: the row is currently an eligible verifier-REVIEW `dead_letter`
   * row, unleased; the named review decision exists, is `decision='accept'`,
   * and binds (candidate/run/artifact-SHA/source-document) to exactly this
   * row; and the run's own checks/discrepancies satisfy the R-1 acceptance-
   * eligibility policy. Never throws for a business-rule mismatch -- returns
   * a discriminated `{ok:false, reason, detail}` instead, so an operator or
   * test can see exactly why. Throws `ReviewAcceptanceValidationErrorV1`
   * only for a caller-side contract violation (blank ids/actor/reason),
   * which must be caught before ever reaching the database.
   */
  acceptReviewedIngestionV1(input: ReviewAcceptanceRequestV1): Promise<ReviewAcceptanceOutcomeV1>;
}

export interface ReviewAcceptancePrismaLikeV1 {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

const ELIGIBLE_GOVERNED_DISPOSITION = 'review_required';
const ELIGIBLE_VERIFIER_DECISION = 'REVIEW';

export function reviewAcceptancePreviewSqlV1(): string {
  return `SELECT "id", "state",
   "metadata_jsonb"->>'governedDisposition' AS governed_disposition,
   "metadata_jsonb"->>'verifierDecision' AS verifier_decision,
   "metadata_jsonb"->>'sourceDocumentId' AS source_document_id,
   "leased_by"
 FROM "defense_budget_ingestion_outbox" WHERE "id"=$1::uuid`;
}

/** Reads the review decision together with its bound run+candidate, in one query. Never a write. */
function reviewDecisionBindingSqlV1(): string {
  return `SELECT
   rd."id" AS review_decision_id, rd."candidate_id", rd."run_id", rd."decision" AS review_decision,
   rd."source_sha256" AS rd_source_sha256, rd."extraction_artifact_sha256" AS rd_artifact_sha256,
   rd."manifest_content_sha256" AS rd_manifest_sha256, rd."created_at" AS review_decision_created_at,
   run."decision" AS run_decision, run."candidate_id" AS run_candidate_id,
   run."policy_version" AS policy_version, run."policy_sha256" AS policy_sha256,
   c."source_document_id" AS candidate_source_document_id,
   c."extraction_artifact_id" AS candidate_artifact_id,
   c."extraction_artifact_sha256" AS candidate_artifact_sha256,
   c."source_sha256" AS candidate_source_sha256,
   c."manifest_content_sha256" AS candidate_manifest_sha256
 FROM "budget_review_decision_v1" rd
 JOIN "budget_verification_run_v1" run ON run."id" = rd."run_id"
 JOIN "budget_extraction_candidate_v1" c ON c."id" = rd."candidate_id"
 WHERE rd."id"=$1::uuid AND run."candidate_id" = rd."candidate_id"`;
}

/**
 * Exactly one table, one row (`id=$1`), one atomic UPDATE -- same shape as
 * the replay module's own governedReplaySqlV1. `FOR UPDATE` on the CTE
 * takes the row lock before the outer UPDATE, so a concurrent acceptance
 * attempt on the SAME row blocks, then re-evaluates `"state"='dead_letter'`
 * against the now-`succeeded` row and matches nothing.
 *
 * Unlike the replay module, `governedDisposition`/`verifierDecision` are
 * NOT removed from the top level -- `verifierDecision:'REVIEW'` must remain
 * a permanently visible, truthful fact. The new governed-acceptance facts
 * are added alongside it, and an append-only `governedAcceptanceHistory[]`
 * entry records the transition itself (previous state, actor, reason,
 * review-decision binding) the same way `replayHistory[]` does for replays.
 */
export function reviewAcceptanceSqlV1(): string {
  return `WITH eligible AS (
 SELECT o."id" FROM "defense_budget_ingestion_outbox" o
 WHERE o."id"=$1::uuid
   AND o."state"='dead_letter'
   AND o."leased_by" IS NULL
   AND o."metadata_jsonb"->>'governedDisposition'='${ELIGIBLE_GOVERNED_DISPOSITION}'
   AND o."metadata_jsonb"->>'verifierDecision'='${ELIGIBLE_VERIFIER_DECISION}'
   AND o."metadata_jsonb"->>'sourceDocumentId'=$5::text
 FOR UPDATE OF o
) UPDATE "defense_budget_ingestion_outbox" t
 SET "state"='succeeded',
     "leased_by"=NULL,
     "leased_until"=NULL,
     "last_error"=NULL,
     "available_at"=$2::timestamptz,
     "metadata_jsonb"=t."metadata_jsonb" || jsonb_build_object(
       'readinessPhase', 'pending',
       'readinessAttempts', 0,
       'ingestionResolution', 'governed_review_accepted',
       'reviewDecisionId', $6::text,
       'reviewDecisionHash', $7::text,
       'reviewAcceptedAt', $2::timestamptz,
       'reviewAcceptedBy', $3::text,
       'acceptancePolicyId', $8::text,
       'acceptancePolicyHash', $9::text,
       'governedAcceptanceHistory',
       COALESCE(t."metadata_jsonb"->'governedAcceptanceHistory', '[]'::jsonb) ||
       jsonb_build_array(jsonb_build_object(
         'acceptedAt', $2::timestamptz,
         'acceptedBy', $3::text,
         'reason', $4::text,
         'previousState', 'dead_letter',
         'previousGovernedDisposition', t."metadata_jsonb"->>'governedDisposition',
         'previousVerifierDecision', t."metadata_jsonb"->>'verifierDecision',
         'reviewDecisionId', $6::text,
         'reviewDecisionHash', $7::text,
         'acceptanceSequence', COALESCE(jsonb_array_length(t."metadata_jsonb"->'governedAcceptanceHistory'), 0) + 1
       ))
     ),
     "updated_at"=$2::timestamptz
 FROM eligible e WHERE t."id"=e."id"
 RETURNING t."id"`;
}

/** Deterministic, verifiable hash over the review decision's own bound identity fields. Computed here, never persisted onto BudgetReviewDecisionV1 itself. */
export function computeReviewDecisionHashV1(input: {
  reviewDecisionId: string;
  candidateId: string;
  runId: string;
  decision: string;
  sourceSha256: string;
  extractionArtifactSha256: string;
  manifestContentSha256: string;
  createdAt: string;
}): string {
  const canonical = JSON.stringify({
    reviewDecisionId: input.reviewDecisionId,
    candidateId: input.candidateId,
    runId: input.runId,
    decision: input.decision,
    sourceSha256: input.sourceSha256,
    extractionArtifactSha256: input.extractionArtifactSha256,
    manifestContentSha256: input.manifestContentSha256,
    createdAt: input.createdAt,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export const ACCEPTANCE_POLICY_ID_V1 = 'rdte_r1_review_acceptance_policy_v1';
/** Content hash of the eligibility policy's own allow-listed check/discrepancy shape -- bumped whenever the policy pack changes. */
export const ACCEPTANCE_POLICY_HASH_V1 = createHash('sha256')
  .update('rdte_r1_review_acceptance_policy_v1:ambiguous_trailing_numeric_count:v1')
  .digest('hex');

export function createReviewAcceptanceRepositoryV1(
  prisma: ReviewAcceptancePrismaLikeV1,
  verificationRepository: Pick<BudgetVerificationRepositoryV1, 'readChecks' | 'readDiscrepancies'>,
): ReviewAcceptanceRepositoryV1 {
  return {
    async previewAcceptanceTarget(rowId) {
      const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
        reviewAcceptancePreviewSqlV1(),
        rowId,
      );
      if (rows.length === 0) return null;
      const r = rows[0]!;
      return {
        id: String(r.id),
        state: String(r.state),
        governedDisposition: r.governed_disposition == null ? null : String(r.governed_disposition),
        verifierDecision: r.verifier_decision == null ? null : String(r.verifier_decision),
        sourceDocumentId: r.source_document_id == null ? null : String(r.source_document_id),
        leasedBy: r.leased_by == null ? null : String(r.leased_by),
      };
    },

    async previewAcceptanceEligibility(input): Promise<ReviewAcceptanceEligibilityCheckV1> {
      if (!input.rowId.trim()) {
        throw new ReviewAcceptanceValidationErrorV1('acceptance requires an explicit rowId');
      }
      if (!input.reviewDecisionId.trim()) {
        throw new ReviewAcceptanceValidationErrorV1(
          'acceptance requires an explicit reviewDecisionId',
        );
      }
      return resolveEligibleAcceptance(input.rowId, input.reviewDecisionId);
    },

    async acceptReviewedIngestionV1(input): Promise<ReviewAcceptanceOutcomeV1> {
      if (!input.rowId.trim()) {
        throw new ReviewAcceptanceValidationErrorV1('acceptance requires an explicit rowId');
      }
      if (!input.reviewDecisionId.trim()) {
        throw new ReviewAcceptanceValidationErrorV1(
          'acceptance requires an explicit reviewDecisionId',
        );
      }
      if (!input.actor.trim()) {
        throw new ReviewAcceptanceValidationErrorV1(
          'acceptance requires an explicit operator actor identity -- refusing to record an anonymous acceptance',
        );
      }
      if (!input.reason.trim()) {
        throw new ReviewAcceptanceValidationErrorV1(
          'acceptance requires an explicit operator reason -- refusing to record an unexplained acceptance',
        );
      }

      const resolved = await resolveEligibleAcceptance(input.rowId, input.reviewDecisionId);
      if (!resolved.ok) return resolved;

      const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
        reviewAcceptanceSqlV1(),
        input.rowId,
        input.now.toISOString(),
        input.actor,
        input.reason,
        resolved.outboxSourceDocumentId,
        input.reviewDecisionId,
        resolved.reviewDecisionHash,
        ACCEPTANCE_POLICY_ID_V1,
        ACCEPTANCE_POLICY_HASH_V1,
      );
      if (rows.length === 0) {
        return {
          ok: false,
          reason: 'concurrent_mutation_lost',
          detail: `row ${input.rowId} no longer matched the eligible predicate at mutation time (concurrent change, or already accepted)`,
        };
      }
      return { ok: true, id: String(rows[0]!.id), readinessPhase: 'pending' };
    },
  };

  /** Shared by both the mutating path and the read-only eligibility preview -- never issues the UPDATE itself. */
  async function resolveEligibleAcceptance(
    rowId: string,
    reviewDecisionId: string,
  ): Promise<ReviewAcceptanceEligibilityCheckV1> {
    const previewRows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      reviewAcceptancePreviewSqlV1(),
      rowId,
    );
    if (previewRows.length === 0) {
      return { ok: false, reason: 'row_not_found', detail: `no outbox row with id ${rowId}` };
    }
    const preview = previewRows[0]!;
    if (
      String(preview.governed_disposition ?? '') !== ELIGIBLE_GOVERNED_DISPOSITION ||
      String(preview.verifier_decision ?? '') !== ELIGIBLE_VERIFIER_DECISION ||
      String(preview.state ?? '') !== 'dead_letter'
    ) {
      return {
        ok: false,
        reason: 'row_not_eligible_disposition',
        detail:
          `row ${rowId} is state=${String(preview.state)} ` +
          `governedDisposition=${String(preview.governed_disposition)} ` +
          `verifierDecision=${String(preview.verifier_decision)} -- ` +
          `governed acceptance requires state=dead_letter, governedDisposition=${ELIGIBLE_GOVERNED_DISPOSITION}, verifierDecision=${ELIGIBLE_VERIFIER_DECISION}`,
      };
    }
    const outboxSourceDocumentId =
      preview.source_document_id == null ? null : String(preview.source_document_id);
    if (outboxSourceDocumentId == null) {
      return {
        ok: false,
        reason: 'source_document_mismatch',
        detail: `outbox row ${rowId} has no sourceDocumentId recorded in metadata`,
      };
    }

    const bindingRows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      reviewDecisionBindingSqlV1(),
      reviewDecisionId,
    );
    if (bindingRows.length === 0) {
      return {
        ok: false,
        reason: 'review_decision_not_found',
        detail: `no review decision with id ${reviewDecisionId} (or its run does not belong to its candidate)`,
      };
    }
    const b = bindingRows[0]!;
    if (String(b.review_decision) !== 'accept') {
      return {
        ok: false,
        reason: 'review_decision_not_accept',
        detail: `review decision ${reviewDecisionId} is "${String(b.review_decision)}", not "accept"`,
      };
    }
    if (String(b.run_decision) !== 'REVIEW') {
      return {
        ok: false,
        reason: 'review_run_not_review_decision',
        detail: `review decision ${reviewDecisionId}'s verification run decision is "${String(b.run_decision)}", not "REVIEW" -- this command only governs REVIEW rows`,
      };
    }
    if (
      String(b.rd_artifact_sha256) !== String(b.candidate_artifact_sha256) ||
      String(b.rd_source_sha256) !== String(b.candidate_source_sha256) ||
      String(b.rd_manifest_sha256) !== String(b.candidate_manifest_sha256)
    ) {
      return {
        ok: false,
        reason: 'review_binding_mismatch',
        detail: `review decision ${reviewDecisionId}'s bound hashes do not match its own candidate's current hashes -- refusing (this should be structurally impossible; investigate before retrying)`,
      };
    }
    if (String(b.candidate_source_document_id) !== outboxSourceDocumentId) {
      return {
        ok: false,
        reason: 'source_document_mismatch',
        detail:
          `review decision ${reviewDecisionId}'s candidate sourceDocumentId ` +
          `(${String(b.candidate_source_document_id)}) does not match outbox row ${rowId}'s ` +
          `own recorded sourceDocumentId (${outboxSourceDocumentId})`,
      };
    }

    const runId = String(b.run_id);
    const [checks, discrepancies]: [ReadCheckV1[], ReadDiscrepancyV1[]] = await Promise.all([
      verificationRepository.readChecks(runId),
      verificationRepository.readDiscrepancies(runId),
    ]);
    const eligibility = evaluateR1ReviewAcceptanceEligibilityV1({
      runDecision: String(b.run_decision),
      checks,
      discrepancies,
    });
    if (!eligibility.eligible) {
      return {
        ok: false,
        reason: 'acceptance_ineligible',
        detail: eligibility.refusalReasons.join('; '),
        eligibility,
      };
    }

    const reviewDecisionHash = computeReviewDecisionHashV1({
      reviewDecisionId: String(b.review_decision_id),
      candidateId: String(b.candidate_id),
      runId: String(b.run_id),
      decision: String(b.review_decision),
      sourceSha256: String(b.rd_source_sha256),
      extractionArtifactSha256: String(b.rd_artifact_sha256),
      manifestContentSha256: String(b.rd_manifest_sha256),
      createdAt: new Date(b.review_decision_created_at as string).toISOString(),
    });

    return { ok: true, outboxSourceDocumentId, runId, reviewDecisionHash, eligibility };
  }
}
