/**
 * candidate-correction-repository-v1.spec -- Phase 10B-35c.
 *
 * Fake-Prisma unit coverage, mirroring `scoped-fact-review-repository-v1.spec.ts`'s
 * pattern: no real DB, fast and deterministic. The fake simulates Postgres's
 * own unique-index behavior on `old_candidate_id` AND `new_candidate_id` (a
 * real `create()` against the actual migration would throw a Prisma P2002 on
 * either collision) so `insertLink`'s conflict-detection path is exercised
 * without needing a live database. The REAL constraint (and the real trigger
 * enforcing the same-source-identity invariant) is proven separately in the
 * disposable-Postgres e2e spec.
 */
import { describe, expect, it } from '@jest/globals';
import { PrismaCandidateCorrectionRepositoryV1, PRISMA_UNIQUE_VIOLATION_CODE, type CandidateCorrectionRowV1 } from './candidate-correction-repository-v1.js';

interface FakeRow {
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
  createdAt: Date;
}

class PrismaLikeUniqueViolation extends Error {
  code = PRISMA_UNIQUE_VIOLATION_CODE;
  constructor(field: string) {
    super(`Unique constraint failed on the fields: (${field})`);
  }
}

/** Minimal fake satisfying only the Prisma surface this repository touches,
 * simulating the two real unique indexes from the migration. */
class FakeCandidateCorrectionPrisma {
  private rows: FakeRow[] = [];
  private seq = 0;

  budgetCandidateCorrectionV1 = {
    create: async (args: { data: Omit<FakeRow, 'id' | 'createdAt' | 'supersededScopedFactReviewIds'> & { supersededScopedFactReviewIds: unknown } }) => {
      if (this.rows.some((r) => r.oldCandidateId === args.data.oldCandidateId)) {
        throw new PrismaLikeUniqueViolation('old_candidate_id');
      }
      if (this.rows.some((r) => r.newCandidateId === args.data.newCandidateId)) {
        throw new PrismaLikeUniqueViolation('new_candidate_id');
      }
      const row: FakeRow = {
        id: `link-${++this.seq}`,
        createdAt: new Date('2026-09-09T00:00:00.000Z'),
        ...args.data,
        supersededScopedFactReviewIds: args.data.supersededScopedFactReviewIds as string[],
      };
      this.rows.push(row);
      return row;
    },
    findUnique: async (args: { where: { oldCandidateId?: string; newCandidateId?: string; id?: string } }) => {
      if (args.where.oldCandidateId) return this.rows.find((r) => r.oldCandidateId === args.where.oldCandidateId) ?? null;
      if (args.where.newCandidateId) return this.rows.find((r) => r.newCandidateId === args.where.newCandidateId) ?? null;
      if (args.where.id) return this.rows.find((r) => r.id === args.where.id) ?? null;
      return null;
    },
  };

  allRows(): FakeRow[] {
    return [...this.rows];
  }
}

function baseInput(overrides: Partial<Parameters<PrismaCandidateCorrectionRepositoryV1['insertLink']>[0]> = {}) {
  return {
    oldCandidateId: 'old-1',
    newCandidateId: 'new-1',
    oldCandidateStatusAtCorrection: 'NEEDS_REVIEW',
    oldCandidateSourceDocumentId: 'doc-1',
    oldCandidateSourceSha256: 'a'.repeat(64),
    newCandidateSourceDocumentId: 'doc-1',
    newCandidateSourceSha256: 'a'.repeat(64),
    supersededScopedFactReviewIds: [],
    actor: 'neo@capiro.ai',
    reason: 'test correction',
    ...overrides,
  };
}

describe('PrismaCandidateCorrectionRepositoryV1', () => {
  it('inserts a link row and reports it back by old and new candidate id', async () => {
    const prisma = new FakeCandidateCorrectionPrisma();
    const repo = new PrismaCandidateCorrectionRepositoryV1(prisma as never);

    const result = await repo.insertLink(baseInput());
    expect(result.outcome).toBe('inserted');
    const row = (result as { outcome: 'inserted'; row: CandidateCorrectionRowV1 }).row;
    expect(row.oldCandidateId).toBe('old-1');
    expect(row.newCandidateId).toBe('new-1');

    expect(await repo.readByOldCandidateId('old-1')).toEqual(row);
    expect(await repo.readByNewCandidateId('new-1')).toEqual(row);
    expect(await repo.readById(row.id)).toEqual(row);
  });

  it('reports a conflict, never a thrown error, when old_candidate_id already has a link (idempotency/concurrency arbitration point)', async () => {
    const prisma = new FakeCandidateCorrectionPrisma();
    const repo = new PrismaCandidateCorrectionRepositoryV1(prisma as never);

    await repo.insertLink(baseInput({ newCandidateId: 'new-1' }));
    const second = await repo.insertLink(baseInput({ newCandidateId: 'new-2' }));

    expect(second).toEqual({ outcome: 'conflict' });
    expect(prisma.allRows()).toHaveLength(1); // never a second row
  });

  it('reports a conflict when new_candidate_id already has a link, even for a different old candidate', async () => {
    const prisma = new FakeCandidateCorrectionPrisma();
    const repo = new PrismaCandidateCorrectionRepositoryV1(prisma as never);

    await repo.insertLink(baseInput({ oldCandidateId: 'old-1', newCandidateId: 'new-1' }));
    const second = await repo.insertLink(baseInput({ oldCandidateId: 'old-2', newCandidateId: 'new-1' }));

    expect(second).toEqual({ outcome: 'conflict' });
    expect(prisma.allRows()).toHaveLength(1);
  });

  it('re-throws a non-unique-violation error rather than swallowing it as a conflict', async () => {
    const prisma = new FakeCandidateCorrectionPrisma();
    prisma.budgetCandidateCorrectionV1.create = async () => {
      throw new Error('connection reset');
    };
    const repo = new PrismaCandidateCorrectionRepositoryV1(prisma as never);

    await expect(repo.insertLink(baseInput())).rejects.toThrow('connection reset');
  });

  it('readByOldCandidateId / readByNewCandidateId / readById all return null when nothing exists', async () => {
    const prisma = new FakeCandidateCorrectionPrisma();
    const repo = new PrismaCandidateCorrectionRepositoryV1(prisma as never);

    expect(await repo.readByOldCandidateId('none')).toBeNull();
    expect(await repo.readByNewCandidateId('none')).toBeNull();
    expect(await repo.readById('none')).toBeNull();
  });
});
