/**
 * candidate-correction-repository-v1.spec -- Phase 10B-35c.
 *
 * Fake-Prisma unit coverage, mirroring `scoped-fact-review-repository-v1.spec.ts`'s
 * pattern: no real DB, fast and deterministic. The fake simulates Postgres's
 * own unique-index behavior on `old_candidate_id` AND `new_candidate_id` (a
 * real `create()` against the actual migration would throw a Prisma P2002 on
 * either collision) so `insertLink`'s conflict-detection path is exercised
 * without needing a live database. The fake's `$transaction` also simulates
 * REAL rollback semantics (mutations made inside a throwing callback are
 * discarded entirely) specifically so `commitCorrection`'s atomicity fix
 * (2026-09-09 -- see `commitCandidateCorrectionAtomicallyV1`'s doc comment)
 * has fast, deterministic coverage in addition to the disposable-Postgres
 * e2e spec's real-transaction proof.
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
  reviewedIntentVersion: number | null;
  reviewedIntent: unknown;
  reviewedIntentSha256: string | null;
  supersededScopedFactReviewIds: string[];
  actor: string;
  reason: string;
  createdAt: Date;
}

interface FakeScopedReviewRow {
  id: string;
  candidateId: string;
  status: string;
  revokedAt: Date | null;
  revokedBy: string | null;
  revocationReason: string | null;
}

class PrismaLikeUniqueViolation extends Error {
  code = PRISMA_UNIQUE_VIOLATION_CODE;
  meta: { target: string[] };
  constructor(field: string) {
    super(`Unique constraint failed on the fields: (${field})`);
    this.meta = { target: [field] };
  }
}

/** A model-delegate pair bound to a specific backing store -- either the
 * fake's real, committed state, or a transaction's private working copy. */
function buildDelegates(rows: FakeRow[], scopedReviews: FakeScopedReviewRow[], seqRef: { n: number }) {
  const delegates = {
    budgetCandidateCorrectionV1: {
      create: async (args: {
        data: Omit<FakeRow, 'id' | 'createdAt' | 'supersededScopedFactReviewIds' | 'reviewedIntentSha256'> & {
          supersededScopedFactReviewIds: unknown;
          reviewedIntentSha256?: string | null;
        };
      }) => {
        if (rows.some((r) => r.oldCandidateId === args.data.oldCandidateId)) {
          throw new PrismaLikeUniqueViolation('old_candidate_id');
        }
        if (rows.some((r) => r.newCandidateId === args.data.newCandidateId)) {
          throw new PrismaLikeUniqueViolation('new_candidate_id');
        }
        const row: FakeRow = {
          id: `link-${++seqRef.n}`,
          createdAt: new Date('2026-09-09T00:00:00.000Z'),
          ...args.data,
          // Real Postgres owns this value in its BEFORE INSERT trigger.
          reviewedIntentSha256: args.data.reviewedIntentSha256 ?? 'f'.repeat(64),
          supersededScopedFactReviewIds: args.data.supersededScopedFactReviewIds as string[],
        };
        rows.push(row);
        return row;
      },
      findUnique: async (args: { where: { oldCandidateId?: string; newCandidateId?: string; id?: string } }) => {
        if (args.where.oldCandidateId) return rows.find((r) => r.oldCandidateId === args.where.oldCandidateId) ?? null;
        if (args.where.newCandidateId) return rows.find((r) => r.newCandidateId === args.where.newCandidateId) ?? null;
        if (args.where.id) return rows.find((r) => r.id === args.where.id) ?? null;
        return null;
      },
    },
    budgetScopedFactReviewV1: {
      findMany: async (args: { where: { candidateId: string; status: string } }) => {
        return scopedReviews.filter((r) => r.candidateId === args.where.candidateId && r.status === args.where.status).map((r) => ({ id: r.id }));
      },
      update: async (args: { where: { id: string }; data: Partial<FakeScopedReviewRow> }) => {
        const row = scopedReviews.find((r) => r.id === args.where.id);
        if (!row) throw new Error(`fake: no scoped review row ${args.where.id}`);
        Object.assign(row, args.data);
        return row;
      },
    },
  };
  return {
    ...delegates,
    $queryRaw: async (query: { strings?: string[]; sql?: string; values?: unknown[] }) => {
      const sql = query.sql ?? query.strings?.join('?') ?? '';
      const values = query.values ?? [];
      if (sql.includes('pg_advisory_xact_lock')) return [{ pg_advisory_xact_lock: null }];
      if (sql.includes('budget_extraction_candidate_v1')) {
        return values
          .filter((value): value is string => typeof value === 'string')
          .slice(0, 2)
          .map((id) => ({
            id,
            status: id.startsWith('old-') ? 'NEEDS_REVIEW' : 'VERIFIED',
            currentRunId: id.startsWith('old-') ? 'run-old-1' : 'run-new-1',
            sourceDocumentId: 'doc-1',
            sourceSha256: 'a'.repeat(64),
            extractionArtifactId: id.startsWith('old-') ? 'artifact-old-1' : 'artifact-new-1',
            extractionArtifactSha256: id.startsWith('old-') ? 'b'.repeat(64) : 'c'.repeat(64),
            manifestContentSha256: id.startsWith('old-') ? 'd'.repeat(64) : 'e'.repeat(64),
          }));
      }
      if (sql.includes('budget_scoped_fact_review_v1')) {
        const candidateId = values.find((value): value is string => typeof value === 'string');
        return scopedReviews
          .filter((row) => row.candidateId === candidateId && row.status === 'active')
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((row) => ({ id: row.id }));
      }
      throw new Error(`unexpected fake raw query: ${sql}`);
    },
  };
}

/** Minimal fake satisfying only the Prisma surface this repository touches,
 * simulating the two real unique indexes from the migration AND real
 * `$transaction` rollback semantics (a throwing callback discards every
 * mutation it made, committed callbacks merge back atomically). */
class FakeCandidateCorrectionPrisma {
  private rows: FakeRow[] = [];
  private scopedReviews: FakeScopedReviewRow[] = [];
  private seqRef = { n: 0 };
  private transactionalCreateConflict: { field: string; winner: FakeRow } | null = null;

  private delegates = buildDelegates(this.rows, this.scopedReviews, this.seqRef);
  budgetCandidateCorrectionV1 = this.delegates.budgetCandidateCorrectionV1;
  budgetScopedFactReviewV1 = this.delegates.budgetScopedFactReviewV1;

  async $transaction<T>(fn: (tx: ReturnType<typeof buildDelegates>) => Promise<T>): Promise<T> {
    // Real rollback semantics: the callback only ever sees and mutates a
    // private working copy. It's merged back into the committed state ONLY
    // if the callback resolves; if it throws, the working copy (and
    // everything it did) is simply discarded.
    const txRows = this.rows.map((r) => ({ ...r }));
    const txScopedReviews = this.scopedReviews.map((r) => ({ ...r }));
    const tx = buildDelegates(txRows, txScopedReviews, this.seqRef);
    if (this.transactionalCreateConflict != null) {
      const injected = this.transactionalCreateConflict;
      this.transactionalCreateConflict = null;
      tx.budgetCandidateCorrectionV1.create = async () => {
        // Simulate a mixed-version/direct writer committing after our early
        // reads but before our final INSERT. This external winner is durable;
        // the current transaction's scoped-review mutations must roll back.
        this.rows.push({ ...injected.winner });
        throw new PrismaLikeUniqueViolation(injected.field);
      };
    }
    const result = await fn(tx);
    this.rows.length = 0;
    this.rows.push(...txRows);
    this.scopedReviews.length = 0;
    this.scopedReviews.push(...txScopedReviews);
    return result;
  }

  allRows(): FakeRow[] {
    return [...this.rows];
  }

  /** Test-only: seed a real active scoped-fact-review row directly. */
  seedActiveScopedReview(row: FakeScopedReviewRow): void {
    this.scopedReviews.push(row);
  }

  scopedReviewById(id: string): FakeScopedReviewRow | undefined {
    return this.scopedReviews.find((r) => r.id === id);
  }

  injectTransactionalCreateConflict(field: string, winner: FakeRow): void {
    this.transactionalCreateConflict = { field, winner };
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
    oldCandidateCurrentRunId: 'run-old-1',
    oldCandidateExtractionArtifactId: 'artifact-old-1',
    oldCandidateExtractionArtifactSha256: 'b'.repeat(64),
    oldCandidateManifestContentSha256: 'd'.repeat(64),
    newCandidateCurrentRunId: 'run-new-1',
    newCandidateExtractionArtifactId: 'artifact-new-1',
    newCandidateExtractionArtifactSha256: 'c'.repeat(64),
    newCandidateManifestContentSha256: 'e'.repeat(64),
    selectedScopes: [],
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

function baseCommitInput(overrides: Partial<Parameters<PrismaCandidateCorrectionRepositoryV1['commitCorrection']>[0]> = {}) {
  return {
    ...baseInput(),
    oldCandidateCurrentRunId: 'run-old-1',
    oldCandidateExtractionArtifactId: 'artifact-old-1',
    oldCandidateExtractionArtifactSha256: 'b'.repeat(64),
    oldCandidateManifestContentSha256: 'd'.repeat(64),
    newCandidateCurrentRunId: 'run-new-1',
    newCandidateExtractionArtifactId: 'artifact-new-1',
    newCandidateExtractionArtifactSha256: 'c'.repeat(64),
    newCandidateManifestContentSha256: 'e'.repeat(64),
    supersessionReason: 'superseded by correction',
    now: '2026-09-09T12:00:00.000Z',
    ...overrides,
  };
}

describe('PrismaCandidateCorrectionRepositoryV1.commitCorrection (atomic supersede + insert)', () => {
  it('the zero-active-approvals case: inserts the link, reports an empty superseded list', async () => {
    const prisma = new FakeCandidateCorrectionPrisma();
    const repo = new PrismaCandidateCorrectionRepositoryV1(prisma as never);

    const result = await repo.commitCorrection(baseCommitInput());
    expect(result.outcome).toBe('inserted');
    expect((result as { outcome: 'inserted'; supersededScopedFactReviewIds: string[] }).supersededScopedFactReviewIds).toEqual([]);
  });

  it('rechecks exact run/artifact/manifest intent under the candidate locks and refuses stale input with zero writes', async () => {
    const prisma = new FakeCandidateCorrectionPrisma();
    const repo = new PrismaCandidateCorrectionRepositoryV1(prisma as never);

    const result = await repo.commitCorrection(
      baseCommitInput({ newCandidateManifestContentSha256: 'f'.repeat(64) }),
    );

    expect(result).toMatchObject({ outcome: 'stale_eligibility' });
    expect(prisma.allRows()).toHaveLength(0);
  });

  it('the active-approval case: supersedes the active row in the SAME operation that inserts the link', async () => {
    const prisma = new FakeCandidateCorrectionPrisma();
    prisma.seedActiveScopedReview({ id: 'review-a', candidateId: 'old-1', status: 'active', revokedAt: null, revokedBy: null, revocationReason: null });
    const repo = new PrismaCandidateCorrectionRepositoryV1(prisma as never);

    const result = await repo.commitCorrection(baseCommitInput());
    expect(result.outcome).toBe('inserted');
    expect((result as { outcome: 'inserted'; supersededScopedFactReviewIds: string[] }).supersededScopedFactReviewIds).toEqual(['review-a']);

    const supersededRow = prisma.scopedReviewById('review-a')!;
    expect(supersededRow.status).toBe('superseded');
    expect(supersededRow.revokedAt).toEqual(new Date('2026-09-09T12:00:00.000Z'));
  });

  it('THE FIX: when the link insert conflicts, the supersession is rolled back too -- zero writes, not a half-completed side effect', async () => {
    // Reproduces the exact defect independent review found: a prior version
    // called supersede-then-insert as two separate top-level statements, so
    // a losing insert left the supersession already committed. Here,
    // old_candidate_id is already claimed by an EXISTING link (`old-1`
    // already linked to `new-existing`), so THIS attempt's insert must
    // conflict -- and its own supersession attempt on `old-1`'s active
    // review must never take effect.
    const prisma = new FakeCandidateCorrectionPrisma();
    const repo = new PrismaCandidateCorrectionRepositoryV1(prisma as never);
    await repo.insertLink(baseInput({ oldCandidateId: 'old-1', newCandidateId: 'new-existing' }));
    prisma.seedActiveScopedReview({ id: 'review-a', candidateId: 'old-1', status: 'active', revokedAt: null, revokedBy: null, revocationReason: null });

    const result = await repo.commitCorrection(baseCommitInput({ oldCandidateId: 'old-1', newCandidateId: 'new-1' }));

    expect(result).toMatchObject({
      outcome: 'conflict',
      conflictOn: 'old_candidate',
      existingLink: { oldCandidateId: 'old-1', newCandidateId: 'new-existing' },
    });
    // THE regression assertion: the supersession attempt made INSIDE the
    // same failed transaction must not have persisted.
    const reviewRow = prisma.scopedReviewById('review-a')!;
    expect(reviewRow.status).toBe('active');
    expect(reviewRow.revokedAt).toBeNull();
    expect(reviewRow.revokedBy).toBeNull();
    // And exactly the one pre-existing link exists -- no partial insert either.
    expect(prisma.allRows()).toHaveLength(1);
  });

  it('classifies a narrow P2002 at the final INSERT after rollback and preserves the old active review', async () => {
    const prisma = new FakeCandidateCorrectionPrisma();
    prisma.seedActiveScopedReview({
      id: 'review-final-insert-race',
      candidateId: 'old-1',
      status: 'active',
      revokedAt: null,
      revokedBy: null,
      revocationReason: null,
    });
    prisma.injectTransactionalCreateConflict('old_candidate_id', {
      id: 'external-winner',
      oldCandidateId: 'old-1',
      newCandidateId: 'new-external',
      oldCandidateStatusAtCorrection: 'NEEDS_REVIEW',
      oldCandidateSourceDocumentId: 'doc-1',
      oldCandidateSourceSha256: 'a'.repeat(64),
      newCandidateSourceDocumentId: 'doc-1',
      newCandidateSourceSha256: 'a'.repeat(64),
      reviewedIntentVersion: null,
      reviewedIntent: null,
      reviewedIntentSha256: null,
      supersededScopedFactReviewIds: [],
      actor: 'external-writer',
      reason: 'mixed-version final insert winner',
      createdAt: new Date('2026-09-09T11:59:59.000Z'),
    });
    const repo = new PrismaCandidateCorrectionRepositoryV1(prisma as never);

    await expect(repo.commitCorrection(baseCommitInput())).resolves.toMatchObject({
      outcome: 'conflict',
      conflictOn: 'old_candidate',
      existingLink: { id: 'external-winner', newCandidateId: 'new-external' },
    });
    expect(prisma.scopedReviewById('review-final-insert-race')).toMatchObject({
      status: 'active',
      revokedAt: null,
      revokedBy: null,
    });
    expect(prisma.allRows()).toHaveLength(1);
  });
});
