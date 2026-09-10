/**
 * reviewed-partial-pe-total.dto -- Phase 10B-35.
 *
 * Serving shape for one bounded, individually-reviewed R-2 PE total. Every
 * field the mission requires is present: fiscal year, request stage,
 * component, amount/units, source exhibit/page, review status, and an
 * explicit partial-coverage label. This DTO is never assembled from
 * `program_element_year` or any canonical/snapshot table -- it is read
 * verbatim from an active `budget_scoped_fact_review_v1` approval's own
 * persisted `projection`/`limitations`.
 */
export interface ReviewedPartialPeTotalDtoV1 {
  peCode: string;
  peTitle: string;
  component: string;
  fiscalYear: number;
  /** Always 'request' today -- the FY2024 President's Budget request stage. */
  stage: 'request';
  /** Plain-language label, e.g. "FY2024 President's Budget request". */
  stageLabel: string;
  amountMillions: {
    base: string | null;
    oco: string | null;
    total: string;
  };
  units: 'USD millions';
  reviewStatus: 'reviewed_partial';
  /** Machine-checkable coverage class -- never implies complete-family coverage. */
  coverage: 'partial';
  /** Plain-language limitation strings, always including the partial-coverage
   * caveat, carried verbatim from the approval's own persisted record. */
  limitations: string[];
  source: {
    sourceDocumentId: string;
    sourceSha256: string;
    sourceUrl: string | null;
    exhibit: 'R-2';
    documentType: string;
    physicalPage: number;
    artifactId: string;
    artifactContentSha256: string;
  };
  review: {
    scopedFactReviewId: string;
    reviewerId: string;
    reviewedAt: string;
    policyId: string;
    policyVersion: string;
    rationale: string;
  };
}
