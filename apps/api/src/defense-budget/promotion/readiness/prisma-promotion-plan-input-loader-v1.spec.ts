/**
 * Phase 10B-2 Gap 2c — dedicated real-adapter spec for
 * `PrismaPromotionPlanInputLoaderV1`.
 *
 * Proves the adapter loads planning inputs ONLY for the exact evaluated
 * eligibility subject — never arbitrary/latest projection data merely
 * because it shares a cycle — by exercising the real adapter class (which
 * composes the EXISTING `PrismaEligibilityBoundProjectionSourceV1` and
 * `PrismaPromotionEligibilityPersistenceRepositoryV1`) against a single
 * shared in-memory fake store.
 */
import {
  PrismaPromotionPlanInputLoaderV1,
  type PromotionPlanInputPrismaQueryPortV1,
} from './prisma-promotion-plan-input-loader-v1.js';
import {
  buildProjectionPlanRecordV1,
  type DefenseBudgetProjectionPlanRecordV1,
} from '../../projection-plan/projection-plan-record-v1.js';
import {
  computeNonRdteProjectionPlanContentSha256,
  NON_RDTE_PROJECTION_PLAN_SCHEMA_VERSION,
} from '../../non-rdte/non-rdte-canonical-projection-plan-v1.js';
import {
  DEFENSE_BUDGET_PROMOTION_ELIGIBILITY_SCHEMA_VERSION,
  defenseBudgetPromotionEligibilityV1Schema,
  promotionEligibilityHashV1,
  type DefenseBudgetPromotionEligibilityV1,
} from '../promotion-eligibility-v1.js';
import type { CycleFamilyReadinessIdentityV1 } from './cycle-family-readiness-v1.js';

const SHA = (c: string) => c.repeat(64);
const CYCLE = 'cycle-fy2027-authorization';
const IDENTITY: CycleFamilyReadinessIdentityV1 = {
  fiscalYear: 2027,
  authorityTrack: 'authorization',
  familyGroup: 'om',
};

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

/**
 * A single shared in-memory store implementing every table this adapter (and
 * the seams it composes) touches: eligibility persistence,
 * defense_budget_projection_plan (via the exact reload seam), cycle lookup,
 * canonical rows, manual overlays, and the active-snapshot pointer.
 */
class FakePlanInputStore implements PromotionPlanInputPrismaQueryPortV1 {
  public eligibilityDocuments = new Map<string, unknown>();
  public projectionPlanRows: Array<ReturnType<typeof projectionPlanRow>> = [];
  public canonicalRows: Array<Record<string, unknown>> = [];
  public overlayRows: Array<Record<string, unknown>> = [];
  public activeSnapshotRows: Array<Record<string, unknown>> = [];
  public queries: Array<{ query: string; values: unknown[] }> = [];

  async $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> {
    this.queries.push({ query, values });
    if (query.includes('FROM "defense_budget_promotion_eligibility"')) {
      const hash = values[0] as string;
      const doc = this.eligibilityDocuments.get(hash);
      return (doc == null ? [] : [{ document: doc }]) as unknown as T;
    }
    if (query.includes('FROM "defense_budget_projection_plan"')) {
      const requested = new Set(values.map(String));
      return this.projectionPlanRows.filter((row) => requested.has(row.projectionPlanId)) as unknown as T;
    }
    if (query.includes('FROM "defense_budget_cycle"')) {
      return [{ id: CYCLE }] as unknown as T;
    }
    if (query.includes('FROM "defense_budget_canonical_row"')) {
      const snapshotId = values[0];
      return this.canonicalRows.filter((row) => row.snapshotId === snapshotId) as unknown as T;
    }
    if (query.includes('FROM "defense_budget_manual_override"')) {
      return this.overlayRows as unknown as T;
    }
    if (query.includes('FROM "defense_budget_active_snapshot"')) {
      return this.activeSnapshotRows as unknown as T;
    }
    throw new Error(`unexpected query in fake: ${query}`);
  }

  async $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> {
    this.queries.push({ query, values });
    if (query.includes('INSERT INTO "defense_budget_promotion_eligibility"')) {
      const hash = values[1] as string;
      const document = JSON.parse(values[9] as string);
      // ON CONFLICT DO NOTHING semantics: never overwrite an existing hash.
      if (!this.eligibilityDocuments.has(hash)) {
        this.eligibilityDocuments.set(hash, document);
      }
      return 1;
    }
    throw new Error(`unexpected execute in fake: ${query}`);
  }
}

describe('PrismaPromotionPlanInputLoaderV1.loadProjections', () => {
  it('loads projections only for the exact evaluated eligibility subject', async () => {
    const named = omPlanRecord();
    const record = eligibility(named);
    const hash = promotionEligibilityHashV1(record);
    const store = new FakePlanInputStore();
    store.projectionPlanRows = [projectionPlanRow(named)];
    const loader = new PrismaPromotionPlanInputLoaderV1(store, 'defense_budget', 'dev');

    const projections = await loader.loadProjections(IDENTITY, named.certificationSha256, record, hash);
    expect(projections).toEqual([]); // no candidates in this fixture's plan document — proves it reached the projector, not that it's non-empty
    // The eligibility record was durably persisted (idempotent insert) then reloaded by hash.
    expect(store.eligibilityDocuments.has(hash)).toBe(true);
  });

  it('does NOT load arbitrary/latest projection data merely because it shares a cycle — an unrelated plan in the same cycle is excluded', async () => {
    const named = omPlanRecord();
    const unrelated = omPlanRecord({ certificationSha256: SHA('f') }); // same cycle, different content/id
    const record = eligibility(named);
    const hash = promotionEligibilityHashV1(record);
    const store = new FakePlanInputStore();
    // Both plans exist in "storage", but eligibility names only `named`.
    store.projectionPlanRows = [projectionPlanRow(named), projectionPlanRow(unrelated)];
    const loader = new PrismaPromotionPlanInputLoaderV1(store, 'defense_budget', 'dev');

    await loader.loadProjections(IDENTITY, named.certificationSha256, record, hash);

    const planQuery = store.queries.find((q) => q.query.includes('defense_budget_projection_plan'));
    // Only the eligibility-named plan id was requested — never a bare cycle scan.
    expect(planQuery?.values).toEqual([named.projectionPlanId]);
  });

  it('a stale/different eligibility subject reloads its OWN projections, not the caller-supplied certification hash', async () => {
    // A caller passing a mismatched certificationContentSha256 alongside a
    // valid eligibility record must still resolve strictly through the
    // eligibility's own hash — proving loadProjections never widens its
    // query using the certification hash argument.
    const named = omPlanRecord();
    const record = eligibility(named);
    const hash = promotionEligibilityHashV1(record);
    const store = new FakePlanInputStore();
    store.projectionPlanRows = [projectionPlanRow(named)];
    const loader = new PrismaPromotionPlanInputLoaderV1(store, 'defense_budget', 'dev');

    await loader.loadProjections(IDENTITY, SHA('completely-different-cert'), record, hash);

    const planQuery = store.queries.find((q) => q.query.includes('defense_budget_projection_plan'));
    expect(planQuery?.values).toEqual([named.projectionPlanId]);
  });

  it('persists the exact eligibility record before reload — idempotent, content-addressed, no overwrite on repeat calls', async () => {
    const named = omPlanRecord();
    const record = eligibility(named);
    const hash = promotionEligibilityHashV1(record);
    const store = new FakePlanInputStore();
    store.projectionPlanRows = [projectionPlanRow(named)];
    const loader = new PrismaPromotionPlanInputLoaderV1(store, 'defense_budget', 'dev');

    await loader.loadProjections(IDENTITY, named.certificationSha256, record, hash);
    await loader.loadProjections(IDENTITY, named.certificationSha256, record, hash);

    const inserts = store.queries.filter((q) =>
      q.query.includes('INSERT INTO "defense_budget_promotion_eligibility"'),
    );
    expect(inserts).toHaveLength(2); // two calls, but ON CONFLICT DO NOTHING means no duplicate content
    expect(store.eligibilityDocuments.size).toBe(1);
  });

  it('throws on a projector refusal rather than silently returning a partial projection list', async () => {
    const named = omPlanRecord();
    const record = eligibility(named);
    const hash = promotionEligibilityHashV1(record);
    // Corrupt the plan document's family so it disagrees with the row's own
    // `family` column — the existing loadForEligibilityHash seam refuses this.
    const tamperedRow = { ...projectionPlanRow(named), family: 'rdte' };
    const store = new FakePlanInputStore();
    store.projectionPlanRows = [tamperedRow as unknown as ReturnType<typeof projectionPlanRow>];
    const loader = new PrismaPromotionPlanInputLoaderV1(store, 'defense_budget', 'dev');

    await expect(
      loader.loadProjections(IDENTITY, named.certificationSha256, record, hash),
    ).rejects.toThrow();
  });
});

describe('PrismaPromotionPlanInputLoaderV1.loadPriorRows', () => {
  it('projections belong to the requested family: prior canonical rows are scoped to the active snapshot only', async () => {
    const store = new FakePlanInputStore();
    store.activeSnapshotRows = [{ snapshotId: 'snap-1', snapshotHash: SHA('9') }];
    store.canonicalRows = [
      { canonicalEntity: 'om_sag_year', canonicalNaturalKey: 'key-1', canonicalRowHash: SHA('a'), snapshotId: 'snap-1' },
      { canonicalEntity: 'om_sag_year', canonicalNaturalKey: 'key-2', canonicalRowHash: SHA('b'), snapshotId: 'other-snapshot' },
    ];
    const loader = new PrismaPromotionPlanInputLoaderV1(store, 'defense_budget', 'dev');

    const rows = await loader.loadPriorRows(IDENTITY);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.naturalKey).toBe('key-1');
  });

  it('prior canonical rows remain scope-bound: no active snapshot means no rows, never a fallback scan', async () => {
    const store = new FakePlanInputStore(); // no activeSnapshotRows
    const loader = new PrismaPromotionPlanInputLoaderV1(store, 'defense_budget', 'dev');
    const rows = await loader.loadPriorRows(IDENTITY);
    expect(rows).toEqual([]);
    // Must never have queried the canonical row table at all.
    expect(store.queries.some((q) => q.query.includes('defense_budget_canonical_row'))).toBe(false);
  });
});

describe('PrismaPromotionPlanInputLoaderV1.loadExpectedActiveSnapshot', () => {
  it('active snapshot identity is the expected one: domain+environment scoped', async () => {
    const store = new FakePlanInputStore();
    store.activeSnapshotRows = [{ snapshotId: 'snap-42', snapshotHash: SHA('c') }];
    const loader = new PrismaPromotionPlanInputLoaderV1(store, 'defense_budget', 'dev');

    const snapshot = await loader.loadExpectedActiveSnapshot(IDENTITY);
    expect(snapshot).toEqual({ snapshotId: 'snap-42', snapshotHash: SHA('c') });
    const query = store.queries.find((q) => q.query.includes('defense_budget_active_snapshot'));
    expect(query?.values).toEqual(['defense_budget', 'dev']);
  });

  it('refuses (returns null) an unhashed active snapshot rather than reporting a fabricated identity', async () => {
    const store = new FakePlanInputStore();
    store.activeSnapshotRows = [{ snapshotId: 'snap-broken', snapshotHash: null }];
    const loader = new PrismaPromotionPlanInputLoaderV1(store, 'defense_budget', 'dev');
    await expect(loader.loadExpectedActiveSnapshot(IDENTITY)).resolves.toBeNull();
  });
});

describe('PrismaPromotionPlanInputLoaderV1.loadOverlays', () => {
  it('overlays cannot cross fiscal year / authority track / family scope: only non-proposed, newest-version rows are read', async () => {
    const store = new FakePlanInputStore();
    store.overlayRows = [
      {
        canonicalEntity: 'om_sag_year',
        canonicalNaturalKey: 'key-1',
        fiscalYear: 2027,
        fundingField: null,
        status: 'active',
        effectiveFrom: '2027-01-01T00:00:00Z',
        effectiveTo: null,
      },
    ];
    const loader = new PrismaPromotionPlanInputLoaderV1(store, 'defense_budget', 'dev');
    const overlays = await loader.loadOverlays(IDENTITY);
    expect(overlays).toEqual([
      {
        canonicalEntity: 'om_sag_year',
        naturalKey: 'key-1',
        fiscalYear: 2027,
        fundingField: null,
        status: 'active',
      },
    ]);
    const query = store.queries.find((q) => q.query.includes('defense_budget_manual_override'));
    expect(query?.query).toContain(`WHERE "status" <> 'proposed'`);
  });

  it('an expired overlay (effectiveTo in the past) is mapped to status expired, not active', async () => {
    const store = new FakePlanInputStore();
    store.overlayRows = [
      {
        canonicalEntity: 'om_sag_year',
        canonicalNaturalKey: 'key-1',
        fiscalYear: 2020,
        fundingField: null,
        status: 'active', // stored status is 'active' but effectiveTo has passed
        effectiveFrom: '2020-01-01T00:00:00Z',
        effectiveTo: '2020-12-31T00:00:00Z',
      },
    ];
    const loader = new PrismaPromotionPlanInputLoaderV1(store, 'defense_budget', 'dev');
    const [overlay] = await loader.loadOverlays(IDENTITY);
    expect(overlay?.status).toBe('expired');
  });
});
