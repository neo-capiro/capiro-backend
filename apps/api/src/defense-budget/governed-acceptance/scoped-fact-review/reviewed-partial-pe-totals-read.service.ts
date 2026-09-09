/**
 * reviewed-partial-pe-totals-read.service -- Phase 10B-35.
 *
 * Serves the bounded "reviewed partial R-2 PE totals" product surface. Reads
 * ONLY `budget_scoped_fact_review_v1` rows with `status='active' AND
 * decision='approve'` for the `rdte_r2_pe_total_request_fy` scope kind.
 *
 * Deliberately does NOT read `program_element_year`, any
 * `DefenseBudgetCanonicalRow`/snapshot table, or the legacy PE finder tables
 * -- this is a separate, narrower publication class from the complete-family
 * canonical pipeline (see this file's header in the implementation map: the
 * whole-collection completeness gate for `program_element_year`/canonical
 * rows is untouched by this surface). Every row is stamped
 * `reviewStatus:'reviewed_partial'`/`coverage:'partial'` and carries its own
 * limitations -- callers must never merge these into a complete-family
 * total, ranking, or delta.
 */
import type { ReviewedPartialPeTotalDtoV1 } from './reviewed-partial-pe-total.dto.js';
import { SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1, type ScopedFactReviewProjectionV1 } from './scoped-fact-review-policy-v1.js';
import type { ScopedFactReviewRepositoryV1, ScopedFactReviewRowV1 } from './scoped-fact-review-repository-v1.js';

export interface ReviewedPartialPeTotalsQueryV1 {
  fiscalYear: number;
  component?: string;
}

function toDto(row: ScopedFactReviewRowV1): ReviewedPartialPeTotalDtoV1 {
  const projection = row.projection as ScopedFactReviewProjectionV1;
  return {
    peCode: projection.peCode,
    peTitle: projection.peTitle,
    component: projection.component,
    fiscalYear: projection.fiscalYear,
    stage: 'request',
    stageLabel: projection.stageLabel,
    amountMillions: { base: projection.baseMillions, oco: projection.ocoMillions, total: projection.totalMillions },
    units: 'USD millions',
    reviewStatus: 'reviewed_partial',
    coverage: 'partial',
    limitations: row.limitations,
    source: {
      sourceDocumentId: projection.source.sourceDocumentId,
      sourceSha256: projection.source.sourceSha256,
      sourceUrl: projection.source.sourceUrl,
      exhibit: 'R-2',
      documentType: projection.source.documentType,
      physicalPage: projection.source.physicalPage,
      artifactId: projection.source.artifactId,
      artifactContentSha256: projection.source.artifactContentSha256,
    },
    review: {
      scopedFactReviewId: row.id,
      reviewerId: row.reviewerId,
      reviewedAt: row.createdAt,
      policyId: row.policyId,
      policyVersion: row.policyVersion,
      rationale: row.rationale,
    },
  };
}

/** Repository surface this read service actually needs -- listing every
 * active-approved scope key requires the underlying store to expose an
 * "active, by scope-kind prefix" query; `ScopedFactReviewRepositoryV1` as
 * defined only supports lookup by exact scope key or by candidate, so the
 * Prisma-backed implementation below adds the one additional read query. */
export interface ReviewedPartialPeTotalsRepositoryV1 {
  listActiveApprovedByScopeKind(scopeKind: string, filter: ReviewedPartialPeTotalsQueryV1): Promise<ScopedFactReviewRowV1[]>;
}

export class ReviewedPartialPeTotalsReadServiceV1 {
  constructor(private readonly repository: ReviewedPartialPeTotalsRepositoryV1) {}

  async listReviewedPartialPeTotals(query: ReviewedPartialPeTotalsQueryV1): Promise<ReviewedPartialPeTotalDtoV1[]> {
    const rows = await this.repository.listActiveApprovedByScopeKind(SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1, query);
    return rows
      .map(toDto)
      .sort((a, b) => a.peCode.localeCompare(b.peCode));
  }
}
