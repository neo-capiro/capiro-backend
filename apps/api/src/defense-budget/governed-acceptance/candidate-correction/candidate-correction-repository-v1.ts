/**
 * candidate-correction-repository-v1 -- Phase 10B-35c.
 *
 * Persistence contract for `budget_candidate_correction_v1` plus the Prisma
 * implementation. The table is append-only and insert-only (enforced by DB
 * triggers -- see the migration); this module never issues an UPDATE and
 * never DELETEs.
 *
 * Idempotency / concurrency invariant: `insertLink` relies on the DB's own
 * unique index on `old_candidate_id` to arbitrate concurrent attempts. It
 * NEVER pre-checks "does a link already exist" and then inserts -- that
 * check-then-act pattern is exactly the race this repository must not
 * reproduce. Instead it always attempts the insert and reports whether it
 * won, so the caller (`CandidateCorrectionV1Service`) can apply the
 * idempotent-replay-vs-refuse decision against the row that is actually
 * persisted, not against a stale read.
 */
import type { Prisma, PrismaClient } from '@prisma/client';
import { supersedeAllForCandidateWithClientV1 } from '../scoped-fact-review/scoped-fact-review-repository-v1.js';

export interface CandidateCorrectionRowV1 {
  id: string;
  oldCandidateId: string;
  newCandidateId: string;
  oldCandidateStatusAtCorrection: string;
  oldCandidateSourceDocumentId: string;
  oldCandidateSourceSha256: string;
  newCandidateSourceDocumentId: string;
  newCandidateSourceSha256: string;
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
  supersededScopedFactReviewIds: string[];
  actor: string;
  reason: string;
}

/** Postgres unique_violation SQLSTATE, surfaced by Prisma as error code P2002. */
export const PRISMA_UNIQUE_VIOLATION_CODE = 'P2002';

export type InsertCandidateCorrectionResultV1 =
  | { outcome: 'inserted'; row: CandidateCorrectionRowV1 }
  /** Lost the race (or this is a literal retry): some row already occupies
   * `old_candidate_id`. The caller must read it back to decide idempotent
   * replay vs. explicit refusal. */
  | { outcome: 'conflict' };

export interface CommitCandidateCorrectionInputV1 {
  oldCandidateId: string;
  newCandidateId: string;
  oldCandidateStatusAtCorrection: string;
  oldCandidateSourceDocumentId: string;
  oldCandidateSourceSha256: string;
  newCandidateSourceDocumentId: string;
  newCandidateSourceSha256: string;
  actor: string;
  reason: string;
  /** Revocation-reason text for any of the OLD candidate's active
   * scoped-fact-review rows this commit supersedes. */
  supersessionReason: string;
  now: string;
}

export type CommitCandidateCorrectionResultV1 =
  | { outcome: 'inserted'; row: CandidateCorrectionRowV1; supersededScopedFactReviewIds: string[] }
  /** Lost the race (or this is a literal retry). Nothing was written by THIS
   * call -- see `commitCandidateCorrectionAtomicallyV1`'s doc comment for why
   * that is a hard guarantee, not just the common case. */
  | { outcome: 'conflict' };

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
export type CandidateCorrectionPrismaLikeV1 = Pick<PrismaClient, 'budgetCandidateCorrectionV1' | 'budgetScopedFactReviewV1' | '$transaction'>;

export class PrismaCandidateCorrectionRepositoryV1 implements CandidateCorrectionRepositoryV1 {
  constructor(private readonly prisma: CandidateCorrectionPrismaLikeV1) {}

  async commitCorrection(input: CommitCandidateCorrectionInputV1): Promise<CommitCandidateCorrectionResultV1> {
    return commitCandidateCorrectionAtomicallyV1(this.prisma, input);
  }

  async insertLink(input: InsertCandidateCorrectionInputV1): Promise<InsertCandidateCorrectionResultV1> {
    const data: Prisma.BudgetCandidateCorrectionV1UncheckedCreateInput = {
      oldCandidateId: input.oldCandidateId,
      newCandidateId: input.newCandidateId,
      oldCandidateStatusAtCorrection: input.oldCandidateStatusAtCorrection,
      oldCandidateSourceDocumentId: input.oldCandidateSourceDocumentId,
      oldCandidateSourceSha256: input.oldCandidateSourceSha256,
      newCandidateSourceDocumentId: input.newCandidateSourceDocumentId,
      newCandidateSourceSha256: input.newCandidateSourceSha256,
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

/** Internal signal used ONLY to unwind out of `$transaction`'s callback on a
 * unique-index conflict, so Prisma rolls back everything the callback did
 * (including the supersession) -- never thrown or seen outside this function. */
class CandidateCorrectionConflictSignal extends Error {}

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
 */
export async function commitCandidateCorrectionAtomicallyV1(
  prisma: CandidateCorrectionPrismaLikeV1,
  input: CommitCandidateCorrectionInputV1,
): Promise<CommitCandidateCorrectionResultV1> {
  try {
    return await prisma.$transaction(async (tx) => {
      const supersededScopedFactReviewIds = await supersedeAllForCandidateWithClientV1(tx, {
        candidateId: input.oldCandidateId,
        actor: input.actor,
        reason: input.supersessionReason,
        now: input.now,
      });

      const data: Prisma.BudgetCandidateCorrectionV1UncheckedCreateInput = {
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

      let inserted;
      try {
        inserted = await tx.budgetCandidateCorrectionV1.create({ data });
      } catch (error) {
        if (isPrismaUniqueViolation(error)) {
          // Abort the WHOLE transaction, including the supersession above.
          throw new CandidateCorrectionConflictSignal();
        }
        throw error;
      }
      return { outcome: 'inserted' as const, row: toRow(inserted as unknown as PrismaRow), supersededScopedFactReviewIds };
    });
  } catch (error) {
    if (error instanceof CandidateCorrectionConflictSignal) {
      return { outcome: 'conflict' };
    }
    throw error;
  }
}

function isPrismaUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === PRISMA_UNIQUE_VIOLATION_CODE
  );
}
