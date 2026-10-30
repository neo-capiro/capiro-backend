import {
  classifyChange,
  selectMaterialEvents,
  TrackerChangeDetectorService,
  type ActionLike,
} from './tracker-change-detector.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

const d = (s: string) => new Date(s);

describe('classifyChange', () => {
  it('classifies enactment / president / failure as critical', () => {
    expect(classifyChange('Became Public Law No: 119-42.')?.severity).toBe('critical');
    expect(classifyChange('Presented to President.')?.changeType).toBe('bill_to_president');
    expect(classifyChange('Failed of passage in Senate.')?.changeType).toBe('bill_failed');
    expect(classifyChange('Vetoed by President.')?.changeType).toBe('bill_failed');
    expect(classifyChange('Motion to table the bill agreed to.')?.changeType).toBe('bill_failed');
  });
  it('GAI-07: procedural failures / veto threats are NOT bill failure', () => {
    // The old bare /failed|rejected|veto|tabled/ classified all of these as a
    // CRITICAL "Failed / rejected" alert (which fans out to email/SMS).
    expect(classifyChange('Motion to recommit failed by voice vote.')?.changeType).not.toBe(
      'bill_failed',
    );
    expect(
      classifyChange('Cloture motion rejected by Yea-Nay Vote. 55 - 45.')?.changeType,
    ).not.toBe('bill_failed');
    expect(classifyChange('Amendment SA 2871 failed of adoption.')?.changeType).not.toBe(
      'bill_failed',
    );
    // Passage text mentioning a veto THREAT must classify as passage, not failure.
    expect(
      classifyChange('Passed House 220-210; the White House has issued a veto threat.')?.changeType,
    ).toBe('bill_passed_chamber');
    // Ambiguous tabling (of what?) produces NO critical alert.
    expect(classifyChange('Motion to table agreed to.')).toBeNull();
  });
  it('classifies floor / committee / amendment as notable', () => {
    expect(classifyChange('Passed/agreed to in House')?.triggerKey).toBe('floorVote');
    expect(classifyChange('Ordered to be Reported')?.triggerKey).toBe('committeeVote');
    expect(classifyChange('House Amendment offered')?.triggerKey).toBe('amendment');
  });
  it('classifies hearings as info', () => {
    expect(classifyChange('Subcommittee Hearing Held.')?.severity).toBe('info');
  });
  it('classifies House Rules Committee activity as a floor-scheduled rule', () => {
    const a = classifyChange(
      'Rules Committee Resolution H. Res. 1234 Reported to House. Rule provides for consideration of H.R. 5009.',
    );
    expect(a?.changeType).toBe('bill_rule_reported');
    expect(a?.triggerKey).toBe('floorVote');
    expect(a?.severity).toBe('notable');
    expect(classifyChange('Considered under the provisions of H. Res. 1234.')?.changeType).toBe(
      'bill_rule_reported',
    );
    expect(
      classifyChange('Pursuant to the provisions of H. Res. 1234, the House resolved.')?.changeType,
    ).toBe('bill_rule_reported');
  });
  it('does not mislabel a committee-of-jurisdiction report or a combined passage', () => {
    // A real committee report (not Rules) stays a committee report.
    expect(
      classifyChange('Reported to House by the Committee on Armed Services. H. Rept. 119-100.')
        ?.changeType,
    ).toBe('bill_reported');
    // Floor passage wins even when the action also cites the rule.
    expect(
      classifyChange('Considered under the provisions of H. Res. 1234. Passed/agreed to in House.')
        ?.changeType,
    ).toBe('bill_passed_chamber');
  });
  it('returns null for routine procedural churn', () => {
    expect(classifyChange('Introduced in House.')).toBeNull();
    expect(classifyChange('Referred to the Committee on Armed Services.')).toBeNull();
    expect(classifyChange('Motion to reconsider laid on the table Agreed to.')).toBeNull();
    expect(classifyChange('')).toBeNull();
    expect(classifyChange(null)).toBeNull();
  });
});

describe('selectMaterialEvents', () => {
  it('returns one event per distinct changeType, chronological', () => {
    const actions: ActionLike[] = [
      { date: d('2026-06-10'), text: 'Subcommittee Hearing Held.' },
      { date: d('2026-06-15'), text: 'Ordered to be Reported by the Yeas and Nays.' },
      { date: d('2026-06-20'), text: 'Passed/agreed to in House.' },
    ];
    const events = selectMaterialEvents(actions, {
      date: d('2026-06-20'),
      text: 'Passed/agreed to in House.',
    });
    expect(events.map((e) => e.cls.triggerKey)).toEqual(['hearing', 'committeeVote', 'floorVote']);
  });

  it('de-dupes repeated changeTypes (keeps the earliest)', () => {
    const actions: ActionLike[] = [
      { date: d('2026-06-10'), text: 'House Amendment offered by Mr. A.' },
      { date: d('2026-06-11'), text: 'House Amendment offered by Mr. B.' },
    ];
    const events = selectMaterialEvents(actions, null);
    expect(events).toHaveLength(1);
    expect(events[0]?.cls.triggerKey).toBe('amendment');
    expect(events[0]?.text).toContain('Mr. A');
  });

  it('skips routine actions, keeps only material ones', () => {
    const actions: ActionLike[] = [
      { date: d('2026-06-10'), text: 'Introduced in House.' },
      { date: d('2026-06-12'), text: 'Referred to committee.' },
      { date: d('2026-06-14'), text: 'Passed the House.' },
    ];
    const events = selectMaterialEvents(actions, null);
    expect(events).toHaveLength(1);
    expect(events[0]?.cls.triggerKey).toBe('floorVote');
  });

  it('merges the rollup latest action even when not in the action rows (no regression)', () => {
    const events = selectMaterialEvents([], {
      date: d('2026-06-20'),
      text: 'Became Public Law No: 119-1.',
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.cls.changeType).toBe('bill_enacted');
  });

  it('does not duplicate the latest action when it is already an action row', () => {
    const actions: ActionLike[] = [{ date: d('2026-06-20'), text: 'Passed the House.' }];
    const events = selectMaterialEvents(actions, {
      date: d('2026-06-20'),
      text: 'Passed the House.',
    });
    expect(events).toHaveLength(1);
  });

  it('returns nothing when there is no material move', () => {
    expect(selectMaterialEvents([{ date: d('2026-06-10'), text: 'Introduced.' }], null)).toEqual(
      [],
    );
  });
});

describe('portfolio-only federal recipients (reachability)', () => {
  // Reproduced defect: runDetectionCycle read only legacy trackedBill rows and
  // returned early when there were none, so a federal bill tracked ONLY by a
  // Research Portfolio had no detection path at all. The fix keeps this detector
  // as the single source owner: no trackedBill row is fabricated, no client or
  // notification context is read, and each fan-out is scoped to its own tenant.
  function harness(opts: {
    members: Array<{
      tenantId: string;
      portfolioId: string;
      targetId: string;
      createdAt: Date;
    }>;
    bill: Record<string, unknown>;
    tracked?: unknown[];
  }) {
    const events: any[] = [];
    const seen = new Set<string>();
    const tx: any = {
      trackedBill: { findMany: jest.fn(async () => opts.tracked ?? []) },
      researchPortfolioMember: {
        findMany: jest.fn(async (args: any) => {
          const where = args?.where ?? {};
          return opts.members.filter(
            (member) =>
              (where.tenantId == null || member.tenantId === where.tenantId) &&
              (where.createdAt?.lte == null ||
                member.createdAt.getTime() <= where.createdAt.lte.getTime()),
          );
        }),
      },
      congressBill: { findMany: jest.fn(async () => [opts.bill]) },
      researchPortfolio: {
        findFirst: jest.fn(async () => ({ revision: 3, lifecycle: 'active' })),
      },
      researchPortfolioEvent: {
        // Mirrors research_portfolio_events_idempotency_key: UNIQUE (tenantId,
        // idempotencyKey). Replay therefore inserts nothing.
        createMany: jest.fn(async ({ data, skipDuplicates }: any) => {
          let count = 0;
          for (const row of data) {
            const key = `${row.tenantId}:${row.idempotencyKey}`;
            if (seen.has(key)) {
              if (!skipDuplicates) throw new Error('unique violation');
              continue;
            }
            seen.add(key);
            events.push(row);
            count += 1;
          }
          return { count };
        }),
      },
    };
    const prisma: any = {
      withSystem: jest.fn((fn: (tx: unknown) => unknown) => fn(tx)),
      withTenant: jest.fn(),
      // The bill catalog read is a plain client call, not a tenant transaction.
      congressBill: tx.congressBill,
    };
    const alerts = { fanOut: jest.fn() };
    const config = { get: jest.fn(() => false) };
    const summaries = { summarize: jest.fn() };
    const svc = new TrackerChangeDetectorService(
      prisma as unknown as PrismaService,
      alerts as never,
      {} as never,
      config as never,
      summaries as never,
    );
    return { svc, tx, prisma, alerts, events };
  }

  const bill = {
    id: '119-hr-8800',
    title: 'Department of Defense Appropriations Act, 2027',
    latestActionText: 'Passed/agreed to in House',
    latestActionDate: d('2026-09-10'),
    url: 'https://www.congress.gov/bill/119th-congress/house-bill/8800',
    subjects: ['Defense'],
    policyArea: 'Armed Forces and National Security',
  };

  it('establishes a silent baseline for a membership whose bill has not moved since', async () => {
    const h = harness({
      members: [
        {
          tenantId: 'tenant-a',
          portfolioId: 'portfolio-a',
          targetId: '119-hr-8800',
          createdAt: d('2026-10-01T00:00:00Z'),
        },
      ],
      bill: { ...bill, latestActionDate: d('2026-09-10') },
    });

    const result = await h.svc.runDetectionCycle();

    expect(h.tx.researchPortfolioMember.findMany).toHaveBeenCalled();
    expect(result.scanned).toBe(1);
    expect(result.baseline).toBe(1);
    expect(result.changed).toBe(0);
    expect(h.events).toHaveLength(0);
    // No client delivery, no client/user context, no trackedBill fabrication.
    expect(h.alerts.fanOut).not.toHaveBeenCalled();
    expect(h.prisma.withTenant).not.toHaveBeenCalled();
    expect(h.tx.researchPortfolioMember.findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.anything() }),
    );
  });

  it('delivers the next eligible material change to a portfolio-only member', async () => {
    const h = harness({
      members: [
        {
          tenantId: 'tenant-a',
          portfolioId: 'portfolio-a',
          targetId: '119-hr-8800',
          createdAt: d('2026-10-01T00:00:00Z'),
        },
      ],
      // The move is dated AFTER the portfolio adopted the bill (adoption is the
      // baseline; a later move is the eligible change).
      bill: { ...bill, latestActionDate: d('2026-10-05') },
    });

    const result = await h.svc.runDetectionCycle();

    expect(result.changed).toBe(1);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      tenantId: 'tenant-a',
      portfolioId: 'portfolio-a',
      eventKind: 'bill_changed',
      actorKind: 'system',
      actorUserId: null,
    });
    expect(h.alerts.fanOut).not.toHaveBeenCalled();
    expect(h.prisma.withTenant).not.toHaveBeenCalled();
  });

  it('does not hand an old change to a portfolio added after it', async () => {
    // Reproduced defect: grouping by tenant+bill on the EARLIEST membership let a
    // later portfolio receive the same historical event, because the shared
    // fan-out cutoff was the cycle time rather than the change's own time.
    const members = [
      {
        tenantId: 'tenant-a',
        portfolioId: 'original-portfolio',
        targetId: '119-hr-8800',
        createdAt: d('2026-10-01T00:00:00Z'),
      },
    ];
    const h = harness({
      members,
      // The move happened on Oct 10, after the original portfolio adopted the bill.
      bill: { ...bill, latestActionDate: d('2026-10-10') },
    });

    const first = await h.svc.runDetectionCycle();
    expect(first.changed).toBe(1);
    expect(h.events.map((event) => event.portfolioId)).toEqual(['original-portfolio']);

    // A second portfolio joins on Oct 20 — after the change.
    members.push({
      tenantId: 'tenant-a',
      portfolioId: 'later-portfolio',
      targetId: '119-hr-8800',
      createdAt: d('2026-10-20T00:00:00Z'),
    });
    const second = await h.svc.runDetectionCycle();

    expect(second.changed).toBe(0);
    expect(h.events.map((event) => event.portfolioId)).toEqual(['original-portfolio']);

    // A genuinely new move (Oct 25) reaches both — the later portfolio is not
    // permanently excluded, it just misses the change that predates it.
    h.tx.congressBill.findMany.mockResolvedValue([
      { ...bill, latestActionDate: d('2026-10-25') },
    ]);
    const third = await h.svc.runDetectionCycle();

    expect(third.changed).toBe(1);
    // Both portfolios now hold the Oct 25 change (the Oct 10 event stays only with
    // the portfolio that already existed when it happened).
    const oct25 = h.events.filter((event) => event.payload.actionDate === '2026-10-25');
    expect(oct25.map((event) => event.portfolioId).sort()).toEqual([
      'later-portfolio',
      'original-portfolio',
    ]);
  });

  it('scopes each tenant to its own portfolios', async () => {
    const h = harness({
      members: [
        {
          tenantId: 'tenant-a',
          portfolioId: 'portfolio-a',
          targetId: '119-hr-8800',
          createdAt: d('2026-10-01T00:00:00Z'),
        },
        {
          tenantId: 'tenant-b',
          portfolioId: 'portfolio-b',
          targetId: '119-hr-8800',
          createdAt: d('2026-10-01T00:00:00Z'),
        },
      ],
      bill: { ...bill, latestActionDate: d('2026-10-05') },
    });

    await h.svc.runDetectionCycle();

    // Each event belongs to the tenant whose portfolio tracks the bill —
    // tenant-b never inherits tenant-a's portfolio or its client context.
    expect(h.events).toHaveLength(2);
    expect(h.events.map((event) => `${event.tenantId}:${event.portfolioId}`).sort()).toEqual([
      'tenant-a:portfolio-a',
      'tenant-b:portfolio-b',
    ]);
    expect(h.prisma.withTenant).not.toHaveBeenCalled();
  });
});

describe('intelOwnedTenantIds — RLS double-send guard (regression)', () => {
  // Once intel_full_rls_hold FORCE-enables RLS on intel_feature_flag, a bare
  // read on apps/api's connection (no GUC) returns 0 rows → apps/api would think
  // NO tenant is intel-owned and DOUBLE-SEND bill alerts. This must run under
  // withSystem (bypass) so it reads all rows regardless of tenant context.
  it('reads intel_feature_flag via prisma.withSystem, not a bare query', async () => {
    const withSystem = jest.fn((fn: (tx: unknown) => unknown) =>
      fn({ $queryRawUnsafe: async () => [{ tenant_id: 't1' }, { tenant_id: 't2' }] }),
    );
    const bareQuery = jest.fn();
    const prisma = { withSystem, $queryRawUnsafe: bareQuery } as unknown as PrismaService;
    const svc = new TrackerChangeDetectorService(
      prisma,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const owned = await (
      svc as unknown as { intelOwnedTenantIds(): Promise<Set<string>> }
    ).intelOwnedTenantIds();

    expect(withSystem).toHaveBeenCalledTimes(1);
    expect(bareQuery).not.toHaveBeenCalled(); // never a bare, RLS-blankable read
    expect(owned).toEqual(new Set(['t1', 't2']));
  });
});
