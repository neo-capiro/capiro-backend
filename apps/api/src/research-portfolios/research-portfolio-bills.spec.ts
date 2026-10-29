import { readCanonicalResearchTarget } from './research-portfolio-targets.js';
import { recordResearchPortfolioBillChanges } from './research-portfolio-bill-changes.js';
import { ResearchPortfolioBillsService } from './research-portfolio-bills.service.js';

/**
 * Federal/state bill tracking as portfolio subjects.
 *
 * These assertions cover the parts that are cheap to get wrong and expensive to
 * get wrong in production: identity collisions across jurisdictions/sessions,
 * inventing a canonical bill for an unknown id, and duplicated or
 * pre-membership legislative events.
 */

function federalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '119-hr-8800',
    congress: 119,
    billType: 'hr',
    billNumber: '8800',
    title: 'Department of Defense Appropriations Act, 2027',
    status: 'introduced',
    statusAt: new Date('2026-09-01T00:00:00Z'),
    latestActionText: 'Referred to the Committee on Appropriations.',
    latestActionDate: new Date('2026-09-01T00:00:00Z'),
    originChamber: 'House',
    policyArea: 'Armed Forces and National Security',
    subjects: ['Defense'],
    sponsorName: 'Rep. Example',
    url: 'https://www.congress.gov/bill/119th-congress/house-bill/8800',
    updateDateIncludingText: new Date('2026-09-02T00:00:00Z'),
    lastSyncedAt: new Date('2026-09-03T00:00:00Z'),
    ...overrides,
  };
}

function stateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'CA-20252026-HB123',
    state: 'CA',
    session: '2025-2026',
    sessionKey: '20252026',
    billNumber: 'HB123',
    identifier: 'HB 123',
    title: 'Defense innovation procurement',
    chamber: 'House',
    status: 'committee',
    statusAt: new Date('2026-04-01T00:00:00Z'),
    latestActionText: 'Referred to committee.',
    latestActionDate: new Date('2026-04-01T00:00:00Z'),
    subjects: ['Procurement'],
    sponsorName: 'Assemblymember Example',
    stateUrl: 'https://leginfo.legislature.ca.gov/bill/hb123',
    url: null,
    statusDerivedAt: new Date('2026-04-02T00:00:00Z'),
    syncedAt: new Date('2026-04-02T00:00:00Z'),
    ...overrides,
  };
}

describe('research portfolio bill identity', () => {
  it('keeps the same federal bill number in two Congresses distinct', async () => {
    const rows = new Map([
      ['119-hr-8800', federalRow()],
      ['118-hr-8800', federalRow({ id: '118-hr-8800', congress: 118, title: 'Prior Congress version' })],
    ]);
    const tx: any = {
      congressBill: {
        findUnique: jest.fn(async ({ where }: any) => rows.get(where.id) ?? null),
      },
      capabilityBudgetLineMatch: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const current = await readCanonicalResearchTarget(tx, 'federal_bill' as any, '119-hr-8800');
    const prior = await readCanonicalResearchTarget(tx, 'federal_bill' as any, '118-hr-8800');

    expect(current?.id).toBe('119-hr-8800');
    expect(prior?.id).toBe('118-hr-8800');
    expect(current?.id).not.toBe(prior?.id);
    expect(current?.facts.congress).toBe(119);
    expect(prior?.facts.congress).toBe(118);
    // The identifier is humanized, but identity is congress + type + number.
    expect(current?.facts.identifier).toBe('H.R. 8800');
  });

  it('keeps identically numbered state bills in different jurisdictions and sessions distinct', async () => {
    const rows = new Map([
      ['CA-20252026-HB123', stateRow()],
      ['TX-20252026-HB123', stateRow({ id: 'TX-20252026-HB123', state: 'TX', identifier: 'HB 123' })],
      ['CA-20232024-HB123', stateRow({ id: 'CA-20232024-HB123', session: '2023-2024', sessionKey: '20232024' })],
    ]);
    const tx: any = {
      stateBill: { findUnique: jest.fn(async ({ where }: any) => rows.get(where.id) ?? null) },
    };

    const ca = await readCanonicalResearchTarget(tx, 'state_bill' as any, 'CA-20252026-HB123');
    const txBill = await readCanonicalResearchTarget(tx, 'state_bill' as any, 'TX-20252026-HB123');
    const priorSession = await readCanonicalResearchTarget(tx, 'state_bill' as any, 'CA-20232024-HB123');

    expect(new Set([ca?.id, txBill?.id, priorSession?.id]).size).toBe(3);
    expect(ca?.facts.jurisdiction).toBe('CA');
    expect(txBill?.facts.jurisdiction).toBe('TX');
    expect(priorSession?.facts.session).toBe('2023-2024');
    // Identical human identifiers must not be what distinguishes them.
    expect(ca?.facts.identifier).toBe(txBill?.facts.identifier);
  });

  it('records legislative facts and marks bills as having no funding basis', async () => {
    const tx: any = {
      stateBill: { findUnique: jest.fn().mockResolvedValue(stateRow()) },
    };
    const target = await readCanonicalResearchTarget(tx, 'state_bill' as any, 'CA-20252026-HB123');
    expect(target?.facts).toMatchObject({
      fundingBasis: 'not_applicable',
      status: 'committee',
      latestActionDate: '2026-04-01',
      sourceFamily: 'legiscan',
      sourceRevision: '2026-04-02T00:00:00.000Z',
    });
  });

  it('freezes the current committee referral with the membership', async () => {
    const tx: any = {
      stateBill: {
        findUnique: jest.fn().mockResolvedValue(stateRow({ currentCommitteeId: 'CA-lower-appropriations' })),
      },
    };
    const target = await readCanonicalResearchTarget(tx, 'state_bill' as any, 'CA-20252026-HB123');
    expect(target?.facts.currentCommitteeId).toBe('CA-lower-appropriations');
  });

  it('does not invent a canonical bill for an unknown identifier', async () => {
    const tx: any = {
      congressBill: { findUnique: jest.fn().mockResolvedValue(null) },
      stateBill: { findUnique: jest.fn().mockResolvedValue(null) },
      capabilityBudgetLineMatch: { findMany: jest.fn().mockResolvedValue([]) },
    };
    expect(await readCanonicalResearchTarget(tx, 'federal_bill' as any, '119-hr-99999')).toBeNull();
    expect(await readCanonicalResearchTarget(tx, 'state_bill' as any, 'WY-20252026-HB1')).toBeNull();
  });
});

describe('state bill detail: current committee referral', () => {
  function service(currentCommitteeId: string | null) {
    const tx: any = {
      stateBill: {
        findUnique: jest.fn(async () => stateRow({ currentCommitteeId })),
        findMany: jest.fn(async () => []),
      },
      stateBillSponsor: {
        findMany: jest.fn(async () => [
          { name: 'Assemblymember Example', party: 'D', sponsorType: 'Primary', sponsorOrder: 1 },
        ]),
      },
      stateBillVersion: { findMany: jest.fn(async () => []) },
      stateRollCallVote: { findMany: jest.fn(async () => []) },
      stateBillLink: { findMany: jest.fn(async () => []) },
      stateCommittee: {
        findUnique: jest.fn(async () => ({ name: 'Appropriations', chamber: 'lower' })),
      },
    };
    const prisma: any = { withTenant: jest.fn(async (_t: string, fn: any) => fn(tx)) };
    return { tx, prisma, bills: new ResearchPortfolioBillsService(prisma) };
  }

  it('reports the committee that holds the bill now, and does not call it unavailable', async () => {
    const h = service('CA-lower-appropriations');
    const detail = await h.bills.detail({ tenantId: 't', userId: 'u' } as any, 'state_bill', 'CA-20252026-HB123');

    expect(detail.committees).toEqual([
      { name: 'Appropriations', chamber: 'lower', role: 'referred' },
    ]);
    expect(detail.unavailable).not.toContain('committees');
    // Fields the source family genuinely does not carry stay labelled.
    expect(detail.unavailable).toContain('amendments');
    expect(h.tx.stateCommittee.findUnique).toHaveBeenCalledTimes(1);
  });

  it('claims unavailable only when the bill has no referral', async () => {
    const h = service(null);
    const detail = await h.bills.detail({ tenantId: 't', userId: 'u' } as any, 'state_bill', 'CA-20252026-HB123');

    expect(detail.committees).toEqual([]);
    expect(detail.unavailable).toContain('committees');
    expect(h.tx.stateCommittee.findUnique).not.toHaveBeenCalled();
  });
});

describe('portfolio bill change fan-out', () => {
  const notice = {
    tenantId: 'tenant-1',
    targetKind: 'federal_bill' as const,
    targetId: '119-hr-8800',
    changeType: 'status',
    label: 'Status changed',
    detail: 'Reported by the Committee on Appropriations.',
    actionDate: '2026-09-10',
    sourceUrl: 'https://www.congress.gov/bill/119th-congress/house-bill/8800',
    sourceLabel: 'Congress.gov',
    detectedAt: new Date('2026-09-10T12:00:00Z'),
  };

  function client(members: unknown[], createCount = 1) {
    return {
      researchPortfolioMember: { findMany: jest.fn().mockResolvedValue(members) },
      researchPortfolio: { findFirst: jest.fn().mockResolvedValue({ revision: 4, lifecycle: 'active' }) },
      researchPortfolioEvent: { createMany: jest.fn().mockResolvedValue({ count: createCount }) },
    } as any;
  }

  it('writes one bill_changed event per tracking portfolio with the source as actor', async () => {
    const prisma = client([
      { tenantId: 'tenant-1', portfolioId: 'portfolio-1' },
      { tenantId: 'tenant-1', portfolioId: 'portfolio-1' },
      { tenantId: 'tenant-1', portfolioId: 'portfolio-2' },
    ]);
    const written = await recordResearchPortfolioBillChanges(prisma, notice);

    expect(written).toBe(2);
    expect(prisma.researchPortfolioEvent.createMany).toHaveBeenCalledTimes(2);
    const [call] = prisma.researchPortfolioEvent.createMany.mock.calls;
    expect(call[0].data[0]).toMatchObject({
      tenantId: 'tenant-1',
      eventKind: 'bill_changed',
      actorKind: 'system',
      actorUserId: null,
      aggregateRevision: 4,
      idempotencyKey: 'legislation:federal_bill:119-hr-8800:status:2026-09-10',
    });
    expect(prisma.researchPortfolioEvent.createMany.mock.calls.every((args: any) => args[0].skipDuplicates)).toBe(true);
  });

  it('is idempotent: a replayed detection cycle writes nothing new', async () => {
    const prisma = client([{ tenantId: 'tenant-1', portfolioId: 'portfolio-1' }], 0);
    expect(await recordResearchPortfolioBillChanges(prisma, notice)).toBe(0);
  });

  it('keeps the initial baseline silent for a portfolio that added the bill afterwards', async () => {
    const prisma = client([]);
    expect(await recordResearchPortfolioBillChanges(prisma, notice)).toBe(0);
    // The membership query itself carries the baseline cut-off.
    const [query] = prisma.researchPortfolioMember.findMany.mock.calls[0];
    expect(query.where).toMatchObject({
      targetKind: 'federal_bill',
      targetId: '119-hr-8800',
      disposition: 'included',
      createdAt: { lte: notice.detectedAt },
    });
  });

  it('only fans out to portfolios of the reporting tenant', async () => {
    const prisma = client([{ tenantId: 'tenant-1', portfolioId: 'portfolio-1' }]);
    await recordResearchPortfolioBillChanges(prisma, notice);
    const [query] = prisma.researchPortfolioMember.findMany.mock.calls[0];
    expect(query.where.tenantId).toBe('tenant-1');
  });

  it('never writes for a portfolio that no longer exists', async () => {
    const prisma = client([{ tenantId: 'tenant-1', portfolioId: 'gone' }]);
    prisma.researchPortfolio.findFirst.mockResolvedValue(null);
    expect(await recordResearchPortfolioBillChanges(prisma, notice)).toBe(0);
    expect(prisma.researchPortfolioEvent.createMany).not.toHaveBeenCalled();
  });
});
