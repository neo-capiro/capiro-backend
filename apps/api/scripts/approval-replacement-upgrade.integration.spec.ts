import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { reconcileCommittedApprovalsV1 } from './replace-defense-budget-candidate-approvals-v1.js';
import { CandidateCorrectionV1Service } from '../src/defense-budget/governed-acceptance/candidate-correction/candidate-correction-v1.service.js';
import { PrismaCandidateCorrectionRepositoryV1 } from '../src/defense-budget/governed-acceptance/candidate-correction/candidate-correction-repository-v1.js';
import {
  PrismaScopedFactReviewRepositoryV1,
  type ScopedFactReviewReconciliationExpectationV1,
} from '../src/defense-budget/governed-acceptance/scoped-fact-review/scoped-fact-review-repository-v1.js';
import { PrismaReviewedPartialPeTotalsRepositoryV1 } from '../src/defense-budget/governed-acceptance/scoped-fact-review/reviewed-partial-pe-totals-prisma-repository-v1.js';
import { createPrismaBudgetVerificationRepository } from '../src/defense-budget/verification/persistence/prisma-budget-verification.repository.js';

const describeUpgrade = process.env.APPROVAL_REPLACEMENT_UPGRADE_REHEARSAL === '1' ? describe : describe.skip;

const LEGACY_REVIEW_ID = '11111111-1111-4111-8111-111111111111';
const CANDIDATE_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const SOURCE_ID = '44444444-4444-4444-8444-444444444444';
const SCOPE_KEY = 'rdte_r2_pe_total_request_fy:ARMY:0601102A:2024:request';
const LEGACY_REVOKED_REVIEW_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LEGACY_CORRECTION_ID = '55555555-5555-4555-8555-555555555555';
const LEGACY_CORRECTION_OLD_ID = '66666666-6666-4666-8666-666666666666';
const LEGACY_CORRECTION_NEW_ID = '77777777-7777-4777-8777-777777777777';

describeUpgrade('Package C upgrade path from a real pre-migration scoped review', () => {
  const prisma = new PrismaClient();
  const reviews = new PrismaScopedFactReviewRepositoryV1(prisma as never);

  beforeAll(async () => prisma.$connect());
  afterAll(async () => prisma.$disconnect());

  it('grandfathers the immutable legacy null ack/seal, serves it, and reconciles its exact hash-v1 identity', async () => {
    const legacy = await reviews.readById(LEGACY_REVIEW_ID);
    expect(legacy).toMatchObject({
      id: LEGACY_REVIEW_ID,
      candidateId: CANDIDATE_ID,
      runId: RUN_ID,
      status: 'active',
      acknowledgedRevokedReviewId: null,
      eligibilityStateVersion: null,
      eligibilityStateSha256: null,
      decisionHash: '3b83a9e30e4f154579fdd9a79000ce1d6a458218373438266b29a30365393971',
      reviewGeneration: expect.any(String),
    });

    const serving = new PrismaReviewedPartialPeTotalsRepositoryV1(prisma);
    const served = await serving.listActiveApprovedByScopeKind('rdte_r2_pe_total_request_fy', {
      fiscalYear: 2024,
      component: 'ARMY',
    });
    expect(served.map((row) => row.id)).toContain(LEGACY_REVIEW_ID);

    const scope = {
      scopeKind: 'rdte_r2_pe_total_request_fy' as const,
      peCode: '0601102A',
      fiscalYear: 2024,
      fundingField: 'request' as const,
      component: 'ARMY',
    };
    const expectation: ScopedFactReviewReconciliationExpectationV1 = {
      reviewId: LEGACY_REVIEW_ID,
      candidateId: CANDIDATE_ID,
      runId: RUN_ID,
      sourceDocumentId: SOURCE_ID,
      sourceSha256: 'a'.repeat(64),
      extractionArtifactId: 'legacy-artifact',
      extractionArtifactSha256: 'b'.repeat(64),
      manifestContentSha256: 'c'.repeat(64),
      scopeKind: scope.scopeKind,
      scopeKey: SCOPE_KEY,
      scope,
      policyId: 'rdte_r2_pe_total_review_policy_v1',
      policyVersion: '1',
      policySha256: 'd'.repeat(64),
      reviewerId: 'legacy-reviewer@example.com',
      rationale: 'legacy upgrade rationale',
      decisionHash: '3b83a9e30e4f154579fdd9a79000ce1d6a458218373438266b29a30365393971',
      eligibilityStateVersion: null,
      eligibilityStateSha256: null,
      acknowledgedRevokedReviewId: null,
      assertionIds: ['assertion-a'],
      evidenceIds: ['evidence-a'],
      expectedTotalMillions: '10.50',
      expectedPhysicalPage: 101,
    };
    await expect(reconcileCommittedApprovalsV1(reviews, [expectation])).resolves.toEqual({
      observedAt: expect.any(String),
      conflicts: [],
    });
  });

  it('preserves a pre-Package-C correction as readable NULL intent and refuses an unprovable same-pair replay', async () => {
    const corrections = new PrismaCandidateCorrectionRepositoryV1(prisma as never);
    const legacy = await corrections.readByOldCandidateId(LEGACY_CORRECTION_OLD_ID);
    expect(legacy).toMatchObject({
      id: LEGACY_CORRECTION_ID,
      oldCandidateId: LEGACY_CORRECTION_OLD_ID,
      newCandidateId: LEGACY_CORRECTION_NEW_ID,
      reviewedIntentVersion: null,
      reviewedIntent: null,
      reviewedIntentSha256: null,
    });

    const service = new CandidateCorrectionV1Service(
      createPrismaBudgetVerificationRepository(prisma),
      corrections,
    );
    await expect(service.correct({
      oldCandidateId: LEGACY_CORRECTION_OLD_ID,
      newCandidateId: LEGACY_CORRECTION_NEW_ID,
      actor: 'upgrade-rehearsal',
      reason: 'same pair cannot be replayed without the original reviewed intent',
      selectedScopes: [],
    }, { commit: true })).rejects.toMatchObject({ code: 'correction_intent_mismatch' });

    await expect(corrections.readByOldCandidateId(LEGACY_CORRECTION_OLD_ID)).resolves.toEqual(legacy);
  });

  it('backfills immutable generations for active and revoked legacy rows and seals their run against late evidence', async () => {
    const [active, revoked] = await Promise.all([
      reviews.readById(LEGACY_REVIEW_ID),
      reviews.readById(LEGACY_REVOKED_REVIEW_ID),
    ]);
    expect(active).toMatchObject({ status: 'active', eligibilityStateVersion: null });
    expect(revoked).toMatchObject({
      status: 'revoked',
      revokedAt: '2099-01-01T00:00:00.000Z',
      eligibilityStateVersion: null,
    });
    expect(BigInt(active!.reviewGeneration)).toBeGreaterThan(0n);
    expect(BigInt(revoked!.reviewGeneration)).toBeGreaterThan(BigInt(active!.reviewGeneration));

    await expect(prisma.budgetVerificationCheckV1.create({
      data: {
        runId: RUN_ID,
        checkId: 'legacy-late-check',
        code: 'legacy_late_check',
        ruleVersion: '1',
        outcome: 'PASS',
        required: false,
        blocking: false,
        riskPoints: 0,
        message: 'must be refused because legacy review history already seals this run',
        assertionIds: [],
        evidenceIds: [],
        referenceArtifactIds: [],
        details: {},
        passed: true,
      },
    })).rejects.toThrow('[budget_verification_evidence_sealed]');
  });

  it('keeps the migrated legacy decision revocable without rewriting its null audit fields', async () => {
    const before = await reviews.readById(LEGACY_REVIEW_ID);
    const revoked = await reviews.revoke({
      id: LEGACY_REVIEW_ID,
      actor: 'upgrade-rehearsal',
      reason: 'prove legacy active rows retain the supported revocation path',
      now: '2026-09-19T12:00:00.000Z',
    });
    expect(revoked).toMatchObject({
      status: 'revoked',
      acknowledgedRevokedReviewId: null,
      eligibilityStateVersion: null,
      eligibilityStateSha256: null,
      reviewGeneration: before!.reviewGeneration,
    });
  });
});
