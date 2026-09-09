/**
 * reviewed-partial-pe-totals-prisma-repository-v1 -- Phase 10B-35.
 *
 * The one additional read query the serving surface needs beyond
 * `ScopedFactReviewRepositoryV1`: list every ACTIVE, APPROVED row for a scope
 * kind, filtered by fiscal year / component (read out of the persisted
 * `scope` JSON, not re-derived). Still reads only
 * `budget_scoped_fact_review_v1` -- no join to any canonical or legacy PE
 * table.
 */
import type { PrismaClient } from '@prisma/client';
import type { ScopedFactReviewRowV1 } from './scoped-fact-review-repository-v1.js';
import type {
  ReviewedPartialPeTotalsQueryV1,
  ReviewedPartialPeTotalsRepositoryV1,
} from './reviewed-partial-pe-totals-read.service.js';

type PrismaRow = Parameters<typeof toRow>[0];

function toRow(r: {
  id: string;
  candidateId: string;
  runId: string;
  sourceDocumentId: string;
  sourceSha256: string;
  extractionArtifactId: string;
  extractionArtifactSha256: string;
  manifestContentSha256: string;
  policyId: string;
  policyVersion: string;
  policySha256: string;
  scopeKind: string;
  scopeKey: string;
  scope: unknown;
  assertionIds: unknown;
  evidenceIds: unknown;
  projection: unknown;
  independence: unknown;
  limitations: unknown;
  decision: string;
  reviewerId: string;
  rationale: string;
  decisionHash: string;
  status: string;
  revokedAt: Date | null;
  revokedBy: string | null;
  revocationReason: string | null;
  supersededById: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ScopedFactReviewRowV1 {
  return {
    id: r.id,
    candidateId: r.candidateId,
    runId: r.runId,
    sourceDocumentId: r.sourceDocumentId,
    sourceSha256: r.sourceSha256,
    extractionArtifactId: r.extractionArtifactId,
    extractionArtifactSha256: r.extractionArtifactSha256,
    manifestContentSha256: r.manifestContentSha256,
    policyId: r.policyId,
    policyVersion: r.policyVersion,
    policySha256: r.policySha256,
    scopeKind: r.scopeKind as never,
    scopeKey: r.scopeKey,
    scope: r.scope as never,
    assertionIds: (r.assertionIds as string[]) ?? [],
    evidenceIds: (r.evidenceIds as string[]) ?? [],
    projection: r.projection as never,
    independence: r.independence as never,
    limitations: (r.limitations as string[]) ?? [],
    decision: r.decision as 'approve' | 'reject',
    reviewerId: r.reviewerId,
    rationale: r.rationale,
    decisionHash: r.decisionHash,
    status: r.status as ScopedFactReviewRowV1['status'],
    revokedAt: r.revokedAt?.toISOString() ?? null,
    revokedBy: r.revokedBy,
    revocationReason: r.revocationReason,
    supersededById: r.supersededById,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export class PrismaReviewedPartialPeTotalsRepositoryV1 implements ReviewedPartialPeTotalsRepositoryV1 {
  constructor(private readonly prisma: Pick<PrismaClient, 'budgetScopedFactReviewV1'>) {}

  async listActiveApprovedByScopeKind(scopeKind: string, filter: ReviewedPartialPeTotalsQueryV1): Promise<ScopedFactReviewRowV1[]> {
    // Prisma cannot express two independent JSON-path filters on the same
    // column as separate top-level clauses (a second `scope:` key would
    // silently overwrite the first) -- use an AND array instead. The
    // fiscal-year filter is applied at the DB layer; the component filter is
    // ALSO re-applied in-process below as a belt-and-suspenders check, so a
    // future Prisma/DB version difference in JSON-path filtering can never
    // silently widen the result set beyond what was requested.
    const rows = await this.prisma.budgetScopedFactReviewV1.findMany({
      where: {
        AND: [
          { scopeKind, status: 'active', decision: 'approve' },
          { scope: { path: ['fiscalYear'], equals: filter.fiscalYear } },
          ...(filter.component != null ? [{ scope: { path: ['component'], equals: filter.component } }] : []),
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
    const typed = rows.map((r) => toRow(r as unknown as PrismaRow));
    return filter.component != null
      ? typed.filter((r) => (r.scope as { component?: string }).component === filter.component)
      : typed;
  }
}
