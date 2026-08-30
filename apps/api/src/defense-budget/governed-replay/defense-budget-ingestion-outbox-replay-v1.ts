/**
 * Phase 10B-10 Part I -- governed, audited replay for a terminal
 * `dead_letter` governed-ingestion-outbox row.
 *
 * `defense_budget_ingestion_outbox` has NO existing transition back out of
 * `dead_letter` (only `markGoverned`/`markDeadLetterPoison` transition INTO
 * it -- see `ingestion-outbox-drain-repository-prisma-v1.ts`), and its
 * `@@unique([observationId, jobKind])` constraint means a second ordinary
 * outbox row for the same observation cannot be created while the
 * dead-letter row still occupies that identity. Resetting the SAME row is
 * therefore the only viable recovery path -- this module makes that reset
 * explicit, narrowly scoped, and permanently auditable, rather than a raw
 * ad hoc SQL state flip.
 *
 * Scope, deliberately narrow (fail-closed on everything else):
 *   - exactly one row, by id -- never a batch, never "all dead letters",
 *     never a family/FY sweep;
 *   - only when the row's CURRENT disposition is a previously terminal
 *     VERIFIER decision (`governedDisposition: 'verification_rejected'`,
 *     `verifierDecision: 'REJECT'`) being retried because code, policy, or
 *     extractor behavior changed -- never `retries_exhausted` (an
 *     infra-poison disposition, not a verifier outcome) and never
 *     `review_required` (its own governed human-review workflow, not a
 *     code-fix replay);
 *   - never while leased (`leased_by IS NOT NULL`);
 *   - never without both an explicit operator reason and actor identity.
 *
 * The replay NEVER touches `budget_verification_run_v1` /
 * `budget_verification_check_v1` / `budget_verification_discrepancy_v1` /
 * `source_document`, or any other table -- the SQL below names exactly one
 * table. The prior REJECT stays exactly as it was: a later successful drain
 * naturally produces a brand-new `BudgetExtractionCandidateV1` (its identity
 * key includes `extractionArtifactSha256`, which changes once real
 * assertions exist) and a brand-new `BudgetVerificationRunV1`; nothing here
 * deletes, updates, or supersedes the old one, and every FK in that table
 * chain is `onDelete: Restrict`.
 *
 * `attempts` is preserved, never reset to 0 here: it represents historical
 * drain executions, and a replay is a request to attempt again, not a
 * fresh start. The drain worker's own existing `markRetryableFailure` /
 * `markDeadLetterPoison` continue to increment it exactly as before on any
 * subsequent attempt from this row.
 */

export class GovernedReplayValidationErrorV1 extends Error {}

export interface GovernedReplayRequestV1 {
  rowId: string;
  now: Date;
  /** Explicit operator identity. Required -- fails closed if blank. */
  actor: string;
  /** Explicit operator reason. Required -- fails closed if blank. */
  reason: string;
}

export interface GovernedReplayPreviewV1 {
  id: string;
  state: string;
  governedDisposition: string | null;
  verifierDecision: string | null;
  lastError: string | null;
  attempts: number;
  leasedBy: string | null;
}

export interface GovernedReplayResultV1 {
  id: string;
  attempts: number;
  /** Always null immediately after a replay -- the prior message moved to replayHistory[].previousLastError. */
  lastError: string | null;
  /** No longer carries top-level `governedDisposition`/`verifierDecision` -- see `replayHistory` for those. */
  metadataJsonb: Record<string, unknown>;
}

export interface GovernedReplayRepositoryV1 {
  /** Read-only. Prints the exact target row's current disposition before any mutation. */
  previewReplayTarget(rowId: string): Promise<GovernedReplayPreviewV1 | null>;
  /**
   * Requires the row to currently be an eligible verifier-rejected
   * `dead_letter` row, unleased. Returns `null` (never throws) when the row
   * does not exist or is not currently eligible -- including when a
   * concurrent replay already won. Throws `GovernedReplayValidationErrorV1`
   * only for a caller-side contract violation (blank actor/reason), which
   * must be caught before ever reaching the database.
   */
  replayDeadLetterForVerifierFixV1(input: GovernedReplayRequestV1): Promise<GovernedReplayResultV1 | null>;
}

export interface GovernedReplayPrismaLikeV1 {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

/** The exact, only-eligible-disposition governed replay currently supports. */
const ELIGIBLE_GOVERNED_DISPOSITION = 'verification_rejected';
const ELIGIBLE_VERIFIER_DECISION = 'REJECT';

export function governedReplayPreviewSqlV1(): string {
  return `SELECT "id", "state",
   "metadata_jsonb"->>'governedDisposition' AS governed_disposition,
   "metadata_jsonb"->>'verifierDecision' AS verifier_decision,
   "last_error", "attempts", "leased_by"
 FROM "defense_budget_ingestion_outbox" WHERE "id"=$1::uuid`;
}

/**
 * Exactly one table, one row (`id=$1`), one atomic UPDATE. Eligibility is
 * enforced entirely inside the WHERE clause -- a row that fails any
 * predicate returns zero rows, never a partial mutation. `FOR UPDATE` on the
 * CTE takes the row lock before the outer UPDATE, so a second concurrent
 * replay attempt on the SAME row blocks until the first commits, then
 * re-evaluates `"state"='dead_letter'` against the now-`pending` row and
 * correctly matches nothing -- exactly one caller ever succeeds.
 *
 * The audit entry is built entirely from THIS row's own pre-transition
 * columns (`t."metadata_jsonb"->>'governedDisposition'`, `t."last_error"`,
 * etc.), read and written in the same statement -- no separate read step
 * that could race against a concurrent transition. Those same pre-
 * transition values are then removed from the top level of metadata_jsonb
 * (via the `-` key-delete operator, applied to the `jsonb_set(...)` result,
 * so the delete only ever sees values already captured in this same
 * expression): the CURRENT row must never still look rejected once it is
 * back in `pending`, but the history the row's own metadata used to carry is
 * now permanently the replayHistory entry's `previous*` fields instead --
 * nothing is lost, only relocated from "current" to "historical". last_error
 * is cleared the same way, for the same reason: a freshly re-queued row must
 * read as freshly re-queued, not as still-carrying-the-old-rejection-message.
 */
export function governedReplaySqlV1(): string {
  return `WITH eligible AS (
 SELECT o."id" FROM "defense_budget_ingestion_outbox" o
 WHERE o."id"=$1::uuid
   AND o."state"='dead_letter'
   AND o."leased_by" IS NULL
   AND o."metadata_jsonb"->>'governedDisposition'='${ELIGIBLE_GOVERNED_DISPOSITION}'
   AND o."metadata_jsonb"->>'verifierDecision'='${ELIGIBLE_VERIFIER_DECISION}'
 FOR UPDATE OF o
) UPDATE "defense_budget_ingestion_outbox" t
 SET "state"='pending',
     "leased_by"=NULL,
     "leased_until"=NULL,
     "available_at"=$2::timestamptz,
     "last_error"=NULL,
     "metadata_jsonb"=jsonb_set(
       t."metadata_jsonb",
       '{replayHistory}',
       COALESCE(t."metadata_jsonb"->'replayHistory', '[]'::jsonb) ||
       jsonb_build_array(jsonb_build_object(
         'replayRequestedAt', $2::timestamptz,
         'replayRequestedBy', $3::text,
         'replayReason', $4::text,
         'previousState', 'dead_letter',
         'previousGovernedDisposition', t."metadata_jsonb"->>'governedDisposition',
         'previousVerifierDecision', t."metadata_jsonb"->>'verifierDecision',
         'previousLastError', t."last_error",
         'replaySequence', COALESCE(jsonb_array_length(t."metadata_jsonb"->'replayHistory'), 0) + 1
       ))
     ) - 'governedDisposition' - 'verifierDecision',
     "updated_at"=$2::timestamptz
 FROM eligible e WHERE t."id"=e."id"
 RETURNING t."id", t."attempts", t."metadata_jsonb", t."last_error"`;
}

export function createGovernedReplayRepositoryV1(
  prisma: GovernedReplayPrismaLikeV1,
): GovernedReplayRepositoryV1 {
  return {
    async previewReplayTarget(rowId) {
      const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
        governedReplayPreviewSqlV1(),
        rowId,
      );
      if (rows.length === 0) return null;
      const r = rows[0]!;
      return {
        id: String(r.id),
        state: String(r.state),
        governedDisposition: r.governed_disposition == null ? null : String(r.governed_disposition),
        verifierDecision: r.verifier_decision == null ? null : String(r.verifier_decision),
        lastError: r.last_error == null ? null : String(r.last_error),
        attempts: Number(r.attempts ?? 0),
        leasedBy: r.leased_by == null ? null : String(r.leased_by),
      };
    },
    async replayDeadLetterForVerifierFixV1(input) {
      if (!input.rowId.trim()) {
        throw new GovernedReplayValidationErrorV1('replay requires an explicit rowId');
      }
      if (!input.actor.trim()) {
        throw new GovernedReplayValidationErrorV1(
          'replay requires an explicit operator actor identity -- refusing to record an anonymous replay',
        );
      }
      if (!input.reason.trim()) {
        throw new GovernedReplayValidationErrorV1(
          'replay requires an explicit operator reason -- refusing to record an unexplained replay',
        );
      }
      const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
        governedReplaySqlV1(),
        input.rowId,
        input.now.toISOString(),
        input.actor,
        input.reason,
      );
      if (rows.length === 0) return null;
      const r = rows[0]!;
      return {
        id: String(r.id),
        attempts: Number(r.attempts ?? 0),
        lastError: r.last_error == null ? null : String(r.last_error),
        metadataJsonb: r.metadata_jsonb as Record<string, unknown>,
      };
    },
  };
}
