import {
  PrismaPromotionAuthorizationRepositoryV1,
  PrismaPromotionEligibilityPersistenceRepositoryV1,
  type EligibilityAuthorizationPrismaLikeV1,
} from './promotion-eligibility-authorization-repository-prisma-v1.js';
import {
  promotionEligibilityHashV1,
  type DefenseBudgetPromotionEligibilityV1,
} from './promotion-eligibility-v1.js';

const SHA = (c: string) => c.repeat(64);

function eligibility(
  overrides: Partial<DefenseBudgetPromotionEligibilityV1> = {},
): DefenseBudgetPromotionEligibilityV1 {
  return {
    schemaVersion: 'defense_budget_promotion_eligibility_v2',
    eligibilityId: 'elig-1',
    cycleId: 'cycle-fy2027',
    scope: { cycleId: 'cycle-fy2027', fiscalYear: 2027, families: ['om'], stages: [] },
    projectionPlanIds: ['plan-source-1'],
    projectionPlanHashes: [SHA('1')],
    mappingRegistryVersion: '1.0.0',
    mappingRegistryHash: SHA('2'),
    candidates: [
      {
        candidateId: 'cand-1',
        status: 'VERIFICATION_PASSED',
        terminalVerificationRunId: 'run-1',
        acceptedAssertionIds: ['assert-1'],
        extractionMethod: 'deterministic_pdfplumber',
        family: 'committee',
        sourceProfileSha256: SHA('b'),
        artifactSha256: SHA('3'),
        sourceSha256: SHA('4'),
      },
    ],
    sourceDocumentHashes: [SHA('8')],
    artifactHashes: [SHA('9')],
    manifestHash: SHA('a'),
    sourceProfileHashes: [SHA('b')],
    verificationPolicyHashes: [SHA('c')],
    cycleCertificationIds: ['cert-1'],
    cycleCertificationHashes: [SHA('d')],
    expectedActiveSnapshotId: null,
    expectedActiveSnapshotHash: null,
    openConflictCount: 0,
    unsupportedItemCount: 0,
    generatedAt: '2027-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** An in-memory stand-in for the eligibility/plan/authorization tables. */
class FakeDb {
  eligibilityByHash = new Map<string, unknown>();
  plansById = new Map<
    string,
    {
      planHash: string;
      eligibilityHash: string;
      blockedCount: number;
      expectedActiveSnapshotId: string | null;
    }
  >();
  authorizationsById = new Map<string, unknown>();
  insertedAuthorizations: Record<string, unknown>[] = [];

  asPrisma(): EligibilityAuthorizationPrismaLikeV1 {
    const db = this;
    return {
      async $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T> {
        if (
          query.includes('FROM "defense_budget_promotion_eligibility" WHERE "eligibility_hash"')
        ) {
          const document = db.eligibilityByHash.get(String(values[0]));
          return (document ? [{ document }] : []) as unknown as T;
        }
        if (query.includes('JOIN "defense_budget_promotion_eligibility"')) {
          const plan = db.plansById.get(String(values[0]));
          if (plan == null) return [] as unknown as T;
          const document = db.eligibilityByHash.get(plan.eligibilityHash);
          if (document == null) return [] as unknown as T;
          return [
            {
              planId: String(values[0]),
              planHash: plan.planHash,
              eligibilityHash: plan.eligibilityHash,
              blockedCount: plan.blockedCount,
              expectedActiveSnapshotId: plan.expectedActiveSnapshotId,
              document,
            },
          ] as unknown as T;
        }
        if (
          query.includes('FROM "defense_budget_promotion_authorization" WHERE "authorization_id"')
        ) {
          const authorizationId = String(values[0]);
          return (db.authorizationsById.has(authorizationId)
            ? [{ authorizationId }]
            : []) as unknown as T;
        }
        throw new Error(`FakeDb: unrecognized query: ${query}`);
      },
      async $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> {
        if (query.includes('INSERT INTO "defense_budget_promotion_eligibility"')) {
          const hash = String(values[1]);
          if (!db.eligibilityByHash.has(hash)) {
            db.eligibilityByHash.set(hash, JSON.parse(String(values[9])));
          }
          return 1;
        }
        if (query.includes('INSERT INTO "defense_budget_promotion_authorization"')) {
          const authorizationId = String(values[0]);
          db.authorizationsById.set(authorizationId, true);
          db.insertedAuthorizations.push({ authorizationId, values });
          return 1;
        }
        throw new Error(`FakeDb: unrecognized statement: ${query}`);
      },
    };
  }

  seedPlan(
    planId: string,
    plan: {
      planHash: string;
      eligibilityHash: string;
      blockedCount: number;
      expectedActiveSnapshotId: string | null;
    },
  ): void {
    this.plansById.set(planId, plan);
  }
}

describe('PrismaPromotionEligibilityPersistenceRepositoryV1', () => {
  it('persists an eligibility record and reads it back byte-identical', async () => {
    const db = new FakeDb();
    const repository = new PrismaPromotionEligibilityPersistenceRepositoryV1(db.asPrisma());
    const record = eligibility();
    const hash = promotionEligibilityHashV1(record);

    await repository.insert(record);
    const read = await repository.findByHash(hash);

    expect(read).toEqual(record);
  });

  it('is idempotent: inserting the identical record twice does not error', async () => {
    const db = new FakeDb();
    const repository = new PrismaPromotionEligibilityPersistenceRepositoryV1(db.asPrisma());
    const record = eligibility();

    await repository.insert(record);
    await expect(repository.insert(record)).resolves.toBeUndefined();
    expect(db.eligibilityByHash.size).toBe(1);
  });

  it('returns null for a hash nothing was ever recorded under', async () => {
    const db = new FakeDb();
    const repository = new PrismaPromotionEligibilityPersistenceRepositoryV1(db.asPrisma());
    await expect(repository.findByHash(SHA('0'))).resolves.toBeNull();
  });

  it('refuses a stored document that no longer hashes to its own key', async () => {
    const db = new FakeDb();
    const repository = new PrismaPromotionEligibilityPersistenceRepositoryV1(db.asPrisma());
    const record = eligibility();
    const hash = promotionEligibilityHashV1(record);
    await repository.insert(record);

    // Simulate storage tampering: swap the stored document's generatedAt
    // timestamp without updating the hash it is keyed under. (cycleId is
    // deliberately avoided here — the schema's own cross-field check between
    // cycleId and scope.cycleId would reject it before this repository's
    // tamper detection ever runs, which is a different, also-correct failure
    // this test isn't trying to exercise.)
    db.eligibilityByHash.set(hash, { ...record, generatedAt: '2099-01-01T00:00:00.000Z' });

    await expect(repository.findByHash(hash)).rejects.toThrow(/tampered/);
  });
});

describe('PrismaPromotionAuthorizationRepositoryV1', () => {
  it('loads a plan joined to its real eligibility record', async () => {
    const db = new FakeDb();
    const eligibilityRepo = new PrismaPromotionEligibilityPersistenceRepositoryV1(db.asPrisma());
    const record = eligibility();
    const hash = promotionEligibilityHashV1(record);
    await eligibilityRepo.insert(record);
    db.seedPlan('plan-1', {
      planHash: SHA('f'),
      eligibilityHash: hash,
      blockedCount: 0,
      expectedActiveSnapshotId: null,
    });

    const repository = new PrismaPromotionAuthorizationRepositoryV1(db.asPrisma());
    const plan = await repository.loadPlan('plan-1');

    expect(plan).not.toBeNull();
    expect(plan?.planHash).toBe(SHA('f'));
    expect(plan?.eligibility).toEqual(record);
  });

  it('returns null for a plan that was never filed', async () => {
    const db = new FakeDb();
    const repository = new PrismaPromotionAuthorizationRepositoryV1(db.asPrisma());
    await expect(repository.loadPlan('does-not-exist')).resolves.toBeNull();
  });

  it('findAuthorizationById distinguishes existing from absent', async () => {
    const db = new FakeDb();
    db.authorizationsById.set('auth-1', true);
    const repository = new PrismaPromotionAuthorizationRepositoryV1(db.asPrisma());

    await expect(repository.findAuthorizationById('auth-1')).resolves.toEqual({
      authorizationId: 'auth-1',
    });
    await expect(repository.findAuthorizationById('auth-missing')).resolves.toBeNull();
  });

  it('inserts a well-formed authorization record', async () => {
    const db = new FakeDb();
    const repository = new PrismaPromotionAuthorizationRepositoryV1(db.asPrisma());
    const authorization = {
      schemaVersion: 'defense_budget_promotion_authorization_v1' as const,
      authorizationId: 'auth-1',
      eligibilityHash: SHA('1'),
      planId: 'plan-1',
      planHash: SHA('2'),
      scope: { cycleId: 'cycle-fy2027', fiscalYear: 2027, families: ['om' as const], stages: [] },
      expectedActiveSnapshotId: null,
      authorizerActorId: 'actor-admin',
      reason: 'baseline hydration',
      issuedAt: '2027-01-01T00:00:00.000Z',
      expiresAt: '2027-01-01T01:00:00.000Z',
      segregation: {
        authorizerActorId: 'actor-admin',
        authorizerRole: 'capiro_admin' as const,
        reviewerActorIds: [],
        extractorActorIds: [],
        highRiskExtractionPresent: false,
      },
      authorizationHash: SHA('3'),
    };

    await repository.insertAuthorization(authorization);

    expect(db.insertedAuthorizations).toHaveLength(1);
    expect(db.authorizationsById.has('auth-1')).toBe(true);
  });

  it('refuses to insert an authorization that fails its own schema', async () => {
    const db = new FakeDb();
    const repository = new PrismaPromotionAuthorizationRepositoryV1(db.asPrisma());
    const invalid = {
      schemaVersion: 'defense_budget_promotion_authorization_v1' as const,
      authorizationId: 'auth-bad',
      eligibilityHash: SHA('1'),
      planId: 'plan-1',
      planHash: SHA('2'),
      scope: { cycleId: 'cycle-fy2027', fiscalYear: 2027, families: ['om' as const], stages: [] },
      expectedActiveSnapshotId: null,
      authorizerActorId: 'actor-admin',
      reason: 'baseline hydration',
      issuedAt: '2027-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T00:00:00.000Z', // expires before it is issued
      segregation: {
        authorizerActorId: 'actor-admin',
        authorizerRole: 'capiro_admin' as const,
        reviewerActorIds: [],
        extractorActorIds: [],
        highRiskExtractionPresent: false,
      },
      authorizationHash: SHA('3'),
    };

    await expect(repository.insertAuthorization(invalid)).rejects.toThrow();
    expect(db.insertedAuthorizations).toHaveLength(0);
  });
});
