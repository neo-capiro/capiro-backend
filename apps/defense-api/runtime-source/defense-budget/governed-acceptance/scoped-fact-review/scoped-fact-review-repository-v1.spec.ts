/**
 * scoped-fact-review-repository-v1.spec -- Phase 10B-35 repair.
 *
 * Independent review of the original PR found `supersedeAllForCandidate()` on
 * `PrismaScopedFactReviewRepositoryV1` had zero callers anywhere in the
 * codebase and zero test coverage -- unexercised scaffolding described in its
 * own docstring as "used when a candidate is superseded by a corrected
 * re-extraction," but with unproven behavior. Rather than leave it both
 * unused and unverified, this pins its actual behavior now (before any future
 * phase wires it up) using a fake Prisma client -- no real DB needed, fast
 * and deterministic. It does not add a caller; it only proves the method
 * itself does what its docstring claims.
 */
import { describe, expect, it } from '@jest/globals';
import { PrismaScopedFactReviewRepositoryV1 } from './scoped-fact-review-repository-v1.js';

interface FakeRow {
  id: string;
  candidateId: string;
  status: string;
  revokedAt: Date | null;
  revokedBy: string | null;
  revocationReason: string | null;
}

/** Minimal fake satisfying only the Prisma surface `supersedeAllForCandidate`
 * touches (`findMany` + `update`), mirroring this module's own
 * `ScopedFactReviewPrismaLikeV1` "for fakes in tests" pattern. */
class FakeScopedFactReviewPrisma {
  public updateCalls: Array<{ id: string; data: Record<string, unknown> }> = [];
  constructor(private readonly rows: FakeRow[]) {}

  budgetScopedFactReviewV1 = {
    findMany: async (args: { where: { candidateId: string; status: string }; select?: { id: true } }) => {
      return this.rows
        .filter((r) => r.candidateId === args.where.candidateId && r.status === args.where.status)
        .map((r) => ({ id: r.id }));
    },
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      this.updateCalls.push({ id: args.where.id, data: args.data });
      const row = this.rows.find((r) => r.id === args.where.id);
      if (!row) throw new Error(`fake: no row ${args.where.id}`);
      Object.assign(row, args.data);
      return row;
    },
  };

  $transaction = async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(this);

  rowById(id: string): FakeRow | undefined {
    return this.rows.find((r) => r.id === id);
  }
}

function activeRow(id: string, candidateId: string): FakeRow {
  return { id, candidateId, status: 'active', revokedAt: null, revokedBy: null, revocationReason: null };
}

describe('PrismaScopedFactReviewRepositoryV1.supersedeAllForCandidate', () => {
  it('marks every active row of the given candidate superseded, with revocation metadata, and returns their ids', async () => {
    const prisma = new FakeScopedFactReviewPrisma([
      activeRow('row-a', 'candidate-1'),
      activeRow('row-b', 'candidate-1'),
      activeRow('row-other-candidate', 'candidate-2'),
    ]);
    const repo = new PrismaScopedFactReviewRepositoryV1(prisma as never);

    const supersededIds = await repo.supersedeAllForCandidate({
      candidateId: 'candidate-1',
      actor: 'neo@capiro.ai',
      reason: 'candidate-1 superseded by corrected re-extraction candidate-3',
      now: '2026-09-09T00:00:00.000Z',
    });

    expect(new Set(supersededIds)).toEqual(new Set(['row-a', 'row-b']));

    for (const id of ['row-a', 'row-b']) {
      const row = prisma.rowById(id)!;
      expect(row.status).toBe('superseded');
      expect(row.revokedBy).toBe('neo@capiro.ai');
      expect(row.revocationReason).toBe('candidate-1 superseded by corrected re-extraction candidate-3');
      expect(row.revokedAt).toEqual(new Date('2026-09-09T00:00:00.000Z'));
    }
  });

  it('never touches a row belonging to a different candidate', async () => {
    const prisma = new FakeScopedFactReviewPrisma([activeRow('row-a', 'candidate-1'), activeRow('row-other-candidate', 'candidate-2')]);
    const repo = new PrismaScopedFactReviewRepositoryV1(prisma as never);

    await repo.supersedeAllForCandidate({ candidateId: 'candidate-1', actor: 'neo@capiro.ai', reason: 'test isolation', now: '2026-09-09T00:00:00.000Z' });

    expect(prisma.rowById('row-other-candidate')!.status).toBe('active');
    expect(prisma.updateCalls.map((c) => c.id)).not.toContain('row-other-candidate');
  });

  it('returns an empty array and issues no updates when the candidate has no active rows', async () => {
    const prisma = new FakeScopedFactReviewPrisma([{ id: 'row-a', candidateId: 'candidate-1', status: 'revoked', revokedAt: new Date(), revokedBy: 'x', revocationReason: 'already revoked' }]);
    const repo = new PrismaScopedFactReviewRepositoryV1(prisma as never);

    const result = await repo.supersedeAllForCandidate({ candidateId: 'candidate-1', actor: 'neo@capiro.ai', reason: 'no-op', now: '2026-09-09T00:00:00.000Z' });

    expect(result).toEqual([]);
    expect(prisma.updateCalls).toEqual([]);
  });
});
