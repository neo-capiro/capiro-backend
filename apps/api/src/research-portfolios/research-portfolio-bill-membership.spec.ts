import { ResearchPortfolioAnalyticsService } from './research-portfolio-analytics.service.js';

/**
 * Bills inside the analytics projection (requirements 7 and 14e).
 *
 * The point of these tests is what does NOT happen: a tracked bill must never reach a
 * funding reader, must never become a zero, and must never be reported as a funding
 * reader failure. That is a different thing from "the number is missing", and the UI,
 * exports, snapshots and Meri all read this one projection.
 */
const ctx: any = { tenantId: 'tenant-bills', userId: 'actor-bills', role: 'standard_user' };
const portfolioId = 'portfolio-bills';

const billMember = {
  id: 'member-bill',
  tenantId: ctx.tenantId,
  portfolioId,
  targetKind: 'federal_bill',
  targetId: '119-hr-8800',
  label: 'H.R. 8800 — Defense Appropriations',
  disposition: 'included',
  origin: 'manual',
  reason: null,
  unresolvedInput: null,
  resolvedAt: new Date('2026-09-01T00:00:00Z'),
  evidence: {
    facts: {
      jurisdiction: 'US',
      congress: 119,
      identifier: 'H.R. 8800',
      status: 'reported',
      latestActionDate: '2026-09-10',
      sourceRevision: '2026-09-11T00:00:00.000Z',
      fundingBasis: 'not_applicable',
    },
  },
  revision: 1,
  createdByUserId: ctx.userId,
  updatedByUserId: ctx.userId,
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-01T00:00:00Z'),
};

const awardMember = {
  ...billMember,
  id: 'member-award',
  targetKind: 'award',
  targetId: 'award-1',
  label: 'Award 1',
  evidence: null,
};

function harness(members: readonly unknown[]) {
  const tx: any = {
    researchPortfolio: {
      findFirst: jest.fn(async () => ({
        id: portfolioId,
        tenantId: ctx.tenantId,
        revision: 9,
        lifecycle: 'active',
        grants: [{ role: 'viewer' }],
        clientLinks: [],
      })),
    },
    researchPortfolioMember: { findMany: jest.fn(async () => members) },
    // Any attempt by a bill to reach a funding source shows up here.
    programElementProject: { findFirst: jest.fn(async () => null) },
    $queryRawUnsafe: jest.fn(async () => []),
  };
  const prisma: any = { withTenant: jest.fn(async (_t: string, fn: any) => fn(tx)) };
  return { tx, prisma };
}

describe('bills in the Research Portfolio analytics projection', () => {
  it('reports a tracked bill as not applicable, with no funding reader call and no zero', async () => {
    const h = harness([billMember]);
    const defense = { observe: jest.fn(async () => []), read: jest.fn(async () => []) } as any;
    const service = new ResearchPortfolioAnalyticsService(h.prisma, defense);

    const projection = await service.analytics(ctx, portfolioId);

    expect(projection.contributions).toHaveLength(1);
    expect(projection.contributions[0]).toMatchObject({
      targetKind: 'federal_bill',
      targetId: '119-hr-8800',
      disposition: 'not_applicable',
      basis: null,
      value: null,
    });
    // Not a zero, and not a reader failure.
    expect(projection.totals).toEqual([]);
    expect(projection.contributions[0].disposition).not.toBe('unavailable');
    expect(projection.coverage.notApplicableMembers).toBe(1);
    expect(projection.coverage.unavailableMembers).toBe(0);
    expect(projection.limitations).toContain(
      'Tracked bills carry legislative status, not funding; they are not applicable to funding totals.',
    );
    // The bill never touched a funding source.
    expect(h.tx.programElementProject.findFirst).not.toHaveBeenCalled();
  });

  it('keeps "not applicable" distinct from "unavailable" in the same portfolio', async () => {
    const h = harness([billMember, awardMember]);
    const service = new ResearchPortfolioAnalyticsService(h.prisma, {} as any);

    const projection = await service.analytics(ctx, portfolioId);
    const byKind = new Map(projection.contributions.map((item) => [item.targetKind, item]));

    expect(byKind.get('federal_bill')?.disposition).toBe('not_applicable');
    expect(byKind.get('award')?.disposition).toBe('unavailable');
    expect(projection.coverage.notApplicableMembers).toBe(1);
    expect(projection.coverage.unavailableMembers).toBe(1);
  });

  it('excludes a bill that is not included from totals without calling it not applicable', async () => {
    const h = harness([{ ...billMember, disposition: 'candidate' }]);
    const service = new ResearchPortfolioAnalyticsService(h.prisma, {} as any);

    const projection = await service.analytics(ctx, portfolioId);

    expect(projection.contributions[0]).toMatchObject({ disposition: 'excluded', basis: null });
    expect(projection.coverage.notApplicableMembers).toBe(0);
    expect(projection.coverage.excludedContributions).toBe(1);
  });
});
