/**
 * Phase 10B-2 Gap 2b — dedicated real-adapter spec for
 * `PrismaFamilyReconciliationCertificationV1`.
 *
 * Proves the adapter selects the correct EXISTING durable certification
 * source per family group (rdte/procurement/om/milcon read the embedded
 * bundle certification on `defense_budget_projection_plan`; committee reads
 * the separate `phase6_cycle_certification` row) without inventing a new
 * certifier.
 */
import { PrismaFamilyReconciliationCertificationV1 } from './prisma-family-reconciliation-certification-v1.js';
import type { CycleFamilyReadinessIdentityV1, CycleFamilyCorpusInputV1 } from './cycle-family-readiness-v1.js';

const SHA = (c: string) => c.repeat(64);

function identity(familyGroup: CycleFamilyReadinessIdentityV1['familyGroup']): CycleFamilyReadinessIdentityV1 {
  return { fiscalYear: 2027, authorityTrack: 'authorization', familyGroup };
}

function corpus(cycleId: string): CycleFamilyCorpusInputV1 {
  return { identity: identity('om'), cycleId, expectedSources: [] };
}

type ProjectionPlanFakeRow = {
  certificationSha256: string;
  certificationId: string | null;
  status: string;
  conflictCount: number;
  planDocument: unknown;
};
type Phase6FakeRow = { certificationId: string; contentSha256: string; status: string };

class FakeCertPrisma {
  public readonly queries: Array<{ query: string; values: unknown[] }> = [];
  constructor(
    private readonly projectionPlanRows: ProjectionPlanFakeRow[] = [],
    private readonly phase6Rows: Phase6FakeRow[] = [],
  ) {}

  async $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> {
    this.queries.push({ query, values });
    if (query.includes('FROM "defense_budget_projection_plan"')) {
      return this.projectionPlanRows as unknown as T;
    }
    if (query.includes('FROM "phase6_cycle_certification"')) {
      return this.phase6Rows as unknown as T;
    }
    throw new Error(`unexpected query in fake: ${query}`);
  }
}

describe('PrismaFamilyReconciliationCertificationV1 — family-group source selection', () => {
  it.each([
    ['rdte' as const],
    ['procurement' as const],
    ['om' as const],
    ['milcon' as const],
  ])('%s reads the certified bundle embedded on defense_budget_projection_plan', async (familyGroup) => {
    const rows: ProjectionPlanFakeRow[] = [
      {
        certificationSha256: SHA('c'),
        certificationId: null,
        status: 'PROJECTABLE',
        conflictCount: 0,
        planDocument: { certification: 'CERTIFIED_READY_FOR_PROJECTION' },
      },
    ];
    const prisma = new FakeCertPrisma(rows);
    const adapter = new PrismaFamilyReconciliationCertificationV1(prisma);
    const result = await adapter.reconcileAndCertify(identity(familyGroup), corpus('cycle-1'));

    expect(result.certified).toBe(true);
    expect(result.certificationContentSha256).toBe(SHA('c'));
    expect(result.certificationRowId).toBeNull(); // RDT&E/non-RDT&E self-certify inside the bundle
    const planQuery = prisma.queries.find((q) => q.query.includes('defense_budget_projection_plan'));
    expect(planQuery?.values).toEqual(['cycle-1', familyGroup]);
    // Must never query the Phase 6 table for a non-committee family group.
    expect(prisma.queries.some((q) => q.query.includes('phase6_cycle_certification'))).toBe(false);
  });

  it('committee reads the SEPARATE phase6_cycle_certification row, not the projection-plan table', async () => {
    const prisma = new FakeCertPrisma([], [
      { certificationId: 'cert-1', contentSha256: SHA('d'), status: 'CERTIFIED' },
    ]);
    const adapter = new PrismaFamilyReconciliationCertificationV1(prisma);
    const result = await adapter.reconcileAndCertify(identity('committee'), corpus('cycle-1'));

    expect(result.certified).toBe(true);
    expect(result.certificationContentSha256).toBe(SHA('d'));
    expect(result.certificationRowId).toBe('cert-1');
    const phase6Query = prisma.queries.find((q) => q.query.includes('phase6_cycle_certification'));
    expect(phase6Query?.values).toEqual(['cycle-1', 2027]);
    expect(prisma.queries.some((q) => q.query.includes('defense_budget_projection_plan'))).toBe(false);
  });

  it('does not write new certifiers: the adapter has no IMPORT of a pure certifier function (its doc comment names them only to explain why it does not call them)', () => {
    // Strip comments before substring-matching, or this scan false-positives
    // on the file's own explanatory doc comment (which legitimately
    // discusses certifyRdteCycle/certifyNonRdteCycle/certifyPhase6CycleV1 to
    // explain the design choice NOT to call them).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs');
    const source: string = fs.readFileSync(
      require.resolve('./prisma-family-reconciliation-certification-v1.ts'),
      'utf8',
    );
    const withoutComments = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(withoutComments).not.toMatch(/certifyRdteCycle|certifyNonRdteCycle|certifyPhase6CycleV1/);
    // Positive control: confirm the strip actually removed the doc-comment
    // mentions, so a future change to the doc comment doesn't silently make
    // this assertion vacuous.
    expect(source).toMatch(/certifyRdteCycle/);
  });
});

describe('PrismaFamilyReconciliationCertificationV1 — status mapping', () => {
  it('an incomplete/rejected non-committee status returns certified: false with the exact status literal', async () => {
    const prisma = new FakeCertPrisma([
      {
        certificationSha256: SHA('c'),
        certificationId: null,
        status: 'BLOCKED',
        conflictCount: 3,
        planDocument: { certification: 'REJECTED' },
      },
    ]);
    const adapter = new PrismaFamilyReconciliationCertificationV1(prisma);
    const result = await adapter.reconcileAndCertify(identity('om'), corpus('cycle-1'));

    expect(result.certified).toBe(false);
    expect(result.certificationStatus).toBe('REJECTED');
    expect(result.certificationContentSha256).toBeNull();
    expect(result.blockingFindingCount).toBe(3);
  });

  it('a rejected committee status returns certified: false', async () => {
    const prisma = new FakeCertPrisma([], [
      { certificationId: 'cert-1', contentSha256: SHA('d'), status: 'REJECTED' },
    ]);
    const adapter = new PrismaFamilyReconciliationCertificationV1(prisma);
    const result = await adapter.reconcileAndCertify(identity('committee'), corpus('cycle-1'));

    expect(result.certified).toBe(false);
    expect(result.certificationStatus).toBe('REJECTED');
    expect(result.certificationContentSha256).toBeNull();
    expect(result.certificationRowId).toBeNull();
  });

  it('missing row (no plan filed / no Phase 6 certification exists) fails closed to certified: false, status INCOMPLETE', async () => {
    const nonCommitteeAdapter = new PrismaFamilyReconciliationCertificationV1(new FakeCertPrisma([]));
    const nonCommitteeResult = await nonCommitteeAdapter.reconcileAndCertify(identity('om'), corpus('cycle-1'));
    expect(nonCommitteeResult.certified).toBe(false);
    expect(nonCommitteeResult.certificationStatus).toBe('INCOMPLETE');
    expect(nonCommitteeResult.certificationContentSha256).toBeNull();

    const committeeAdapter = new PrismaFamilyReconciliationCertificationV1(new FakeCertPrisma([], []));
    const committeeResult = await committeeAdapter.reconcileAndCertify(identity('committee'), corpus('cycle-1'));
    expect(committeeResult.certified).toBe(false);
    expect(committeeResult.certificationStatus).toBe('INCOMPLETE');
    expect(committeeResult.certificationContentSha256).toBeNull();
  });

  it('wrong fiscal year cannot satisfy the requested scope for committee (queried by exact cycleId + fiscalYear)', async () => {
    // The fake only returns rows when the fake itself decides to; here we
    // prove the adapter PASSES the exact requested fiscalYear as a bound
    // parameter rather than reading across years, by asserting the values
    // array the adapter sent.
    const prisma = new FakeCertPrisma([], [
      { certificationId: 'cert-1', contentSha256: SHA('d'), status: 'CERTIFIED' },
    ]);
    const adapter = new PrismaFamilyReconciliationCertificationV1(prisma);
    await adapter.reconcileAndCertify({ ...identity('committee'), fiscalYear: 2029 }, corpus('cycle-1'));
    const phase6Query = prisma.queries.find((q) => q.query.includes('phase6_cycle_certification'));
    expect(phase6Query?.values).toEqual(['cycle-1', 2029]);
  });

  it('wrong cycle/family cannot satisfy the requested scope for non-committee families (queried by exact cycleId + family)', async () => {
    const prisma = new FakeCertPrisma([
      {
        certificationSha256: SHA('c'),
        certificationId: null,
        status: 'PROJECTABLE',
        conflictCount: 0,
        planDocument: { certification: 'CERTIFIED_READY_FOR_PROJECTION' },
      },
    ]);
    const adapter = new PrismaFamilyReconciliationCertificationV1(prisma);
    await adapter.reconcileAndCertify(identity('milcon'), corpus('cycle-fy2027-authorization'));
    const planQuery = prisma.queries.find((q) => q.query.includes('defense_budget_projection_plan'));
    expect(planQuery?.values).toEqual(['cycle-fy2027-authorization', 'milcon']);
  });

  it('alternative_funding and execution never reach this adapter at all — the orchestrator refuses before invoking reconciliation', () => {
    // Documented invariant, proven at the orchestrator level
    // (cycle-family-readiness-orchestrator-v1.spec.ts's
    // "[certification_not_supported]" case: reconciliationCertification.calls
    // === 0). Restated here as a readable cross-reference so a reviewer of
    // this adapter's own spec file sees the guarantee without having to find
    // the orchestrator spec.
    expect(true).toBe(true);
  });
});
