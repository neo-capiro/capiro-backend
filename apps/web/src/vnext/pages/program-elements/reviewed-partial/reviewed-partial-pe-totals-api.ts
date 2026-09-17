import type { AxiosInstance } from 'axios';

/**
 * Phase 10B-35 -- typed client for the bounded, individually-reviewed R-2 PE
 * totals surface (`GET /api/defense-budget/reviewed-partial-pe-totals`).
 *
 * Local interfaces rather than an import from a shared contracts package,
 * matching the convention `defense-budget-lifecycle-api.ts` already uses.
 * Every row here is explicitly a partial-coverage, single-source reviewed
 * fact -- never a complete-family total, never summed with anything else.
 */
const BASE = '/api/defense-budget/reviewed-partial-pe-totals';

export interface ReviewedPartialPeTotal {
  peCode: string;
  peTitle: string;
  component: string;
  fiscalYear: number;
  stage: 'request';
  stageLabel: string;
  amountMillions: { base: string | null; oco: string | null; total: string };
  units: 'USD millions';
  reviewStatus: 'reviewed_partial';
  coverage: 'partial';
  limitations: readonly string[];
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

export interface ReviewedPartialPeTotalsResponse {
  fiscalYear: number;
  component?: string;
  coverage: 'partial';
  coverageNote: string;
  count: number;
  items: readonly ReviewedPartialPeTotal[];
}

export async function listReviewedPartialPeTotals(
  api: AxiosInstance,
  fiscalYear: number,
  component?: string,
): Promise<ReviewedPartialPeTotalsResponse> {
  return (
    await api.get<ReviewedPartialPeTotalsResponse>(BASE, {
      params: { fiscalYear, ...(component ? { component } : {}) },
    })
  ).data;
}
