/**
 * reviewed-partial-pe-totals-prisma-repository-v1.spec -- Phase 10B-35 repair.
 *
 * Pins the read-time candidate-eligibility gate added to
 * `PrismaReviewedPartialPeTotalsRepositoryV1`. Independent review of the
 * original PR found that a scoped approval recorded while its candidate was
 * NEEDS_REVIEW/REVIEW_ACCEPTED kept being served forever even if a later,
 * unrelated whole-candidate review process moved that SAME candidate to
 * REJECTED (or any other non-reviewable status) -- nothing re-ran the
 * eligibility policy at read time. This spec proves the fix at both layers:
 *   1. the DB-side `where` clause now names the candidate-status filter
 *      (so real Postgres does the filtering, not just this process); and
 *   2. an in-process belt-and-suspenders re-check drops any row whose
 *      `candidate.status` is not reviewable even if a query somehow still
 *      returned it (mirrors the existing component-filter double-check
 *      already in this file).
 *
 * Uses a fake Prisma client (no real DB) -- fast, deterministic, and
 * consistent with this module's existing "minimal Prisma surface ... for
 * fakes in tests" pattern (see `ScopedFactReviewPrismaLikeV1` in
 * `scoped-fact-review-repository-v1.ts`).
 */
import { describe, expect, it } from '@jest/globals';
import { PrismaReviewedPartialPeTotalsRepositoryV1 } from './reviewed-partial-pe-totals-prisma-repository-v1.js';

function baseRow(overrides: { id: string; candidateStatus: string; component?: string; fiscalYear?: number }) {
  return {
    id: overrides.id,
    candidateId: `candidate-${overrides.id}`,
    runId: `run-${overrides.id}`,
    sourceDocumentId: 'source-doc-1',
    sourceSha256: 'a'.repeat(64),
    extractionArtifactId: 'artifact-1',
    extractionArtifactSha256: 'b'.repeat(64),
    manifestContentSha256: 'c'.repeat(64),
    policyId: 'scoped-fact-review-policy-v1',
    policyVersion: '1.0.0',
    policySha256: 'd'.repeat(64),
    scopeKind: 'rdte_r2_pe_total_request_fy',
    scopeKey: `0601102A:${overrides.fiscalYear ?? 2024}:request`,
    scope: { peCode: '0601102A', fiscalYear: overrides.fiscalYear ?? 2024, fundingField: 'request', component: overrides.component ?? 'ARMY' },
    assertionIds: ['assertion-1'],
    evidenceIds: ['evidence-1'],
    projection: {},
    independence: {},
    limitations: [],
    decision: 'approve',
    reviewerId: 'neo@capiro.ai',
    rationale: 'test row',
    decisionHash: 'e'.repeat(64),
    status: 'active',
    revokedAt: null,
    revokedBy: null,
    revocationReason: null,
    supersededById: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    // Present only because `include: { candidate: { select: { status } } }`
    // asks Prisma to nest it -- exactly what the real query returns.
    candidate: { status: overrides.candidateStatus, correctedBy: null as { id: string } | null },
  };
}

/** Captures the `where`/`include` Prisma was actually asked for, and applies
 * a minimal, faithful-enough interpretation of the candidate-status clause so
 * a regression in the query construction shows up as a behavioral failure,
 * not just a snapshot of the arguments. */
class FakeCapturingPrisma {
  public lastArgs: { where: unknown; include: unknown } | null = null;
  constructor(private readonly rows: ReturnType<typeof baseRow>[]) {}

  budgetScopedFactReviewV1 = {
    findMany: async (args: { where: { AND: unknown[] }; include: unknown }) => {
      this.lastArgs = { where: args.where, include: args.include };
      const candidateClause = args.where.AND.find(
        (c): c is { candidate: { status: { in: string[] } } } =>
          typeof c === 'object' && c !== null && 'candidate' in (c as Record<string, unknown>),
      );
      if (!candidateClause) {
        // No candidate-status clause in the query at all -- the pre-fix
        // shape. Return every row unfiltered by candidate status, exactly
        // like the pre-fix DB layer would have.
        return this.rows;
      }
      const allowed = new Set(candidateClause.candidate.status.in);
      return this.rows.filter((r) => allowed.has(r.candidate.status));
    },
  };
}

describe('PrismaReviewedPartialPeTotalsRepositoryV1 -- read-time candidate eligibility', () => {
  it('excludes a row whose candidate was later marked REJECTED by an unrelated process, even though the row itself is still active/approve', async () => {
    const rows = [
      baseRow({ id: 'still-eligible', candidateStatus: 'NEEDS_REVIEW' }),
      baseRow({ id: 'stale-after-reject', candidateStatus: 'REJECTED' }),
    ];
    const prisma = new FakeCapturingPrisma(rows);
    const repo = new PrismaReviewedPartialPeTotalsRepositoryV1(prisma as never);

    const result = await repo.listActiveApprovedByScopeKind('rdte_r2_pe_total_request_fy', { fiscalYear: 2024 });

    expect(result.map((r) => r.id)).toEqual(['still-eligible']);
  });

  it('includes a row whose candidate has moved to REVIEW_ACCEPTED (still a reviewable status)', async () => {
    const rows = [baseRow({ id: 'accepted', candidateStatus: 'REVIEW_ACCEPTED' })];
    const prisma = new FakeCapturingPrisma(rows);
    const repo = new PrismaReviewedPartialPeTotalsRepositoryV1(prisma as never);

    const result = await repo.listActiveApprovedByScopeKind('rdte_r2_pe_total_request_fy', { fiscalYear: 2024 });

    expect(result.map((r) => r.id)).toEqual(['accepted']);
  });

  it('asks the DB layer itself to filter by candidate status (NEEDS_REVIEW/REVIEW_ACCEPTED only) -- not merely an in-process filter', async () => {
    const prisma = new FakeCapturingPrisma([]);
    const repo = new PrismaReviewedPartialPeTotalsRepositoryV1(prisma as never);

    await repo.listActiveApprovedByScopeKind('rdte_r2_pe_total_request_fy', { fiscalYear: 2024 });

    expect(prisma.lastArgs).not.toBeNull();
    const clauses = (prisma.lastArgs!.where as { AND: unknown[] }).AND;
    const candidateClause = clauses.find(
      (c): c is { candidate: { status: { in: string[] } } } =>
        typeof c === 'object' && c !== null && 'candidate' in (c as Record<string, unknown>),
    );
    expect(candidateClause).toBeDefined();
    expect(new Set(candidateClause!.candidate.status.in)).toEqual(new Set(['NEEDS_REVIEW', 'REVIEW_ACCEPTED']));
  });

  it('Phase 10B-35c: excludes a row whose candidate has since been formally corrected, even though the candidate status column itself is still reviewable', async () => {
    const stillEligible = baseRow({ id: 'still-eligible', candidateStatus: 'NEEDS_REVIEW' });
    const correctedAway = baseRow({ id: 'corrected-away', candidateStatus: 'NEEDS_REVIEW' });
    correctedAway.candidate.correctedBy = { id: 'correction-link-1' };
    const prisma = new FakeCapturingPrisma([stillEligible, correctedAway]);
    const repo = new PrismaReviewedPartialPeTotalsRepositoryV1(prisma as never);

    const result = await repo.listActiveApprovedByScopeKind('rdte_r2_pe_total_request_fy', { fiscalYear: 2024 });

    expect(result.map((r) => r.id)).toEqual(['still-eligible']);
  });

  it('Phase 10B-35c: the in-process re-check also drops a corrected-away candidate if the DB layer somehow still returned it', async () => {
    const row = baseRow({ id: 'leaked-corrected', candidateStatus: 'NEEDS_REVIEW' });
    row.candidate.correctedBy = { id: 'correction-link-1' };
    const leakyPrisma = {
      budgetScopedFactReviewV1: { findMany: async () => [row] },
    };
    const repo = new PrismaReviewedPartialPeTotalsRepositoryV1(leakyPrisma as never);

    const result = await repo.listActiveApprovedByScopeKind('rdte_r2_pe_total_request_fy', { fiscalYear: 2024 });

    expect(result).toEqual([]);
  });

  it('a row belonging to a candidate the query somehow still returned as REJECTED is dropped by the in-process re-check (belt-and-suspenders)', async () => {
    // Simulates a DB/Prisma edge case where the WHERE clause did not narrow
    // the result set (e.g. a future Prisma version handling a relation
    // filter differently) -- the in-process filter must still exclude it.
    const rows = [baseRow({ id: 'leaked-rejected', candidateStatus: 'REJECTED' })];
    const leakyPrisma = {
      budgetScopedFactReviewV1: { findMany: async () => rows },
    };
    const repo = new PrismaReviewedPartialPeTotalsRepositoryV1(leakyPrisma as never);

    const result = await repo.listActiveApprovedByScopeKind('rdte_r2_pe_total_request_fy', { fiscalYear: 2024 });

    expect(result).toEqual([]);
  });
});
