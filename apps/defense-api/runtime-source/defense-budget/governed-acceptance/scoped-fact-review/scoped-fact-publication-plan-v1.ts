/**
 * Deterministic, side-effect-free publication plan for explicitly reviewed
 * PE totals. Building this value never writes canonical rows or activates a
 * snapshot. Every emitted row remains labelled reviewed_partial/partial.
 */
import { sha256CanonicalJson, type JsonValue } from '../../contracts/canonical-json.js';
import {
  SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1,
  type ScopedFactReviewProjectionV1,
} from './scoped-fact-review-policy-v1.js';

export const SCOPED_FACT_PUBLICATION_PLAN_SCHEMA_V1 = 'scoped_fact_publication_plan_v1' as const;
export const SCOPED_FACT_PUBLICATION_PROJECTION_VERSION_V1 =
  'reviewed_partial_pe_total_v1' as const;

export interface ScopedFactPublicationCandidateV1 {
  id: string;
  currentRunId: string | null;
  status: string;
  sourceDocumentId: string;
  sourceSha256: string;
  extractionArtifactId: string;
  extractionArtifactSha256: string;
  manifestContentSha256: string;
  superseded?: boolean;
}

export interface ScopedFactPublicationReviewV1 {
  id: string;
  candidateId: string;
  runId: string;
  sourceDocumentId: string;
  sourceSha256: string;
  extractionArtifactId: string;
  extractionArtifactSha256: string;
  manifestContentSha256: string;
  scopeKind: string;
  scopeKey: string;
  decision: string;
  status: string;
  supersededById: string | null;
  projection: ScopedFactReviewProjectionV1 | null;
  limitations: string[];
  reviewerId: string;
  createdAt: string;
  policyId: string;
  policyVersion: string;
  rationale: string;
}

export interface ScopedFactPublicationPlanInputV1 {
  cohortId: string;
  expectedActiveSnapshotId: string | null;
  candidates: readonly ScopedFactPublicationCandidateV1[];
  reviews: readonly ScopedFactPublicationReviewV1[];
}

export interface ScopedFactPublicationRowV1 {
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

export interface ScopedFactPublicationExclusionV1 {
  reviewId: string;
  reason: string;
}
export interface ScopedFactPublicationPlanV1 {
  schemaVersion: typeof SCOPED_FACT_PUBLICATION_PLAN_SCHEMA_V1;
  projectionVersion: typeof SCOPED_FACT_PUBLICATION_PROJECTION_VERSION_V1;
  cohortId: string;
  expectedActiveSnapshotId: string | null;
  planId: string;
  planHash: string;
  rows: ScopedFactPublicationRowV1[];
  exclusions: ScopedFactPublicationExclusionV1[];
}

function makeRow(
  review: ScopedFactPublicationReviewV1,
  projection: ScopedFactReviewProjectionV1,
): ScopedFactPublicationRowV1 {
  return {
    peCode: projection.peCode,
    peTitle: projection.peTitle,
    component: projection.component,
    fiscalYear: projection.fiscalYear,
    stage: 'request',
    stageLabel: projection.stageLabel,
    amountMillions: {
      base: projection.baseMillions,
      oco: projection.ocoMillions,
      total: projection.totalMillions,
    },
    units: 'USD millions',
    reviewStatus: 'reviewed_partial',
    coverage: 'partial',
    limitations: [
      ...new Set([
        ...review.limitations,
        'Coverage is partial; this row does not assert complete-family coverage.',
      ]),
    ].sort(),
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
      scopedFactReviewId: review.id,
      reviewerId: review.reviewerId,
      reviewedAt: review.createdAt,
      policyId: review.policyId,
      policyVersion: review.policyVersion,
      rationale: review.rationale,
    },
  };
}

/** Build a stable plan from a cohort and the active-snapshot concurrency fence. */
export function buildScopedFactPublicationPlanV1(
  input: ScopedFactPublicationPlanInputV1,
): ScopedFactPublicationPlanV1 {
  const candidateById = new Map(input.candidates.map((c) => [c.id, c]));
  const rows: ScopedFactPublicationRowV1[] = [];
  const exclusions: ScopedFactPublicationExclusionV1[] = [];
  for (const review of input.reviews) {
    if (
      review.status !== 'active' ||
      review.decision !== 'approve' ||
      review.scopeKind !== SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1
    )
      continue;
    const reject = (reason: string) => exclusions.push({ reviewId: review.id, reason });
    const candidate = candidateById.get(review.candidateId);
    if (!candidate) {
      reject('candidate_missing');
      continue;
    }
    if (review.supersededById !== null || candidate.superseded) {
      reject('candidate_superseded');
      continue;
    }
    if (candidate.currentRunId !== review.runId) {
      reject('stale_candidate_run');
      continue;
    }
    if (candidate.status !== 'NEEDS_REVIEW' && candidate.status !== 'REVIEW_ACCEPTED') {
      reject('candidate_not_reviewable');
      continue;
    }
    if (
      candidate.id !== review.candidateId ||
      candidate.sourceDocumentId !== review.sourceDocumentId ||
      candidate.sourceSha256 !== review.sourceSha256 ||
      candidate.extractionArtifactId !== review.extractionArtifactId ||
      candidate.extractionArtifactSha256 !== review.extractionArtifactSha256 ||
      candidate.manifestContentSha256 !== review.manifestContentSha256
    ) {
      reject('candidate_binding_mismatch');
      continue;
    }
    const p = review.projection;
    const expectedScopeKey =
      p == null ? null : `${p.component}|${p.peCode}|FY${p.fiscalYear}|request`;
    if (
      !p ||
      p.stage !== 'request' ||
      p.units !== 'USD millions' ||
      p.source.exhibit !== 'R-2' ||
      review.scopeKey !== expectedScopeKey ||
      p.source.sourceDocumentId !== review.sourceDocumentId ||
      p.source.sourceSha256 !== review.sourceSha256 ||
      p.source.artifactId !== review.extractionArtifactId ||
      p.source.artifactContentSha256 !== review.extractionArtifactSha256
    ) {
      reject('projection_binding_mismatch');
      continue;
    }
    rows.push(makeRow(review, p));
  }
  const sort = (a: ScopedFactPublicationRowV1, b: ScopedFactPublicationRowV1) =>
    a.component.localeCompare(b.component) ||
    a.fiscalYear - b.fiscalYear ||
    a.peCode.localeCompare(b.peCode) ||
    a.review.scopedFactReviewId.localeCompare(b.review.scopedFactReviewId);
  rows.sort(sort);
  exclusions.sort(
    (a, b) => a.reviewId.localeCompare(b.reviewId) || a.reason.localeCompare(b.reason),
  );
  const identity = {
    schemaVersion: SCOPED_FACT_PUBLICATION_PLAN_SCHEMA_V1,
    projectionVersion: SCOPED_FACT_PUBLICATION_PROJECTION_VERSION_V1,
    cohortId: input.cohortId,
    expectedActiveSnapshotId: input.expectedActiveSnapshotId,
    rows,
    exclusions,
  };
  const planHash = sha256CanonicalJson(identity as unknown as JsonValue);
  return { ...identity, planId: `sfp_${planHash.slice(0, 24)}`, planHash };
}
