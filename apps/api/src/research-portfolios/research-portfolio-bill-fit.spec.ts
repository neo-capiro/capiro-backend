import { ResearchPortfolioPhase11Service } from './research-portfolio-phase11.service.js';

/**
 * Fit for a portfolio that tracks bills (requirements 4 and 14e).
 *
 * A bill is not a capability/PE subject, so it must be *excluded* from fit rather than
 * scored as zero or described as missing evidence. The score must be null (insufficient
 * evidence), never 0/100, and the limitation must say why.
 */
const ctx: any = { tenantId: 'tenant-fit', userId: 'actor-fit', role: 'standard_user' };
const portfolioId = 'portfolio-fit';

const billMember = {
  id: 'member-bill',
  tenantId: ctx.tenantId,
  portfolioId,
  targetKind: 'federal_bill',
  targetId: '119-hr-8800',
  label: 'H.R. 8800',
  disposition: 'included',
  origin: 'manual',
  qualification: null,
  revision: 2,
  evidence: { facts: { status: 'reported' } },
};

function harness(options: { clientLinks?: readonly unknown[] } = {}) {
  const tx: any = {
    researchPortfolio: {
      findFirst: jest.fn(async () => ({
        id: portfolioId,
        tenantId: ctx.tenantId,
        revision: 5,
        lifecycle: 'active',
        grants: [{ role: 'viewer' }],
        clientLinks: options.clientLinks ?? [],
      })),
    },
    researchPortfolioMember: { findMany: jest.fn(async () => [billMember]) },
    researchPortfolioRuleVersion: { findMany: jest.fn(async () => []) },
    programElement: { findUnique: jest.fn(async () => null) },
    client: { findFirst: jest.fn(async () => ({ id: 'client-a', name: 'Client A' })) },
    clientCapability: { findMany: jest.fn(async () => []) },
    $queryRawUnsafe: jest.fn(async () => [{ allowed: true }]),
    researchPortfolioFitVersion: {
      createMany: jest.fn(async () => ({ count: 1 })),
      findUnique: jest.fn(async () => ({ id: 'fit-1', createdAt: new Date('2026-10-29T00:00:00Z') })),
    },
  };
  const prisma: any = { withTenantUser: jest.fn(async (_t: string, _u: string, fn: any) => fn(tx)) };
  return { tx, prisma };
}

describe('fit with tracked bills', () => {
  it('excludes a bill from the score, reports null fit and says why', async () => {
    const h = harness({ clientLinks: [{ clientId: 'client-a' }] });
    const service = new ResearchPortfolioPhase11Service(
      h.prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const fit = await service.getFit(ctx, portfolioId);

    expect(fit.clientFits).toHaveLength(1);
    const client = fit.clientFits[0] as any;
    // Not scored as zero: insufficient evidence is null.
    expect(client.fitScore).toBeNull();
    expect(client.availability).toBe('unavailable');
    expect(client.memberMatches[0]).toMatchObject({
      targetKind: 'federal_bill',
      matched: null,
    });
    expect(client.memberMatches[0].reasons).toContain('bill_has_no_capability_pe_basis');
    expect(client.memberMatches[0].reasons).not.toContain(
      'target_kind_not_supported_by_direct_pe_basis',
    );
    expect(fit.limitations).toContain(
      'Tracked bills are legislative subjects with no capability/PE basis; they are excluded from the fit score rather than scored as zero.',
    );
    // No capability PE matching was attempted for the bill.
    expect(h.tx.clientCapability.findMany).toHaveBeenCalled();
    expect(client.basis.supportedMemberCount).toBe(0);
  });

  it('stays honest with no linked client: no fit is invented', async () => {
    const h = harness({ clientLinks: [] });
    const service = new ResearchPortfolioPhase11Service(
      h.prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const fit = await service.getFit(ctx, portfolioId);

    expect(fit.clientFits).toEqual([]);
    expect(fit.availability).toBe('unavailable');
    expect(fit.limitations).toContain(
      'Tracked bills are legislative subjects with no capability/PE basis; they are excluded from the fit score rather than scored as zero.',
    );
  });
});
