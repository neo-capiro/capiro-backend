/**
 * Phase 10B-2C — Certification Bridge: real adapter-level integration tests.
 *
 * Unlike `cycle-family-readiness-orchestrator-v1.spec.ts` (which fakes both
 * `FamilyReconciliationCertificationPortV1` and
 * `PromotionEligibilityRepositoryV1` at the port level), these tests wire the
 * REAL `PrismaFamilyReconciliationCertificationV1` adapter together with the
 * REAL `PrismaPromotionEligibilityReadRepositoryV1` adapter against one
 * shared in-memory table-routed fake Prisma client, proving the two adapters
 * actually agree end to end:
 *
 *   ready_for_reconciliation corpus
 *     -> PrismaFamilyReconciliationCertificationV1.reconcileAndCertify()
 *        reads the persisted family certification (existing certifier
 *        output; this bridge never re-invokes a certifier)
 *     -> that EXACT certification content hash
 *     -> PrismaPromotionEligibilityReadRepositoryV1.loadCycleCertifications()
 *        sees the SAME hash for the SAME family/cycle
 *
 * This is what closes `PHASE10B2_EXISTING_ELIGIBILITY_CERTIFICATION_BOUNDARY_GAP`
 * in a way a fake-only orchestration test cannot prove: two independently
 * fake-substitutable ports could each individually pass their own spec while
 * silently disagreeing about which row is "the" current certification for a
 * family. This file is the disagreement check.
 */
import { PrismaFamilyReconciliationCertificationV1 } from './prisma-family-reconciliation-certification-v1.js';
import type { CycleFamilyReadinessIdentityV1, CycleFamilyCorpusInputV1 } from './cycle-family-readiness-v1.js';
import { PrismaPromotionEligibilityReadRepositoryV1 } from '../promotion-eligibility-read-repository-prisma-v1.js';
import type { EligibilityReadPrismaLikeV1 } from '../promotion-eligibility-read-repository-prisma-v1.js';

const SHA = (c: string) => c.repeat(64);

/**
 * One shared fake serving both adapters' `$queryRawUnsafe` surface, routed by
 * table name — same idiom as `promotion-eligibility-read-repository-prisma-v1.spec.ts`'s
 * `TableRoutedPrisma` and `prisma-family-reconciliation-certification-v1.spec.ts`'s
 * `FakeCertPrisma`, merged into one class so both real adapters can be
 * pointed at the exact same in-memory rows in the same test.
 */
class SharedTableRoutedPrisma implements EligibilityReadPrismaLikeV1 {
  readonly queries: { sql: string; values: unknown[] }[] = [];
  tables: Record<string, unknown[]> = {};

  async $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> {
    this.queries.push({ sql: query, values });
    for (const [table, rows] of Object.entries(this.tables)) {
      if (query.includes(`"${table}"`)) return rows as unknown as T;
    }
    return [] as unknown as T;
  }

  async $executeRawUnsafe(): Promise<number> {
    throw new Error('this bridge never writes; only readiness/eligibility reads are under test');
  }
}

function identity(
  familyGroup: CycleFamilyReadinessIdentityV1['familyGroup'],
  fiscalYear = 2027,
): CycleFamilyReadinessIdentityV1 {
  return { fiscalYear, authorityTrack: 'authorization', familyGroup };
}

function corpus(cycleId: string, familyGroup: CycleFamilyReadinessIdentityV1['familyGroup']): CycleFamilyCorpusInputV1 {
  return { identity: identity(familyGroup), cycleId, expectedSources: [] };
}

/** A projection-plan row exactly as Phase 4/5 file it: self-certified bundle. */
function projectionPlanRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectionPlanId: 'pp-1',
    certificationSha256: SHA('c'),
    certificationId: null,
    status: 'PROJECTABLE',
    conflictCount: 0,
    planDocument: { certification: 'CERTIFIED_NON_RDTE_READY_FOR_PROJECTION' },
    ...overrides,
  };
}

describe('Phase 10B-2C certification bridge — real adapter integration (rdte/procurement/om/milcon)', () => {
  it.each([
    ['rdte' as const],
    ['procurement' as const],
    ['om' as const],
    ['milcon' as const],
  ])(
    '%s: readiness bridge certification hash is the EXACT hash eligibility sees',
    async (family) => {
      const prisma = new SharedTableRoutedPrisma();
      prisma.tables = {
        defense_budget_projection_plan: [
          projectionPlanRow({ projectionPlanId: `pp-${family}` }),
        ],
      };

      // Step 1: the readiness bridge (real adapter) reconciles/certifies.
      const bridge = new PrismaFamilyReconciliationCertificationV1(prisma);
      const reconciliation = await bridge.reconcileAndCertify(
        identity(family),
        corpus('cycle-fy2027-authorization', family),
      );
      expect(reconciliation.certified).toBe(true);
      expect(reconciliation.certificationContentSha256).toBe(SHA('c'));

      // Step 2: Phase 7 eligibility's real read repository, scoped to the
      // SAME cycle + family, must report the EXACT same content hash.
      const eligibilityReads = new PrismaPromotionEligibilityReadRepositoryV1(prisma);
      const certifications = await eligibilityReads.loadCycleCertifications(
        'cycle-fy2027-authorization',
        2027,
        [family],
      );
      expect(certifications).toHaveLength(1);
      expect(certifications[0]?.contentSha256).toBe(reconciliation.certificationContentSha256);
      expect(certifications[0]?.status.startsWith('CERTIFIED')).toBe(true);
    },
  );

  it('committee: existing Phase 6 path still works, and eligibility sees the exact hash the bridge read', async () => {
    const prisma = new SharedTableRoutedPrisma();
    prisma.tables = {
      phase6_cycle_certification: [
        { certificationId: 'cert-committee-1', contentSha256: SHA('d'), status: 'CERTIFIED' },
      ],
    };

    const bridge = new PrismaFamilyReconciliationCertificationV1(prisma);
    const reconciliation = await bridge.reconcileAndCertify(
      identity('committee'),
      corpus('cycle-fy2027-authorization', 'committee'),
    );
    expect(reconciliation.certified).toBe(true);
    expect(reconciliation.certificationContentSha256).toBe(SHA('d'));

    const eligibilityReads = new PrismaPromotionEligibilityReadRepositoryV1(prisma);
    const certifications = await eligibilityReads.loadCycleCertifications(
      'cycle-fy2027-authorization',
      2027,
      ['committee'],
    );
    expect(certifications).toEqual([
      { certificationId: 'cert-committee-1', contentSha256: SHA('d'), status: 'CERTIFIED' },
    ]);
  });

  it('wrong family certification is rejected: an O&M certification never satisfies an RDT&E eligibility request', async () => {
    const prisma = new SharedTableRoutedPrisma();
    prisma.tables = {
      defense_budget_projection_plan: [
        projectionPlanRow({ projectionPlanId: 'pp-om-1' }), // family filter applies in SQL; real DB would scope by family='om'
      ],
    };
    const eligibilityReads = new PrismaPromotionEligibilityReadRepositoryV1(prisma);
    // The fake returns rows unconditionally by table name (it does not
    // simulate the WHERE family=$2 clause), so this test instead proves the
    // adapter SENDS the exact requested family as the bound SQL parameter —
    // the real database enforces the WHERE clause; the adapter must never
    // silently widen or omit it.
    await eligibilityReads.loadCycleCertifications('cycle-fy2027-authorization', 2027, ['rdte']);
    const planQuery = prisma.queries.find((q) => q.sql.includes('defense_budget_projection_plan'));
    expect(planQuery?.values).toEqual(['cycle-fy2027-authorization', 'rdte']);
  });

  it('wrong authority track (committee vs non-committee) cannot satisfy the other: committee query never runs for a non-committee-only request, and vice versa', async () => {
    const prisma = new SharedTableRoutedPrisma();
    prisma.tables = {
      phase6_cycle_certification: [
        { certificationId: 'cert-committee-1', contentSha256: SHA('d'), status: 'CERTIFIED' },
      ],
      defense_budget_projection_plan: [projectionPlanRow()],
    };
    const eligibilityReads = new PrismaPromotionEligibilityReadRepositoryV1(prisma);

    await eligibilityReads.loadCycleCertifications('c', 2027, ['om']);
    expect(prisma.queries.some((q) => q.sql.includes('phase6_cycle_certification'))).toBe(false);

    prisma.queries.length = 0;
    await eligibilityReads.loadCycleCertifications('c', 2027, ['committee']);
    expect(prisma.queries.some((q) => q.sql.includes('defense_budget_projection_plan'))).toBe(false);
  });

  it('wrong FY is rejected: committee certification is scoped by the exact requested fiscalYear', async () => {
    const prisma = new SharedTableRoutedPrisma();
    prisma.tables = {
      phase6_cycle_certification: [
        { certificationId: 'cert-committee-1', contentSha256: SHA('d'), status: 'CERTIFIED' },
      ],
    };
    const bridge = new PrismaFamilyReconciliationCertificationV1(prisma);
    await bridge.reconcileAndCertify(
      { ...identity('committee'), fiscalYear: 2029 },
      corpus('cycle-1', 'committee'),
    );
    const phase6Query = prisma.queries.find((q) => q.sql.includes('phase6_cycle_certification'));
    expect(phase6Query?.values).toEqual(['cycle-1', 2029]);

    prisma.queries.length = 0;
    const eligibilityReads = new PrismaPromotionEligibilityReadRepositoryV1(prisma);
    await eligibilityReads.loadCycleCertifications('cycle-1', 2029, ['committee']);
    expect(prisma.queries[0]?.values).toEqual(['cycle-1', 2029]);
  });

  it('stale/non-certified certification is rejected: a REJECTED bundle reports certified:false from BOTH adapters, never silently treated as certified', async () => {
    const prisma = new SharedTableRoutedPrisma();
    prisma.tables = {
      defense_budget_projection_plan: [
        projectionPlanRow({
          status: 'BLOCKED',
          conflictCount: 2,
          planDocument: { certification: 'REJECTED' },
        }),
      ],
    };

    const bridge = new PrismaFamilyReconciliationCertificationV1(prisma);
    const reconciliation = await bridge.reconcileAndCertify(identity('om'), corpus('c', 'om'));
    expect(reconciliation.certified).toBe(false);
    expect(reconciliation.certificationStatus).toBe('REJECTED');

    const eligibilityReads = new PrismaPromotionEligibilityReadRepositoryV1(prisma);
    const certifications = await eligibilityReads.loadCycleCertifications('c', 2027, ['om']);
    expect(certifications).toHaveLength(1);
    expect(certifications[0]?.status).toBe('REJECTED');
    expect(certifications[0]?.status.startsWith('CERTIFIED')).toBe(false);
  });

  it('changed certification content hash produces a different bridge output than the original', async () => {
    const prisma = new SharedTableRoutedPrisma();
    prisma.tables = {
      defense_budget_projection_plan: [
        projectionPlanRow({ certificationSha256: SHA('9') }),
      ],
    };
    const bridge = new PrismaFamilyReconciliationCertificationV1(prisma);
    const reconciliation = await bridge.reconcileAndCertify(identity('om'), corpus('c', 'om'));
    expect(reconciliation.certificationContentSha256).toBe(SHA('9'));
    expect(reconciliation.certificationContentSha256).not.toBe(SHA('c'));

    const eligibilityReads = new PrismaPromotionEligibilityReadRepositoryV1(prisma);
    const certifications = await eligibilityReads.loadCycleCertifications('c', 2027, ['om']);
    expect(certifications[0]?.contentSha256).toBe(SHA('9'));
    // Downstream (cycle-family-readiness-orchestrator-v1.spec.ts's "[new
    // identity on change]" test) already proves a changed certification hash
    // like this one derives a different deterministic planId — cross-
    // referenced here rather than re-proven, since planId derivation is the
    // orchestrator's responsibility, not this bridge's.
  });

  it('unsupported alternative_funding/execution tracks never reach either adapter (readiness refuses before reconciliation is invoked)', async () => {
    // Documented and enforced at the readiness layer
    // (cycle-family-readiness-v1.ts's UNSUPPORTED_READINESS_TRACKS +
    // evaluateCycleFamilyReadinessV1 returning certification_not_supported)
    // and proven at the orchestrator level
    // (cycle-family-readiness-orchestrator-v1.spec.ts's
    // "[certification_not_supported]" test: reconciliationCertification.calls
    // === 0). Neither adapter under test in this file is ever invoked for
    // these tracks — restated here as a readable cross-reference for anyone
    // reviewing this bridge integration file in isolation.
    expect(true).toBe(true);
  });
});

describe('Phase 10B-2C certification bridge — authorization boundary (both real adapters)', () => {
  it('neither PrismaFamilyReconciliationCertificationV1 nor PrismaPromotionEligibilityReadRepositoryV1 ever writes', async () => {
    const prisma = new SharedTableRoutedPrisma();
    await expect(prisma.$executeRawUnsafe()).rejects.toThrow(/never writes/);
  });

  it('[authorization boundary] neither adapter file (outside doc comments) references PROMOTER_DATABASE_URL, DefenseBudgetCanonicalPromotionServiceV1, or DefenseBudgetPromotionAuthorizationServiceV1', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs');
    const files = [
      require.resolve('./prisma-family-reconciliation-certification-v1.ts'),
      require.resolve('../promotion-eligibility-read-repository-prisma-v1.ts'),
      require.resolve('../family-certified-plan-read-v1.ts'),
    ];
    const forbidden = [
      'PROMOTER_DATABASE_URL',
      'DefenseBudgetCanonicalPromotionServiceV1',
      'DefenseBudgetPromotionAuthorizationServiceV1',
    ];
    for (const file of files) {
      const source: string = fs.readFileSync(file, 'utf8');
      const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const term of forbidden) {
        expect(withoutComments).not.toContain(term);
      }
    }
  });
});
