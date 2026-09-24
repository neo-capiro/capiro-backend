import { describe, expect, it } from '@jest/globals';
import {
  buildScopedFactPublicationPlanV1,
  type ScopedFactPublicationCandidateV1,
  type ScopedFactPublicationReviewV1,
} from './scoped-fact-publication-plan-v1.js';
import type { ScopedFactReviewProjectionV1 } from './scoped-fact-review-policy-v1.js';

function candidate(id = 'c1'): ScopedFactPublicationCandidateV1 {
  return {
    id,
    currentRunId: 'run1',
    status: 'NEEDS_REVIEW',
    sourceDocumentId: 'doc1',
    sourceSha256: 'a'.repeat(64),
    extractionArtifactId: 'artifact1',
    extractionArtifactSha256: 'b'.repeat(64),
    manifestContentSha256: 'c'.repeat(64),
  };
}
function projection(): ScopedFactReviewProjectionV1 {
  return {
    peCode: '0601102A',
    peTitle: 'Defense Research Sciences',
    component: 'ARMY',
    fiscalYear: 2024,
    stage: 'request',
    stageLabel: "FY2024 President's Budget request",
    positionCycle: 'pb_fy2024',
    baseMillions: '43.075',
    ocoMillions: null,
    totalMillions: '43.075',
    units: 'USD millions',
    source: {
      sourceDocumentId: 'doc1',
      sourceSha256: 'a'.repeat(64),
      sourceUrl: null,
      documentType: 'r2',
      exhibit: 'R-2',
      physicalPage: 61,
      artifactId: 'artifact1',
      artifactContentSha256: 'b'.repeat(64),
      identityAssertionId: 'i1',
      totalAssertionId: 't1',
      baseAssertionId: 'b1',
      ocoAssertionId: null,
      evidenceIds: ['e1'],
      sourceFactPaths: ['facts.total'],
      evidenceGranularity: ['table_row'],
    },
  };
}
function review(
  id = 'r1',
  overrides: Partial<ScopedFactPublicationReviewV1> = {},
): ScopedFactPublicationReviewV1 {
  return {
    id,
    candidateId: 'c1',
    runId: 'run1',
    sourceDocumentId: 'doc1',
    sourceSha256: 'a'.repeat(64),
    extractionArtifactId: 'artifact1',
    extractionArtifactSha256: 'b'.repeat(64),
    manifestContentSha256: 'c'.repeat(64),
    scopeKind: 'rdte_r2_pe_total_request_fy',
    scopeKey: 'ARMY|0601102A|FY2024|request',
    decision: 'approve',
    status: 'active',
    supersededById: null,
    projection: projection(),
    limitations: ['one-page review'],
    reviewerId: 'reviewer',
    createdAt: '2026-09-01T00:00:00.000Z',
    policyId: 'policy',
    policyVersion: '1.0.0',
    rationale: 'verified total',
    ...overrides,
  };
}
function plan(
  reviews: ScopedFactPublicationReviewV1[],
  candidates = [candidate()],
  pointer: string | null = 'snapshot-1',
) {
  return buildScopedFactPublicationPlanV1({
    cohortId: 'cohort-1',
    expectedActiveSnapshotId: pointer,
    candidates,
    reviews,
  });
}

describe('buildScopedFactPublicationPlanV1', () => {
  it('emits only active approvals and labels their exact rows as partial', () => {
    const result = plan([
      review(),
      review('revoked', { status: 'revoked' }),
      review('rejected', { decision: 'reject' }),
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      peCode: '0601102A',
      amountMillions: { total: '43.075' },
      reviewStatus: 'reviewed_partial',
      coverage: 'partial',
    });
    expect(result.rows[0]!.limitations).toContain(
      'Coverage is partial; this row does not assert complete-family coverage.',
    );
  });
  it('excludes a superseded review and candidate', () => {
    expect(plan([review('old', { supersededById: 'new' })]).exclusions).toEqual([
      { reviewId: 'old', reason: 'candidate_superseded' },
    ]);
    expect(plan([review()], [{ ...candidate(), superseded: true }]).exclusions[0]).toEqual({
      reviewId: 'r1',
      reason: 'candidate_superseded',
    });
  });
  it('excludes a binding mismatch and a stale candidate run', () => {
    const mismatch = plan([review()], [{ ...candidate(), sourceSha256: 'd'.repeat(64) }]);
    expect(mismatch.exclusions).toEqual([{ reviewId: 'r1', reason: 'candidate_binding_mismatch' }]);
    const stale = plan([review()], [{ ...candidate(), currentRunId: 'run2' }]);
    expect(stale.exclusions).toEqual([{ reviewId: 'r1', reason: 'stale_candidate_run' }]);
  });
  it('fails closed when the persisted scope key does not match the reviewed projection', () => {
    const mismatched = plan([review('r1', { scopeKey: 'ARMY|0609999A|FY2024|request' })]);
    expect(mismatched.rows).toEqual([]);
    expect(mismatched.exclusions).toEqual([
      { reviewId: 'r1', reason: 'projection_binding_mismatch' },
    ]);
  });
  it('orders rows and produces a deterministic identity independent of input order', () => {
    const other = review('r2', {
      scopeKey: 'ARMY|0601103A|FY2024|request',
      projection: { ...projection(), peCode: '0601103A' },
    });
    const a = plan([other, review()]);
    const b = plan([review(), other]);
    expect(a.rows.map((r) => r.peCode)).toEqual(['0601102A', '0601103A']);
    expect(a.planHash).toBe(b.planHash);
    expect(a.planId).toBe(b.planId);
  });
  it('binds plan identity to the expected active snapshot pointer', () => {
    expect(plan([review()], [candidate()], 'snapshot-1').planHash).not.toBe(
      plan([review()], [candidate()], 'snapshot-2').planHash,
    );
  });
});
