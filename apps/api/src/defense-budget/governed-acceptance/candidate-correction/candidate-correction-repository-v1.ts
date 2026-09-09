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

export interface CandidateCorrectionRepositoryV1 {
  /** Attempts to insert the link row. Never pre-checks; always attempts, and
   * reports whether the unique index accepted it. */
  insertLink(input: InsertCandidateCorrectionInputV1): Promise<InsertCandidateCorrectionResultV1>;
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

/** The minimal Prisma surface this repository touches (for fakes in tests). */
export type CandidateCorrectionPrismaLikeV1 = Pick<PrismaClient, 'budgetCandidateCorrectionV1'>;

export class PrismaCandidateCorrectionRepositoryV1 implements CandidateCorrectionRepositoryV1 {
  constructor(private readonly prisma: CandidateCorrectionPrismaLikeV1) {}

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

function isPrismaUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === PRISMA_UNIQUE_VIOLATION_CODE
  );
}
