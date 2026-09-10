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

/**
 * Candidate statuses that may still serve an already-recorded scoped
 * approval. Mirrors the whole-candidate eligibility gate enforced (a) at
 * insert time by the `check_budget_scoped_fact_review_v1_binding` DB trigger
 * and (b) by `scoped-fact-review-policy-v1.ts`'s `candidate_not_reviewable`
 * refusal -- but applied again here, at READ time.
 *
 * Why this is needed in addition to those insert-time gates: neither of them
 * re-runs when a candidate's status changes AFTER a scoped approval was
 * already recorded. If a separate, unrelated whole-candidate review process
 * later marks the SAME candidate REJECTED (or moves it to any other
 * non-reviewable status), the scoped-approval row itself is untouched --
 * `status` stays `'active'` and `decision` stays `'approve'` -- because
 * nothing links the two beyond the moment-of-insert trigger check. Without
 * this filter this endpoint would keep serving that stale approval
 * indefinitely, until a human remembered to run the revoke CLI. This does not
 * itself flip a stale row to `superseded`/`revoked` (that still requires an
 * explicit revoke); it only stops SERVING a row bound to a
 * no-longer-reviewable candidate.
 *
 * Phase 10B-35c addition, same rationale: a candidate that has since been
 * formally CORRECTED (has a row in `budget_candidate_correction_v1` as the
 * `old_candidate_id`) must also stop serving here, even though its own
 * `status` column is deliberately left untouched by the correction mechanism
 * (see that migration's header comment) and therefore stays
 * `NEEDS_REVIEW`/`REVIEW_ACCEPTED` -- a status this filter alone would still
 * treat as reviewable. Without this second filter, a scoped approval
 * recorded against an old candidate AFTER it was already corrected (nothing
 * stops that at insert time -- `check_budget_scoped_fact_review_v1_binding`
 * only checks whole-candidate status, not correction links) would keep being
 * served indefinitely alongside the corrected candidate's own data.
 */
const REVIEWABLE_CANDIDATE_STATUSES_V1 = ['NEEDS_REVIEW', 'REVIEW_ACCEPTED'] as const;
type ReviewableCandidateStatusV1 = (typeof REVIEWABLE_CANDIDATE_STATUSES_V1)[number];
function isReviewableCandidateStatus(status: string): status is ReviewableCandidateStatusV1 {
  return (REVIEWABLE_CANDIDATE_STATUSES_V1 as readonly string[]).includes(status);
}

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
    // silently widen the result set beyond what was requested. The candidate
    // status filter is likewise applied at BOTH layers (DB `where` clause
    // below, plus the in-process re-check below that) -- see
    // `REVIEWABLE_CANDIDATE_STATUSES_V1`'s doc comment for why a read-time
    // recheck is required at all.
    const rows = await this.prisma.budgetScopedFactReviewV1.findMany({
      where: {
        AND: [
          { scopeKind, status: 'active', decision: 'approve' },
          { scope: { path: ['fiscalYear'], equals: filter.fiscalYear } },
          ...(filter.component != null ? [{ scope: { path: ['component'], equals: filter.component } }] : []),
          { candidate: { status: { in: [...REVIEWABLE_CANDIDATE_STATUSES_V1] } } },
          // Phase 10B-35c: a corrected candidate's row is never served, even
          // though its whole-candidate `status` is deliberately left
          // untouched by the correction mechanism.
          { candidate: { is: { correctedBy: { is: null } } } },
        ],
      },
      include: { candidate: { select: { status: true, correctedBy: { select: { id: true } } } } },
      orderBy: { createdAt: 'desc' },
    });
    const eligible = rows.filter((r) => {
      const candidate = (r as unknown as { candidate: { status: string; correctedBy: { id: string } | null } }).candidate;
      return isReviewableCandidateStatus(candidate.status) && candidate.correctedBy == null;
    });
    const typed = eligible.map((r) => toRow(r as unknown as PrismaRow));
    return filter.component != null
      ? typed.filter((r) => (r.scope as { component?: string }).component === filter.component)
      : typed;
  }
}
