import {
  DefenseBudgetPromotionAuthorizationServiceV1,
  type PromotionAuthorizationRepositoryV1,
  type StoredPromotionPlanV1,
} from './promotion-authorization-service-v1.js';
import {
  DEFENSE_BUDGET_PROMOTION_ELIGIBILITY_SCHEMA_VERSION,
  defenseBudgetPromotionEligibilityV1Schema,
  promotionEligibilityHashV1,
} from './promotion-eligibility-v1.js';
import type { PromotionAuditSinkV1 } from './promotion-eligibility-service-v1.js';

const SHA = (c: string) => c.repeat(64);

function blockedEligibility() {
  return defenseBudgetPromotionEligibilityV1Schema.parse({
    schemaVersion: DEFENSE_BUDGET_PROMOTION_ELIGIBILITY_SCHEMA_VERSION,
    eligibilityId: 'eligibility-blocked-1',
    cycleId: 'fy2027-cycle',
    scope: { cycleId: 'fy2027-cycle', fiscalYear: 2027, families: ['om'], stages: [] },
    projectionPlanIds: ['projection-plan-1'],
    projectionPlanHashes: [SHA('1')],
    mappingRegistryVersion: 'canonical_mapping_registry_v1',
    mappingRegistryHash: SHA('2'),
    candidates: [
      {
        candidateId: 'candidate-1',
        status: 'VERIFICATION_PASSED',
        terminalVerificationRunId: 'run-1',
        family: 'om',
        extractionMethod: 'deterministic_pdfplumber',
        sourceProfileSha256: null,
        acceptedAssertionIds: ['assertion-1'],
        artifactSha256: SHA('3'),
        sourceSha256: SHA('4'),
      },
    ],
    sourceDocumentHashes: [SHA('4')],
    artifactHashes: [SHA('3')],
    manifestHash: SHA('5'),
    sourceProfileHashes: [],
    verificationPolicyHashes: [SHA('6')],
    cycleCertificationIds: ['certification-1'],
    cycleCertificationHashes: [SHA('7')],
    expectedActiveSnapshotId: null,
    expectedActiveSnapshotHash: null,
    openConflictCount: 1,
    unsupportedItemCount: 0,
    generatedAt: '2026-08-09T00:00:00.000Z',
  });
}

describe('promotion authorization re-evaluates persisted eligibility policy', () => {
  it('refuses a hand-filed clean plan that points at a genuinely blocked eligibility record', async () => {
    const eligibility = blockedEligibility();
    const plan: StoredPromotionPlanV1 = {
      planId: 'plan-1',
      planHash: SHA('8'),
      eligibilityHash: promotionEligibilityHashV1(eligibility),
      blockedCount: 0,
      expectedActiveSnapshotId: null,
      eligibility,
    };

    const inserted: unknown[] = [];
    const repository: PromotionAuthorizationRepositoryV1 = {
      loadPlan: async () => plan,
      findAuthorizationById: async () => null,
      insertAuthorization: async (record) => {
        inserted.push(record);
      },
    };
    const audits: unknown[] = [];
    const audit: PromotionAuditSinkV1 = {
      record: async (record) => {
        audits.push(record);
      },
    };
    const service = new DefenseBudgetPromotionAuthorizationServiceV1(repository, audit, {
      now: () => new Date('2026-08-09T00:00:00.000Z'),
    });

    const result = await service.issue({
      planId: 'plan-1',
      reason: 'attempt to authorize hand-filed plan',
      expiresAt: '2026-08-10T00:00:00.000Z',
      authorizerActorId: 'admin-1',
      authorizerRoles: ['capiro_admin'],
      authorizationId: 'authorization-1',
    });

    expect(result.issued).toBe(false);
    expect(result.refusals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'eligibility_not_eligible' }),
      ]),
    );
    expect(inserted).toEqual([]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ outcome: 'REFUSED' });
  });
});
