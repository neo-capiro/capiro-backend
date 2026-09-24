/**
 * candidate-correction-repository-v1 -- Phase 10B-35c.
 *
 * Persistence contract for `budget_candidate_correction_v1` plus the Prisma
 * implementation. The table is append-only and insert-only (enforced by DB
 * triggers -- see the migration); this module never issues an UPDATE and
 * never DELETEs.
 *
 * `commitCorrection` uses a global transaction-scoped graph lock, candidate
 * row fences, and review-row locks in a fixed order. It re-evaluates live
 * graph and eligibility state before supersession, so duplicate, stale, and
 * reverse/cycle attempts receive typed outcomes and perform zero writes.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { Prisma as PrismaRuntime } from '@prisma/client';
import { sha256CanonicalJson, type JsonValue } from '../../contracts/canonical-json.js';

export interface CandidateCorrectionReviewedScopeV1 {
  scopeKind: string;
  scopeKey: string;
  scope: unknown;
  expectedTotalMillions: string;
  expectedPhysicalPage: number;
  expectedAssertionIds: string[];
  expectedEvidenceIds: string[];
}

export interface CandidateCorrectionReviewedIntentV1 {
  version: 1;
  oldCandidate: {
    id: string;
    currentRunId: string | null;
    sourceDocumentId: string;
    sourceSha256: string;
    extractionArtifactId: string;
    extractionArtifactSha256: string;
    manifestContentSha256: string;
  };
  newCandidate: {
    id: string;
    currentRunId: string | null;
    sourceDocumentId: string;
    sourceSha256: string;
    extractionArtifactId: string;
    extractionArtifactSha256: string;
    manifestContentSha256: string;
  };
  selectedScopes: CandidateCorrectionReviewedScopeV1[];
}

export interface CandidateCorrectionRowV1 {
  id: string;
  oldCandidateId: string;
  newCandidateId: string;
  oldCandidateStatusAtCorrection: string;
  oldCandidateSourceDocumentId: string;
  oldCandidateSourceSha256: string;
  newCandidateSourceDocumentId: string;
  newCandidateSourceSha256: string;
  reviewedIntentVersion: number | null;
  reviewedIntent: CandidateCorrectionReviewedIntentV1 | null;
  reviewedIntentSha256: string | null;
  supersededScopedFactReviewIds: string[];
  actor: string;
  reason: string;
  createdAt: string;
}

export interface InsertCandidateCorrectionInputV1 {
  oldCandidateId: string;
  newCandidateId: string;
  oldCandidateStatusAtCorrection: string;
  oldCandidateSourceDocumentId: string;
  oldCandidateSourceSha256: string;
  newCandidateSourceDocumentId: string;
  newCandidateSourceSha256: string;
  oldCandidateCurrentRunId: string | null;
  oldCandidateExtractionArtifactId: string;
  oldCandidateExtractionArtifactSha256: string;
  oldCandidateManifestContentSha256: string;
  newCandidateCurrentRunId: string | null;
  newCandidateExtractionArtifactId: string;
  newCandidateExtractionArtifactSha256: string;
  newCandidateManifestContentSha256: string;
  selectedScopes?: CandidateCorrectionReviewedScopeV1[];
  supersededScopedFactReviewIds: string[];
  actor: string;
  reason: string;
}

/** Postgres unique_violation SQLSTATE, surfaced by Prisma as error code P2002. */
export const PRISMA_UNIQUE_VIOLATION_CODE = 'P2002';

/**
 * Legacy diagnostic matcher retained for callers/tests that classify the
 * scoped-review immutability trigger. The transactional correction path no
 * longer depends on parsing this exception: it locks active rows in id order
 * after the graph/candidate fences. Matching remains deliberately exact so
 * the trigger's separate "decision columns are immutable" programmer error
 * can never be relabeled as a harmless concurrency conflict.
 */
export const POSTGRES_RAISE_EXCEPTION_SQLSTATE = 'P0001';

/**
 * True when `error` is the `PrismaClientUnknownRequestError` Postgres raises
 * (via `guard_budget_scoped_fact_review_v1_update()`'s trigger) for an
 * UPDATE against a `budget_scoped_fact_review_v1` row whose status is no
 * longer `'active'` -- see this file's `POSTGRES_RAISE_EXCEPTION_SQLSTATE`
 * doc comment for why detection works this way and why it is deliberately
 * narrower than "any P0001".
 */
export function isScopedFactReviewImmutabilityGuardConflict(error: unknown): boolean {
  if (!(error instanceof Error) || typeof error.message !== 'string') return false;
  return (
    error.message.includes(`code: "${POSTGRES_RAISE_EXCEPTION_SQLSTATE}"`) &&
    error.message.includes('budget_scoped_fact_review_v1: row') &&
    error.message.includes(' is already ') &&
    error.message.includes(' and is immutable')
  );
}

export type InsertCandidateCorrectionResultV1 =
  | { outcome: 'inserted'; row: CandidateCorrectionRowV1 }
  /** A correction uniqueness rail rejected the standalone insert. */
  | { outcome: 'conflict' };

export interface CommitCandidateCorrectionInputV1 {
  oldCandidateId: string;
  newCandidateId: string;
  oldCandidateStatusAtCorrection: string;
  oldCandidateCurrentRunId: string | null;
  oldCandidateSourceDocumentId: string;
  oldCandidateSourceSha256: string;
  oldCandidateExtractionArtifactId: string;
  oldCandidateExtractionArtifactSha256: string;
  oldCandidateManifestContentSha256: string;
  newCandidateCurrentRunId: string | null;
  newCandidateSourceDocumentId: string;
  newCandidateSourceSha256: string;
  newCandidateExtractionArtifactId: string;
  newCandidateExtractionArtifactSha256: string;
  newCandidateManifestContentSha256: string;
  selectedScopes?: CandidateCorrectionReviewedScopeV1[];
  actor: string;
  reason: string;
  /** Revocation-reason text for any of the OLD candidate's active
   * scoped-fact-review rows this commit supersedes. */
  supersessionReason: string;
  now: string;
}

export type CommitCandidateCorrectionResultV1 =
  | { outcome: 'inserted'; row: CandidateCorrectionRowV1; supersededScopedFactReviewIds: string[] }
  /** An existing committed link owns the old or new uniqueness rail. */
  | {
      outcome: 'conflict';
      conflictOn: 'old_candidate' | 'new_candidate';
      existingLink: CandidateCorrectionRowV1;
    }
  /** Proposed NEW is already on the corrected-away side of a committed link. */
  | { outcome: 'reverse_or_cycle_conflict'; existingLink: CandidateCorrectionRowV1 | null }
  /** Candidate status/source identity changed after the service preview. */
  | { outcome: 'stale_eligibility'; detail: string };

export interface CandidateCorrectionRepositoryV1 {
  /** Attempts to insert the link row. Never pre-checks; always attempts, and
   * reports whether the unique index accepted it. Does NOT supersede the old
   * candidate's active scoped-fact-review rows -- use `commitCorrection` for
   * the full, atomic operation `CandidateCorrectionV1Service` actually needs. */
  insertLink(input: InsertCandidateCorrectionInputV1): Promise<InsertCandidateCorrectionResultV1>;
  /** Atomically supersedes the old candidate's currently-active scoped-fact-review
   * rows AND inserts the correction link in ONE transaction. If the insert loses
   * the unique-index race (same or different new candidate), the ENTIRE
   * transaction rolls back -- the supersession never happens either. This is
   * the method `CandidateCorrectionV1Service.correct()` uses; it exists
   * specifically so a refused/conflicting attempt can never leave a
   * half-completed side effect (a real scoped-review decision silently
   * superseded with no corresponding link explaining why). */
  commitCorrection(input: CommitCandidateCorrectionInputV1): Promise<CommitCandidateCorrectionResultV1>;
  readByOldCandidateId(oldCandidateId: string): Promise<CandidateCorrectionRowV1 | null>;
  readByNewCandidateId(newCandidateId: string): Promise<CandidateCorrectionRowV1 | null>;
  readById(id: string): Promise<CandidateCorrectionRowV1 | null>;
}

type PrismaRow = {
  id: string;
  oldCandidateId: string;
  newCandidateId: string;
  oldCandidateStatusAtCorrection: string;
  oldCandidateSourceDocumentId: string;
  oldCandidateSourceSha256: string;
  newCandidateSourceDocumentId: string;
  newCandidateSourceSha256: string;
  reviewedIntentVersion: number | null;
  reviewedIntent: unknown;
  reviewedIntentSha256: string | null;
  supersededScopedFactReviewIds: unknown;
  actor: string;
  reason: string;
  createdAt: Date;
};

function toRow(r: PrismaRow): CandidateCorrectionRowV1 {
  return {
    id: r.id,
    oldCandidateId: r.oldCandidateId,
    newCandidateId: r.newCandidateId,
    oldCandidateStatusAtCorrection: r.oldCandidateStatusAtCorrection,
    oldCandidateSourceDocumentId: r.oldCandidateSourceDocumentId,
    oldCandidateSourceSha256: r.oldCandidateSourceSha256,
    newCandidateSourceDocumentId: r.newCandidateSourceDocumentId,
    newCandidateSourceSha256: r.newCandidateSourceSha256,
    reviewedIntentVersion: r.reviewedIntentVersion,
    reviewedIntent: (r.reviewedIntent as CandidateCorrectionReviewedIntentV1 | null) ?? null,
    reviewedIntentSha256: r.reviewedIntentSha256,
    supersededScopedFactReviewIds: (r.supersededScopedFactReviewIds as string[]) ?? [],
    actor: r.actor,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
  };
}

/** The minimal Prisma surface this repository touches (for fakes in tests).
 * Includes `budgetScopedFactReviewV1` and `$transaction` -- not just
 * `budgetCandidateCorrectionV1` -- because `commitCorrection` must run both
 * the supersession and the link insert in one real transaction. */
export type CandidateCorrectionPrismaLikeV1 = Pick<
  PrismaClient,
  'budgetCandidateCorrectionV1' | 'budgetScopedFactReviewV1' | '$transaction' | '$queryRaw'
>;

export class PrismaCandidateCorrectionRepositoryV1 implements CandidateCorrectionRepositoryV1 {
  constructor(private readonly prisma: CandidateCorrectionPrismaLikeV1) {}

  async commitCorrection(input: CommitCandidateCorrectionInputV1): Promise<CommitCandidateCorrectionResultV1> {
    return commitCandidateCorrectionAtomicallyV1(this.prisma, input);
  }

  async insertLink(input: InsertCandidateCorrectionInputV1): Promise<InsertCandidateCorrectionResultV1> {
    const reviewedIntent = buildCandidateCorrectionReviewedIntentV1(input);
    const data: Prisma.BudgetCandidateCorrectionV1UncheckedCreateInput = {
      oldCandidateId: input.oldCandidateId,
      newCandidateId: input.newCandidateId,
      oldCandidateStatusAtCorrection: input.oldCandidateStatusAtCorrection,
      oldCandidateSourceDocumentId: input.oldCandidateSourceDocumentId,
      oldCandidateSourceSha256: input.oldCandidateSourceSha256,
      newCandidateSourceDocumentId: input.newCandidateSourceDocumentId,
      newCandidateSourceSha256: input.newCandidateSourceSha256,
      reviewedIntentVersion: reviewedIntent.version,
      reviewedIntent: reviewedIntent as unknown as Prisma.InputJsonValue,
      supersededScopedFactReviewIds: input.supersededScopedFactReviewIds as unknown as Prisma.InputJsonValue,
      actor: input.actor,
      reason: input.reason,
    };
    try {
      const inserted = await this.prisma.budgetCandidateCorrectionV1.create({ data });
      return { outcome: 'inserted', row: toRow(inserted as unknown as PrismaRow) };
    } catch (error) {
      if (isPrismaUniqueViolation(error)) {
        return { outcome: 'conflict' };
      }
      throw error;
    }
  }

  async readByOldCandidateId(oldCandidateId: string): Promise<CandidateCorrectionRowV1 | null> {
    const row = await this.prisma.budgetCandidateCorrectionV1.findUnique({ where: { oldCandidateId } });
    return row ? toRow(row as unknown as PrismaRow) : null;
  }

  async readByNewCandidateId(newCandidateId: string): Promise<CandidateCorrectionRowV1 | null> {
    const row = await this.prisma.budgetCandidateCorrectionV1.findUnique({ where: { newCandidateId } });
    return row ? toRow(row as unknown as PrismaRow) : null;
  }

  async readById(id: string): Promise<CandidateCorrectionRowV1 | null> {
    const row = await this.prisma.budgetCandidateCorrectionV1.findUnique({ where: { id } });
    return row ? toRow(row as unknown as PrismaRow) : null;
  }
}

/**
 * Atomically supersede the old candidate's active scoped-fact-review rows
 * AND insert the correction link, in ONE Postgres transaction.
 *
 * WHY this must be one transaction, not two sequential calls (a real defect
 * found and fixed here, 2026-09-09): if supersession ran first as its own
 * committed statement and the link insert then failed (e.g. `newCandidateId`
 * was already claimed by correcting a DIFFERENT old candidate), the
 * supersession had ALREADY happened -- a real active human decision was
 * silently and irreversibly flipped to `superseded`, with no corresponding
 * link row to explain why, and the caller only sees a `conflict`/thrown
 * error with no indication anything was written. Wrapping both in one
 * transaction makes "a refused attempt performs zero writes" a guarantee the
 * database enforces, not an ordering assumption in application code: if the
 * insert loses the unique-index race (on EITHER `old_candidate_id` or
 * `new_candidate_id`), throwing inside the callback rolls back the
 * supersession too, and the old candidate's decisions are left exactly as
 * they were before this call.
 *
 * Canonical order is GRAPH advisory, both candidates UUID-sorted FOR NO KEY
 * UPDATE, live eligibility/graph reads, active old reviews id-sorted FOR
 * UPDATE, supersession, then link insert. READ COMMITTED rechecks a row's
 * active predicate after waiting on a human revocation, so that row is
 * excluded rather than misreported as a duplicate correction winner.
 */
export async function commitCandidateCorrectionAtomicallyV1(
  prisma: CandidateCorrectionPrismaLikeV1,
  input: CommitCandidateCorrectionInputV1,
): Promise<CommitCandidateCorrectionResultV1> {
  try {
    return await prisma.$transaction(
      async (tx) => {
      // Canonical correction order: GRAPH advisory -> both candidate rows in
      // UUID order -> live graph/eligibility -> active OLD review rows in id
      // order -> supersede -> link insert. This removes the old unlocked
      // SELECT/UPDATE window and makes duplicate/cycle outcomes named rather
      // than dependent on parsing an unrelated database exception.
      await tx.$queryRaw(
        PrismaRuntime.sql`
          SELECT 1 AS "locked"
            FROM (SELECT pg_advisory_xact_lock(hashtextextended('budget_candidate_correction_v1:graph', 0))) AS acquired
        `,
      );

      const candidates = await tx.$queryRaw<
        Array<{
          id: string;
          status: string;
          currentRunId: string | null;
          sourceDocumentId: string;
          sourceSha256: string;
          extractionArtifactId: string;
          extractionArtifactSha256: string;
          manifestContentSha256: string;
        }>
      >(PrismaRuntime.sql`
        SELECT "id",
               "status",
               "current_run_id" AS "currentRunId",
               "source_document_id" AS "sourceDocumentId",
               "source_sha256" AS "sourceSha256",
               "extraction_artifact_id" AS "extractionArtifactId",
               "extraction_artifact_sha256" AS "extractionArtifactSha256",
               "manifest_content_sha256" AS "manifestContentSha256"
          FROM "budget_extraction_candidate_v1"
         WHERE "id" IN (${input.oldCandidateId}::uuid, ${input.newCandidateId}::uuid)
         ORDER BY "id"
         FOR NO KEY UPDATE
      `);
      const oldCandidate = candidates.find((row) => row.id === input.oldCandidateId);
      const newCandidate = candidates.find((row) => row.id === input.newCandidateId);
      if (oldCandidate == null || newCandidate == null) {
        return { outcome: 'stale_eligibility' as const, detail: 'old or new candidate disappeared before commit' };
      }

      const existingForOld = await tx.budgetCandidateCorrectionV1.findUnique({ where: { oldCandidateId: input.oldCandidateId } });
      if (existingForOld != null) {
        return {
          outcome: 'conflict' as const,
          conflictOn: 'old_candidate' as const,
          existingLink: toRow(existingForOld as unknown as PrismaRow),
        };
      }
      const existingForNew = await tx.budgetCandidateCorrectionV1.findUnique({ where: { newCandidateId: input.newCandidateId } });
      if (existingForNew != null) {
        return {
          outcome: 'conflict' as const,
          conflictOn: 'new_candidate' as const,
          existingLink: toRow(existingForNew as unknown as PrismaRow),
        };
      }
      const proposedNewAlreadyCorrectedAway = await tx.budgetCandidateCorrectionV1.findUnique({
        where: { oldCandidateId: input.newCandidateId },
      });
      if (proposedNewAlreadyCorrectedAway != null) {
        return {
          outcome: 'reverse_or_cycle_conflict' as const,
          existingLink: toRow(proposedNewAlreadyCorrectedAway as unknown as PrismaRow),
        };
      }

      if (
        (oldCandidate.status !== 'NEEDS_REVIEW' && oldCandidate.status !== 'REJECTED') ||
        oldCandidate.status !== input.oldCandidateStatusAtCorrection ||
        newCandidate.status === 'REJECTED' ||
        oldCandidate.currentRunId !== input.oldCandidateCurrentRunId ||
        oldCandidate.sourceDocumentId !== input.oldCandidateSourceDocumentId ||
        oldCandidate.sourceSha256 !== input.oldCandidateSourceSha256 ||
        oldCandidate.extractionArtifactId !== input.oldCandidateExtractionArtifactId ||
        oldCandidate.extractionArtifactSha256 !== input.oldCandidateExtractionArtifactSha256 ||
        oldCandidate.manifestContentSha256 !== input.oldCandidateManifestContentSha256 ||
        newCandidate.currentRunId !== input.newCandidateCurrentRunId ||
        newCandidate.sourceDocumentId !== input.newCandidateSourceDocumentId ||
        newCandidate.sourceSha256 !== input.newCandidateSourceSha256 ||
        newCandidate.extractionArtifactId !== input.newCandidateExtractionArtifactId ||
        newCandidate.extractionArtifactSha256 !== input.newCandidateExtractionArtifactSha256 ||
        newCandidate.manifestContentSha256 !== input.newCandidateManifestContentSha256 ||
        oldCandidate.sourceDocumentId !== newCandidate.sourceDocumentId ||
        oldCandidate.sourceSha256 !== newCandidate.sourceSha256
      ) {
        return {
          outcome: 'stale_eligibility' as const,
          detail:
            `candidate status/run/source/artifact/manifest binding changed before commit (old=${oldCandidate.status}, new=${newCandidate.status}, ` +
            `oldSnapshot=${input.oldCandidateStatusAtCorrection})`,
        };
      }

      // `FOR UPDATE` with the status predicate rechecks at READ COMMITTED
      // after a waiting revoke commits. Rows revoked first simply drop out;
      // rows locked here cannot acquire a new status before supersession.
      const activeRows = await tx.$queryRaw<Array<{ id: string }>>(PrismaRuntime.sql`
        SELECT "id"
          FROM "budget_scoped_fact_review_v1"
         WHERE "candidate_id" = ${input.oldCandidateId}::uuid
           AND "status" = 'active'
         ORDER BY "id"
         FOR UPDATE
      `);
      const supersededScopedFactReviewIds = activeRows.map((row) => row.id);
      for (const row of activeRows) {
        await tx.budgetScopedFactReviewV1.update({
          where: { id: row.id },
          data: {
            status: 'superseded',
            revokedAt: new Date(input.now),
            revokedBy: input.actor,
            revocationReason: input.supersessionReason,
          },
        });
      }

      const data: Prisma.BudgetCandidateCorrectionV1UncheckedCreateInput = {
        reviewedIntentVersion: 1,
        reviewedIntent: buildCandidateCorrectionReviewedIntentV1(input) as unknown as PrismaRuntime.InputJsonValue,
        oldCandidateId: input.oldCandidateId,
        newCandidateId: input.newCandidateId,
        oldCandidateStatusAtCorrection: input.oldCandidateStatusAtCorrection,
        oldCandidateSourceDocumentId: input.oldCandidateSourceDocumentId,
        oldCandidateSourceSha256: input.oldCandidateSourceSha256,
        newCandidateSourceDocumentId: input.newCandidateSourceDocumentId,
        newCandidateSourceSha256: input.newCandidateSourceSha256,
        supersededScopedFactReviewIds: supersededScopedFactReviewIds as unknown as Prisma.InputJsonValue,
        actor: input.actor,
        reason: input.reason,
      };
      const inserted = await tx.budgetCandidateCorrectionV1.create({ data });
      return {
        outcome: 'inserted' as const,
        row: toRow(inserted as unknown as PrismaRow),
        supersededScopedFactReviewIds,
      };
      },
      { isolationLevel: PrismaRuntime.TransactionIsolationLevel.ReadCommitted },
    );
  } catch (error) {
    // A fully migrated writer is serialized by the graph lock and normally
    // finds the winner above. Retain a narrow final-insert P2002 recovery for
    // mixed-version/direct writers: the failed transaction (including any
    // supersession) has rolled back before these authoritative reads.
    if (!isPrismaUniqueViolation(error)) throw error;
    const existingForOld = await prisma.budgetCandidateCorrectionV1.findUnique({
      where: { oldCandidateId: input.oldCandidateId },
    });
    if (existingForOld != null) {
      return {
        outcome: 'conflict',
        conflictOn: 'old_candidate',
        existingLink: toRow(existingForOld as unknown as PrismaRow),
      };
    }
    const existingForNew = await prisma.budgetCandidateCorrectionV1.findUnique({
      where: { newCandidateId: input.newCandidateId },
    });
    if (existingForNew != null) {
      return {
        outcome: 'conflict',
        conflictOn: 'new_candidate',
        existingLink: toRow(existingForNew as unknown as PrismaRow),
      };
    }
    // The target/constraint looked like our rail but no durable winner owns
    // either identity. Do not relabel an unexplained database failure.
    throw error;
  }
}

/** Canonical, audit-readable operation intent persisted on every new link. */
export function buildCandidateCorrectionReviewedIntentV1(
  input: Pick<
    CommitCandidateCorrectionInputV1,
    | 'oldCandidateId'
    | 'newCandidateId'
    | 'oldCandidateCurrentRunId'
    | 'oldCandidateSourceDocumentId'
    | 'oldCandidateSourceSha256'
    | 'oldCandidateExtractionArtifactId'
    | 'oldCandidateExtractionArtifactSha256'
    | 'oldCandidateManifestContentSha256'
    | 'newCandidateCurrentRunId'
    | 'newCandidateSourceDocumentId'
    | 'newCandidateSourceSha256'
    | 'newCandidateExtractionArtifactId'
    | 'newCandidateExtractionArtifactSha256'
    | 'newCandidateManifestContentSha256'
    | 'selectedScopes'
  >,
): CandidateCorrectionReviewedIntentV1 {
  return {
    version: 1,
    oldCandidate: {
      id: input.oldCandidateId,
      currentRunId: input.oldCandidateCurrentRunId,
      sourceDocumentId: input.oldCandidateSourceDocumentId,
      sourceSha256: input.oldCandidateSourceSha256,
      extractionArtifactId: input.oldCandidateExtractionArtifactId,
      extractionArtifactSha256: input.oldCandidateExtractionArtifactSha256,
      manifestContentSha256: input.oldCandidateManifestContentSha256,
    },
    newCandidate: {
      id: input.newCandidateId,
      currentRunId: input.newCandidateCurrentRunId,
      sourceDocumentId: input.newCandidateSourceDocumentId,
      sourceSha256: input.newCandidateSourceSha256,
      extractionArtifactId: input.newCandidateExtractionArtifactId,
      extractionArtifactSha256: input.newCandidateExtractionArtifactSha256,
      manifestContentSha256: input.newCandidateManifestContentSha256,
    },
    selectedScopes: [...(input.selectedScopes ?? [])]
      .map((entry) => ({
        scopeKind: entry.scopeKind,
        scopeKey: entry.scopeKey,
        scope: entry.scope,
        expectedTotalMillions: entry.expectedTotalMillions,
        expectedPhysicalPage: entry.expectedPhysicalPage,
        expectedAssertionIds: [...entry.expectedAssertionIds].sort(),
        expectedEvidenceIds: [...entry.expectedEvidenceIds].sort(),
      }))
      .sort((a, b) => `${a.scopeKind}\u0000${a.scopeKey}`.localeCompare(`${b.scopeKind}\u0000${b.scopeKey}`)),
  };
}

/** Canonical application-side comparison digest. This is deliberately NOT
 * the persisted `reviewedIntentSha256`: Postgres owns that audit digest and
 * computes it from the stored JSONB representation in the INSERT trigger. */
export function computeCandidateCorrectionReviewedIntentCanonicalSha256V1(
  intent: CandidateCorrectionReviewedIntentV1,
): string {
  return sha256CanonicalJson(intent as unknown as JsonValue);
}

function isPrismaUniqueViolation(error: unknown): boolean {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('code' in error) ||
    (error as { code?: unknown }).code !== PRISMA_UNIQUE_VIOLATION_CODE
  ) {
    return false;
  }
  const target = (error as { meta?: { target?: unknown } }).meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : typeof target === 'string' ? [target] : [];
  return fields.some((field) =>
    ['oldCandidateId', 'newCandidateId', 'old_candidate_id', 'new_candidate_id'].some((expected) => field.includes(expected)),
  );
}
