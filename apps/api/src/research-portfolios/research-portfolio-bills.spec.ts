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
  function service(
    currentCommitteeId: string | null,
    overrides: Record<string, unknown> = {},
  ) {
    const tx: any = {
      stateBill: {
        findUnique: jest.fn(async () => stateRow({ currentCommitteeId, ...overrides })),
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

  it('says a failed source check may be stale instead of implying no change', async () => {
    const h = service(null, {
      sourceCheckError: 'upstream timeout',
      sourceCheckStatus: 'failed',
      sourceCheckedAt: new Date('2026-10-28T06:00:00Z'),
    });
    const detail = await h.bills.detail({ tenantId: 't', userId: 'u' } as any, 'state_bill', 'CA-20252026-HB123');

    expect(detail.refreshFailed).toBe(true);
    expect(detail.refreshStatus).toBe('failed');
    expect(detail.refreshedAt).toBe('2026-10-28T06:00:00.000Z');
    expect(detail.coverage.note).toContain('most recent source check failed (failed)');
    expect(detail.coverage.note).toContain('may be stale');
    // Absence of change cannot be inferred from a failed check.
    expect(detail.coverage.note).toContain('cannot be relied on');
  });

  it('does not claim staleness when the last check succeeded', async () => {
    const h = service(null, {
      sourceCheckStatus: 'ok',
      sourceCheckedAt: new Date('2026-10-28T06:00:00Z'),
      sourceCheckError: null,
    });
    const detail = await h.bills.detail({ tenantId: 't', userId: 'u' } as any, 'state_bill', 'CA-20252026-HB123');

    expect(detail.refreshFailed).toBe(false);
    expect(detail.refreshStatus).toBe('ok');
    expect(detail.coverage.note).not.toContain('may be stale');
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

  /**
   * Models the real constraint, not a fixed answer:
   * `research_portfolio_events_idempotency_key` is UNIQUE (tenant_id, idempotency_key),
   * and the caller passes skipDuplicates. A mock that always returns 1 would hide
   * exactly the bug this suite exists to catch.
   */
  function client(members: unknown[]) {
    const seen = new Set<string>();
    const rows: any[] = [];
    const createMany = jest.fn(async ({ data, skipDuplicates }: any) => {
      let count = 0;
      for (const row of data) {
        const uniqueKey = `${row.tenantId}:${row.idempotencyKey}`;
        if (seen.has(uniqueKey)) {
          if (!skipDuplicates) throw new Error('unique violation: research_portfolio_events_idempotency_key');
          continue;
        }
        seen.add(uniqueKey);
        rows.push(row);
        count += 1;
      }
      return { count };
    });
    // The baseline cut-off is a real predicate, not decoration: a membership
    // created after the cutoff must not receive the change.
    const membersOf = (where: any) =>
      (members as any[]).filter(
        (member) =>
          !where?.createdAt?.lte ||
          member.createdAt == null ||
          member.createdAt.getTime() <= where.createdAt.lte.getTime(),
      );
    const prisma = {
      researchPortfolioMember: { findMany: jest.fn(async ({ where }: any) => membersOf(where)) },
      researchPortfolio: { findFirst: jest.fn().mockResolvedValue({ revision: 4, lifecycle: 'active' }) },
      researchPortfolioEvent: { createMany },
    } as any;
    return { prisma, rows, seen };
  }

  it('delivers once to every tracking portfolio when several share one tenant', async () => {
    const h = client([
      { tenantId: 'tenant-1', portfolioId: 'portfolio-1' },
      { tenantId: 'tenant-1', portfolioId: 'portfolio-2' },
      { tenantId: 'tenant-2', portfolioId: 'portfolio-3' },
    ]);
    const maintenance = { ...notice, tenantId: undefined };

    expect(await recordResearchPortfolioBillChanges(h.prisma, maintenance)).toBe(3);
    // Replay goes through the real unique key, so nothing more is written.
    expect(await recordResearchPortfolioBillChanges(h.prisma, maintenance)).toBe(0);

    expect(h.rows).toHaveLength(3);
    expect(h.rows.map((row) => `${row.tenantId}:${row.portfolioId}`).sort()).toEqual([
      'tenant-1:portfolio-1',
      'tenant-1:portfolio-2',
      'tenant-2:portfolio-3',
    ]);
    // Distinct per recipient, or the (tenant, key) unique would swallow the rest.
    expect(new Set(h.prisma.researchPortfolioEvent.createMany.mock.calls.flatMap((args: any) => [args[0].data[0].idempotencyKey])).size).toBe(3);
    expect(h.rows.every((row) => row.idempotencyKey.length <= 128)).toBe(true);
  });

  it('writes one bill_changed event per tracking portfolio with the source as actor', async () => {
    const { prisma } = client([
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
    });
    // bounded, deterministic and per portfolio
    expect(call[0].data[0].idempotencyKey).toMatch(
      /^legislation:federal_bill:status:[a-f0-9]{32}:portfolio-1$/,
    );
    expect(prisma.researchPortfolioEvent.createMany.mock.calls.every((args: any) => args[0].skipDuplicates)).toBe(true);
  });

  it('is idempotent: a replayed detection cycle writes nothing new', async () => {
    const { prisma } = client([{ tenantId: 'tenant-1', portfolioId: 'portfolio-1' }]);
    expect(await recordResearchPortfolioBillChanges(prisma, notice)).toBe(1);
    expect(await recordResearchPortfolioBillChanges(prisma, notice)).toBe(0);
  });

  it('keeps the initial baseline silent for a portfolio that added the bill afterwards', async () => {
    const { prisma } = client([]);
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
    const { prisma } = client([
      { tenantId: 'tenant-1', portfolioId: 'portfolio-1' },
      { tenantId: 'tenant-1', portfolioId: 'portfolio-2' },
    ]);
    expect(await recordResearchPortfolioBillChanges(prisma, notice)).toBe(2);
    const [query] = prisma.researchPortfolioMember.findMany.mock.calls[0];
    expect(query.where.tenantId).toBe('tenant-1');
  });

  it('never writes for a portfolio that no longer exists', async () => {
    const { prisma } = client([{ tenantId: 'tenant-1', portfolioId: 'gone' }]);
    prisma.researchPortfolio.findFirst.mockResolvedValue(null);
    expect(await recordResearchPortfolioBillChanges(prisma, notice)).toBe(0);
    expect(prisma.researchPortfolioEvent.createMany).not.toHaveBeenCalled();
  });

  // Reproduced defect: the state sweep passed its PREVIOUS CHECKPOINT as the
  // detection time, so a portfolio that started tracking inside the window was
  // treated as pre-existing history. The cutoff must be the change's own time.
  it('delivers to a membership created inside the sweep window but before the change', async () => {
    const { prisma } = client([
      { tenantId: 'tenant-1', portfolioId: 'portfolio-1', createdAt: new Date('2026-10-29T10:05:00Z') },
    ]);
    // previous checkpoint 10:00, membership 10:05, change detected 10:10
    const change = { ...notice, tenantId: 'tenant-1', detectedAt: new Date('2026-10-29T10:10:00Z') };
    expect(await recordResearchPortfolioBillChanges(prisma, change)).toBe(1);
  });

  it('stays silent for a membership created after the change', async () => {
    const { prisma } = client([
      { tenantId: 'tenant-1', portfolioId: 'portfolio-1', createdAt: new Date('2026-10-29T10:15:00Z') },
    ]);
    const change = { ...notice, tenantId: 'tenant-1', detectedAt: new Date('2026-10-29T10:10:00Z') };
    expect(await recordResearchPortfolioBillChanges(prisma, change)).toBe(0);
  });

  it('treats the epoch first-run checkpoint truthfully once the cutoff is the change time', async () => {
    const { prisma } = client([
      { tenantId: 'tenant-1', portfolioId: 'portfolio-1', createdAt: new Date('2026-10-29T10:05:00Z') },
    ]);
    // The sweep's `since` is the epoch on a first run; it is only a window bound.
    const epochCheckpoint = new Date(0);
    expect(epochCheckpoint.getTime()).toBeLessThan(
      new Date('2026-10-29T10:05:00Z').getTime(),
    );
    const change = { ...notice, tenantId: 'tenant-1', detectedAt: new Date('2026-10-29T10:10:00Z') };
    expect(await recordResearchPortfolioBillChanges(prisma, change)).toBe(1);
  });
});

describe('bill search predicates', () => {
  function harness(rows: { federal?: any[]; state?: any[] } = {}) {
    // Only the SEARCH query carries a `where`; the coverage read (distinct states)
    // does not, so it must never be mistaken for the search predicate.
    const calls: Record<string, any> = {};
    const tx: any = {
      congressBill: {
        findMany: jest.fn(async (args: any) => {
          calls.federal = args.where;
          const where = args.where ?? {};
          return (rows.federal ?? []).filter(
            (row) => where.congress == null || row.congress === where.congress,
          );
        }),
      },
      stateBill: {
        findMany: jest.fn(async (args: any) => {
          if (!args.where) return [{ state: 'CA' }];
          calls.state = args.where;
          return (rows.state ?? []).filter(
            (row) => args.where.state == null || row.state === args.where.state,
          );
        }),
      },
    };
    const prisma: any = { withTenant: jest.fn(async (_tenant: string, fn: any) => fn(tx)) };
    return { calls, tx, bills: new ResearchPortfolioBillsService(prisma) };
  }

  it('keeps the state session AND the search text as separate predicates', async () => {
    const h = harness();
    await h.bills.search({ tenantId: 't', userId: 'u' } as any, {
      q: 'HB 123',
      jurisdiction: 'CA',
      session: '2025-2026',
    });

    const where = h.calls.state;
    expect(where.state).toBe('CA');
    // Composed, not overwritten: session survives alongside the text search.
    expect(where.OR).toBeUndefined();
    expect(where.AND).toEqual([
      { OR: [{ session: '2025-2026' }, { sessionKey: '2025-2026' }] },
      {
        OR: expect.arrayContaining([
          { billNumber: 'HB123' },
          { identifier: { equals: 'HB 123', mode: 'insensitive' } },
        ]),
      },
    ]);
  });

  it('resolves a human federal number through canonical congress/type/number', async () => {
    const h = harness({ federal: [federalRow()] });
    const result = await h.bills.search({ tenantId: 't', userId: 'u' } as any, {
      q: 'H.R. 8800',
      jurisdiction: 'US',
      session: '119',
    });

    expect(h.calls.federal.congress).toBe(119);
    expect(h.calls.federal.OR).toEqual(
      expect.arrayContaining([{ billType: 'hr', billNumber: '8800' }]),
    );
    expect(result.items.map((item) => item.targetId)).toEqual(['119-hr-8800']);
  });

  it('scopes the canonical match to the requested Congress', async () => {
    const h = harness({
      federal: [federalRow(), federalRow({ id: '118-hr-8800', congress: 118 })],
    });
    const prior = await h.bills.search({ tenantId: 't', userId: 'u' } as any, {
      q: 'H.R. 8800',
      jurisdiction: 'US',
      session: '118',
    });

    expect(prior.items.map((item) => item.targetId)).toEqual(['118-hr-8800']);
  });

  it('finds a human bill number across Congresses when no Congress is supplied', async () => {
    // The actual frontend request shape: q + limit only, no session/congress.
    const h = harness({
      federal: [federalRow(), federalRow({ id: '118-hr-8800', congress: 118, title: 'Prior Congress version' })],
    });
    const result = await h.bills.search({ tenantId: 't', userId: 'u' } as any, {
      q: 'H.R. 8800',
      limit: 10,
    });

    expect(h.calls.federal.congress).toBeUndefined();
    // Matched on canonical fields — not on a synthesized "hr8800" id.
    expect(h.calls.federal.OR).toEqual(
      expect.arrayContaining([{ billType: 'hr', billNumber: '8800' }]),
    );
    // Both existing canonical rows come back, each with its own Congress.
    expect(result.items.map((item) => `${item.targetId}@${item.session}`).sort()).toEqual([
      '118-hr-8800@118',
      '119-hr-8800@119',
    ]);
  });

  it('does not read state bills for the federal jurisdiction token', async () => {
    const h = harness();
    await h.bills.search({ tenantId: 't', userId: 'u' } as any, {
      q: 'H.R. 8800',
      jurisdiction: 'US',
      session: '119',
    });

    // No state SEARCH predicate was issued; only the coverage read (no `where`).
    expect(h.calls.state).toBeUndefined();
    expect(h.tx.stateBill.findMany).toHaveBeenCalledTimes(1);
    expect(h.tx.stateBill.findMany.mock.calls[0][0].where).toBeUndefined();
  });
});
