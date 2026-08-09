import {
  buildProjectionPlanRecordV1,
  type DefenseBudgetProjectionPlanRecordV1,
} from '../projection-plan/projection-plan-record-v1.js';
import {
  computeNonRdteProjectionPlanContentSha256,
  NON_RDTE_PROJECTION_PLAN_SCHEMA_VERSION,
} from '../non-rdte/non-rdte-canonical-projection-plan-v1.js';
import {
  DEFENSE_BUDGET_PROMOTION_ELIGIBILITY_SCHEMA_VERSION,
  defenseBudgetPromotionEligibilityV1Schema,
  promotionEligibilityHashV1,
  type DefenseBudgetPromotionEligibilityV1,
} from './promotion-eligibility-v1.js';
import { PrismaEligibilityBoundProjectionSourceV1 } from './eligibility-bound-projection-source-prisma-v1.js';

const SHA = (c: string) => c.repeat(64);
const CYCLE = 'fy2027-cycle';

function omPlanRecord(overrides: { cycleId?: string; certificationSha256?: string } = {}) {
  const withoutHash = {
    schemaVersion: NON_RDTE_PROJECTION_PLAN_SCHEMA_VERSION,
    cycleId: overrides.cycleId ?? CYCLE,
    cycleBundleContentSha256: SHA('1'),
    cycleCertification: 'CERTIFIED_NON_RDTE_READY_FOR_PROJECTION' as const,
    fiscalYear: 2027,
    family: 'om' as const,
    positionCycle: 'pb_fy2027',
    candidates: [],
    exclusions: [],
    diffSummary: [],
    diffedAgainstCanonicalRows: false,
  };
  const document = {
    ...withoutHash,
    contentSha256: computeNonRdteProjectionPlanContentSha256(withoutHash),
  };
  return buildProjectionPlanRecordV1({
    family: 'om',
    producerVersion: 'unit-test@1',
    certificationId: null,
    certificationSha256: overrides.certificationSha256 ?? SHA('2'),
    planDocument: document,
  });
}

function eligibility(
  record: DefenseBudgetProjectionPlanRecordV1,
  overrides: Partial<DefenseBudgetPromotionEligibilityV1> = {},
): DefenseBudgetPromotionEligibilityV1 {
  return defenseBudgetPromotionEligibilityV1Schema.parse({
    schemaVersion: DEFENSE_BUDGET_PROMOTION_ELIGIBILITY_SCHEMA_VERSION,
    eligibilityId: 'eligibility-1',
    cycleId: CYCLE,
    scope: { cycleId: CYCLE, fiscalYear: 2027, families: ['om'], stages: [] },
    projectionPlanIds: [record.projectionPlanId],
    projectionPlanHashes: [record.contentSha256],
    mappingRegistryVersion: 'canonical_mapping_registry_v1',
    mappingRegistryHash: SHA('3'),
    candidates: [
      {
        candidateId: 'candidate-1',
        status: 'VERIFICATION_PASSED',
        terminalVerificationRunId: 'run-1',
        family: 'om',
        extractionMethod: 'deterministic_pdfplumber',
        sourceProfileSha256: null,
        acceptedAssertionIds: ['assertion-1'],
        artifactSha256: SHA('4'),
        sourceSha256: SHA('5'),
      },
    ],
    sourceDocumentHashes: [SHA('5')],
    artifactHashes: [SHA('4')],
    manifestHash: SHA('6'),
    sourceProfileHashes: [],
    verificationPolicyHashes: [SHA('7')],
    cycleCertificationIds: ['certification-1'],
    cycleCertificationHashes: [record.certificationSha256],
    expectedActiveSnapshotId: null,
    expectedActiveSnapshotHash: null,
    openConflictCount: 0,
    unsupportedItemCount: 0,
    generatedAt: '2026-08-09T00:00:00.000Z',
    ...overrides,
  });
}

function projectionPlanRow(record: DefenseBudgetProjectionPlanRecordV1) {
  return {
    projectionPlanId: record.projectionPlanId,
    recordSchemaVersion: record.recordSchemaVersion,
    schemaVersion: record.schemaVersion,
    family: record.family,
    cycleId: record.cycleId,
    fiscalYear: record.fiscalYear,
    contentSha256: record.contentSha256,
    producerVersion: record.producerVersion,
    certificationId: record.certificationId,
    certificationSha256: record.certificationSha256,
    artifactSetSha256: record.artifactSetSha256,
    status: record.status,
    conflictCount: record.conflictCount,
    unsupportedCount: record.unsupportedCount,
    planDocument: record.planDocument,
  };
}

class FakePrisma {
  readonly calls: Array<{ query: string; values: unknown[] }> = [];

  constructor(
    private readonly eligibilityDocument: DefenseBudgetPromotionEligibilityV1,
    private readonly rows: Array<ReturnType<typeof projectionPlanRow>>,
  ) {}

  async $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T> {
    this.calls.push({ query, values });
    if (query.includes('defense_budget_promotion_eligibility')) {
      return [{ document: this.eligibilityDocument }] as T;
    }
    if (query.includes('defense_budget_projection_plan')) {
      const requested = new Set(values.map(String));
      return this.rows.filter((row) => requested.has(row.projectionPlanId)) as T;
    }
    throw new Error(`unexpected query in fake: ${query}`);
  }
}

describe('PrismaEligibilityBoundProjectionSourceV1', () => {
  it('loads only the immutable producer plan IDs named by eligibility', async () => {
    const named = omPlanRecord();
    const unrelated = omPlanRecord({ cycleId: 'other-cycle', certificationSha256: SHA('8') });
    const record = eligibility(named);
    const prisma = new FakePrisma(record, [projectionPlanRow(named), projectionPlanRow(unrelated)]);
    const source = new PrismaEligibilityBoundProjectionSourceV1(prisma);

    const loaded = await source.loadForEligibilityHash(promotionEligibilityHashV1(record));

    expect(loaded.projectionPlans.map((plan) => plan.projectionPlanId)).toEqual([
      named.projectionPlanId,
    ]);
    expect(loaded.projections).toEqual([]);
    expect(loaded.refusals).toEqual([]);
    const planQuery = prisma.calls.find((call) =>
      call.query.includes('defense_budget_projection_plan'),
    );
    expect(planQuery?.values).toEqual([named.projectionPlanId]);
  });

  it('refuses a producer-plan row whose denormalized hash no longer agrees with its document', async () => {
    const named = omPlanRecord();
    const record = eligibility(named);
    const tampered = { ...projectionPlanRow(named), contentSha256: SHA('f') };
    const source = new PrismaEligibilityBoundProjectionSourceV1(
      new FakePrisma(record, [tampered]),
    );

    await expect(source.loadForEligibilityHash(promotionEligibilityHashV1(record))).rejects.toThrow(
      /contentSha256 disagrees with its immutable document/,
    );
  });

  it('refuses a producer plan from a different cycle even when its family is the same', async () => {
    const wrongCycle = omPlanRecord({ cycleId: 'other-cycle' });
    const record = eligibility(wrongCycle, {
      projectionPlanIds: [wrongCycle.projectionPlanId],
      projectionPlanHashes: [wrongCycle.contentSha256],
    });
    const source = new PrismaEligibilityBoundProjectionSourceV1(
      new FakePrisma(record, [projectionPlanRow(wrongCycle)]),
    );

    await expect(source.loadForEligibilityHash(promotionEligibilityHashV1(record))).rejects.toThrow(
      /does not match eligibility/,
    );
  });

  it('refuses when the persisted eligibility document no longer hashes to its lookup key', async () => {
    const named = omPlanRecord();
    const record = eligibility(named);
    const source = new PrismaEligibilityBoundProjectionSourceV1(
      new FakePrisma(record, [projectionPlanRow(named)]),
    );

    await expect(source.loadForEligibilityHash(SHA('9'))).rejects.toThrow(
      /no longer hashes to its storage key/,
    );
  });
});
