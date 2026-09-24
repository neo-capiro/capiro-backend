import { describe, expect, it } from '@jest/globals';

import {
  completeInterruptedLedgerV1,
  findRevokedHistoryForScopeV1,
  reconcileCommittedApprovalsV1,
} from './replace-defense-budget-candidate-approvals-v1.js';
import type {
  ManifestEntryV1,
  ReplacementLedgerRowV1,
} from './replace-defense-budget-candidate-approvals-v1.js';
import type {
  ScopedFactReviewReconciliationExpectationV1,
  ScopedFactReviewReconciliationObservationV1,
  ScopedFactReviewRepositoryV1,
  ScopedFactReviewRowV1,
} from '../src/defense-budget/governed-acceptance/scoped-fact-review/scoped-fact-review-repository-v1.js';
import {
  SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1,
  scopedFactReviewScopeKeyV1,
} from '../src/defense-budget/governed-acceptance/scoped-fact-review/scoped-fact-review-policy-v1.js';

const scope = {
  scopeKind: 'rdte_r2_pe_total_request_fy' as const,
  peCode: '0601102A',
  fiscalYear: 2024,
  fundingField: 'request' as const,
  component: 'ARMY',
};

function expected(
  overrides: Partial<ScopedFactReviewReconciliationExpectationV1> = {},
): ScopedFactReviewReconciliationExpectationV1 {
  return {
    reviewId: '11111111-1111-4111-8111-111111111111',
    candidateId: '22222222-2222-4222-8222-222222222222',
    runId: '33333333-3333-4333-8333-333333333333',
    sourceDocumentId: '44444444-4444-4444-8444-444444444444',
    sourceSha256: 'a'.repeat(64),
    extractionArtifactId: 'artifact-1',
    extractionArtifactSha256: 'b'.repeat(64),
    manifestContentSha256: 'c'.repeat(64),
    scopeKind: scope.scopeKind,
    scopeKey: 'rdte_r2_pe_total_request_fy:ARMY:0601102A:2024:request',
    scope,
    policyId: 'rdte_r2_pe_total_review_policy_v1',
    policyVersion: '1',
    policySha256: 'd'.repeat(64),
    reviewerId: 'operator-reviewed@example.com',
    rationale: 'operator-reviewed rationale',
    decisionHash: 'e'.repeat(64),
    eligibilityStateVersion: null,
    eligibilityStateSha256: null,
    acknowledgedRevokedReviewId: null,
    assertionIds: ['assertion-a', 'assertion-b'],
    evidenceIds: ['evidence-a'],
    expectedTotalMillions: '10.50',
    expectedPhysicalPage: 101,
    ...overrides,
  };
}

function observed(
  expectation: ScopedFactReviewReconciliationExpectationV1,
  overrides: Partial<ScopedFactReviewReconciliationObservationV1> = {},
): ScopedFactReviewReconciliationObservationV1 {
  return {
    reviewId: expectation.reviewId,
    actualId: expectation.reviewId,
    candidateId: expectation.candidateId,
    runId: expectation.runId,
    sourceDocumentId: expectation.sourceDocumentId,
    sourceSha256: expectation.sourceSha256,
    extractionArtifactId: expectation.extractionArtifactId,
    extractionArtifactSha256: expectation.extractionArtifactSha256,
    manifestContentSha256: expectation.manifestContentSha256,
    scopeKind: expectation.scopeKind,
    scopeKey: expectation.scopeKey,
    scope: expectation.scope,
    policyId: expectation.policyId,
    policyVersion: expectation.policyVersion,
    policySha256: expectation.policySha256,
    reviewerId: expectation.reviewerId,
    rationale: expectation.rationale,
    decisionHash: expectation.decisionHash,
    eligibilityStateVersion: expectation.eligibilityStateVersion,
    eligibilityStateSha256: expectation.eligibilityStateSha256,
    decision: 'approve',
    status: 'active',
    assertionIds: [...expectation.assertionIds],
    evidenceIds: [...expectation.evidenceIds],
    projection: {
      peCode: scope.peCode,
      fiscalYear: scope.fiscalYear,
      fundingField: scope.fundingField,
      totalMillions: '10.5',
      component: scope.component,
      source: { physicalPage: expectation.expectedPhysicalPage },
    },
    candidateCurrentRunId: expectation.runId,
    candidateStatus: 'NEEDS_REVIEW',
    candidateSourceDocumentId: expectation.sourceDocumentId,
    candidateSourceSha256: expectation.sourceSha256,
    candidateExtractionArtifactId: expectation.extractionArtifactId,
    candidateExtractionArtifactSha256: expectation.extractionArtifactSha256,
    candidateManifestContentSha256: expectation.manifestContentSha256,
    correctionLinkId: null,
    acknowledgedRevokedReviewId: expectation.acknowledgedRevokedReviewId,
    ...overrides,
  } as ScopedFactReviewReconciliationObservationV1;
}

function repository(
  observation: ScopedFactReviewReconciliationObservationV1,
): ScopedFactReviewRepositoryV1 {
  return {
    reconcileActiveApprovals: async () => ({
      observedAt: '2026-09-19T12:00:00.000Z',
      observations: [observation],
    }),
  } as unknown as ScopedFactReviewRepositoryV1;
}

describe('replacement approval one-snapshot reconciliation identity', () => {
  it('completes a post-correction interruption ledger without relabeling confirmed scopes', () => {
    const entry = (peCode: string): ManifestEntryV1 => ({
      peCode,
      fiscalYear: 2024,
      component: 'ARMY',
      rationale: `review ${peCode}`,
      expectedTotalMillions: '10.5',
      expectedPhysicalPage: 101,
      expectedAssertionIds: [`assertion-${peCode}`],
      expectedEvidenceIds: [`evidence-${peCode}`],
    });
    const entries = [entry('0601102A'), entry('0601103A')];
    const scopeKey = (peCode: string): string =>
      scopedFactReviewScopeKeyV1({
        scopeKind: SCOPED_FACT_REVIEW_SCOPE_KIND_PE_TOTAL_V1,
        peCode,
        fiscalYear: 2024,
        fundingField: 'request',
        component: 'ARMY',
      });
    const confirmedScopeKey = scopeKey('0601102A');
    const ledger: ReplacementLedgerRowV1[] = [
      {
        scopeKey: confirmedScopeKey,
        outcome: 'APPROVED',
        detail: 'review confirmed before interruption',
      },
    ];

    completeInterruptedLedgerV1(entries, ledger, 'RUNTIME_INTERRUPTION_UNCONFIRMED');

    expect(ledger).toEqual([
      {
        scopeKey: confirmedScopeKey,
        outcome: 'APPROVED',
        detail: 'review confirmed before interruption',
      },
      {
        scopeKey: scopeKey('0601103A'),
        outcome: 'FAILED',
        detail: 'RUNTIME_INTERRUPTION_UNCONFIRMED',
      },
    ]);
  });

  it('chooses the latest database generation despite adversarial revokedAt clock skew', async () => {
    const generationOne = {
      id: '11111111-1111-4111-8111-111111111111',
      scopeKey: expected().scopeKey,
      status: 'revoked',
      reviewGeneration: '1',
      createdAt: '2026-09-19T12:00:00.000Z',
      revokedAt: '2099-01-01T00:00:00.000Z',
    } as unknown as ScopedFactReviewRowV1;
    const generationTwo = {
      id: '22222222-2222-4222-8222-222222222222',
      scopeKey: expected().scopeKey,
      status: 'revoked',
      reviewGeneration: '2',
      createdAt: '2026-09-19T12:01:00.000Z',
      revokedAt: '2000-01-01T00:00:00.000Z',
    } as unknown as ScopedFactReviewRowV1;
    const historyRepository = {
      listByCandidate: async () => [generationOne, generationTwo],
    } as unknown as ScopedFactReviewRepositoryV1;

    await expect(
      findRevokedHistoryForScopeV1(historyRepository, expected().candidateId, expected().scopeKey),
    ).resolves.toBe(generationTwo);
  });

  it('accepts a migrated legacy ALREADY_APPROVED row with null ack/seal and its exact hash-v1 identity', async () => {
    const wanted = expected();
    await expect(
      reconcileCommittedApprovalsV1(repository(observed(wanted)), [wanted]),
    ).resolves.toEqual({
      observedAt: '2026-09-19T12:00:00.000Z',
      conflicts: [],
    });
  });

  const mismatchCases: Array<[string, Partial<ScopedFactReviewReconciliationObservationV1>]> = [
    ['reviewerId', { reviewerId: 'different-reviewer@example.com' }],
    ['candidateStatus', { candidateStatus: 'REJECTED' }],
    [
      'candidateSourceDocumentId',
      { candidateSourceDocumentId: '55555555-5555-4555-8555-555555555555' },
    ],
    ['candidateSourceSha256', { candidateSourceSha256: '9'.repeat(64) }],
    ['candidateExtractionArtifactId', { candidateExtractionArtifactId: 'different-artifact' }],
    ['candidateExtractionArtifactSha256', { candidateExtractionArtifactSha256: '8'.repeat(64) }],
    ['candidateManifestContentSha256', { candidateManifestContentSha256: '7'.repeat(64) }],
    ['scopeCanonicalHash', { scope: { ...scope, peCode: 'DIFFERENT' } }],
    ['policyVersion', { policyVersion: '2' }],
    ['rationale', { rationale: 'different rationale' }],
    ['decisionHash', { decisionHash: 'f'.repeat(64) }],
    [
      'acknowledgedRevokedReviewId',
      { acknowledgedRevokedReviewId: '55555555-5555-4555-8555-555555555555' },
    ],
    [
      'eligibilityStateSha256',
      {
        eligibilityStateVersion: 'scoped_fact_review_eligibility_state_v1',
        eligibilityStateSha256: '9'.repeat(64),
      },
    ],
  ];
  it.each(mismatchCases)(
    'names a %s mismatch instead of counting an unrelated active row complete',
    async (field, override) => {
      const wanted = expected();
      const result = await reconcileCommittedApprovalsV1(repository(observed(wanted, override)), [
        wanted,
      ]);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0]!.detail).toContain(field);
    },
  );

  it('binds a new reapproval to the exact non-null revocation acknowledgement and eligibility seal', async () => {
    const wanted = expected({
      acknowledgedRevokedReviewId: '55555555-5555-4555-8555-555555555555',
      eligibilityStateVersion: 'scoped_fact_review_eligibility_state_v1',
      eligibilityStateSha256: '8'.repeat(64),
    });
    const result = await reconcileCommittedApprovalsV1(repository(observed(wanted)), [wanted]);
    expect(result.conflicts).toEqual([]);
  });
});
