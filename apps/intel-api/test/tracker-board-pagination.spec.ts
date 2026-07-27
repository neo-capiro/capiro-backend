import { TrackerBoardService } from '../src/tracker/tracker-board.service.js';

/**
 * Gate E phase a (P1-18) — the board was unbounded (no `take`) and the
 * per-client watchlist compile for the all-clients roll-up scaled with client
 * count. This file locks: keyset pagination is total (no skipped/repeated rows,
 * including an identical-trackedAt tiebreak), `hasMore`/`total`/`withheld` are
 * honest, filters are index-friendly and default-off, and the tenant board's
 * query count is CONSTANT in client count (the a-6 fix).
 *
 * The fake prisma tx below actually APPLIES the where-clause shapes
 * getBoard/getTenantBoard emit (clientId, billId.in, stage.in/.not, and the
 * keyset OR) against an in-memory row array — a canned fixture cannot exercise
 * pagination logic, only a real (if tiny) filter/sort/slice can.
 */

const TENANT = 'tenant-pg';

interface FakeBillRow {
  billId: string;
  clientId: string;
  stage: string;
  trackedAt: Date;
  note: string | null;
  isManual: boolean;
  unread: boolean;
  lastSeenActionText: string | null;
  lastSeenActionDate: Date | null;
  lastHearingSessionId: string | null;
  lastHearingAt: Date | null;
}
interface FakeAlertRow {
  sourceRef: string;
  clientId: string;
  sourceType: string;
  createdAt: Date;
}

const BASE_MS = new Date('2026-01-01T00:00:00Z').getTime();

/** `n` rows, newest (index 0) first — bill-0000's trackedAt is the latest. */
function makeRows(n: number, clientId = 'client-1', offsetMs = 0): FakeBillRow[] {
  return Array.from({ length: n }, (_, i) => ({
    billId: `bill-${clientId}-${String(i).padStart(4, '0')}`,
    clientId,
    stage: 'introduced',
    trackedAt: new Date(BASE_MS - offsetMs - i * 1000),
    note: null,
    isManual: true,
    unread: false,
    lastSeenActionText: null,
    lastSeenActionDate: null,
    lastHearingSessionId: null,
    lastHearingAt: null,
  }));
}

function matchesWhere(row: FakeBillRow, where: Record<string, unknown>): boolean {
  if (where['clientId'] && row.clientId !== where['clientId']) return false;
  const billIdIn = (where['billId'] as { in?: string[] } | undefined)?.in;
  if (billIdIn && !billIdIn.includes(row.billId)) return false;
  const clientIdIn = (where['clientId'] as { in?: string[] } | undefined)?.in;
  if (clientIdIn && !clientIdIn.includes(row.clientId)) return false;
  const stageIn = (where['stage'] as { in?: string[] } | undefined)?.in;
  if (stageIn && !stageIn.includes(row.stage)) return false;
  const stageNot = (where['stage'] as { not?: string } | undefined)?.not;
  if (stageNot && row.stage === stageNot) return false;
  const or = where['OR'] as
    | [{ trackedAt: { lt: Date } }, { trackedAt: Date; billId: { lt: string } }]
    | undefined;
  if (or) {
    const passLt = row.trackedAt.getTime() < or[0].trackedAt.lt.getTime();
    const passEq =
      row.trackedAt.getTime() === or[1].trackedAt.getTime() && row.billId < or[1].billId.lt;
    if (!(passLt || passEq)) return false;
  }
  return true;
}

function sortRows(rows: FakeBillRow[]): FakeBillRow[] {
  return [...rows].sort(
    (a, b) => b.trackedAt.getTime() - a.trackedAt.getTime() || (a.billId < b.billId ? 1 : -1),
  );
}

/** Counts calls per prisma "table.method" — the a-6 constant-query-count lock reads this. */
function makeHarness(rows: FakeBillRow[], alerts: FakeAlertRow[] = []) {
  const calls: Record<string, number> = {};
  const tick = (k: string) => (calls[k] = (calls[k] ?? 0) + 1);

  const tx = {
    trackedBill: {
      findMany: async (args: { where: Record<string, unknown>; take?: number }) => {
        tick('trackedBill.findMany');
        const filtered = sortRows(rows.filter((r) => matchesWhere(r, args.where)));
        return args.take ? filtered.slice(0, args.take) : filtered;
      },
      count: async (args: { where: Record<string, unknown> }) => {
        tick('trackedBill.count');
        return rows.filter((r) => matchesWhere(r, args.where)).length;
      },
    },
    intelAlert: {
      findMany: async (args: {
        where: { clientId?: string; sourceType?: { in: string[] }; createdAt?: { gte: Date } };
        distinct?: string[];
      }) => {
        tick('intelAlert.findMany');
        const cutoff = args.where.createdAt?.gte;
        let out = alerts.filter(
          (a) =>
            (!args.where.clientId || a.clientId === args.where.clientId) &&
            (!cutoff || a.createdAt.getTime() >= cutoff.getTime()),
        );
        if (args.distinct) {
          const seen = new Set<string>();
          out = out.filter((a) => (seen.has(a.sourceRef) ? false : (seen.add(a.sourceRef), true)));
        }
        return out.map((a) => ({
          sourceRef: a.sourceRef,
          clientId: a.clientId,
          changeType: null,
          title: 'x',
          createdAt: a.createdAt,
          severity: null,
        }));
      },
      groupBy: async () => {
        tick('intelAlert.groupBy');
        return [] as Array<{ sourceRef: string; clientId: string; _count: { _all: number } }>;
      },
    },
    watchlist: {
      findMany: async () => {
        tick('watchlist.findMany');
        return [] as Array<{ clientId: string; issueAreas: string[] }>;
      },
    },
    watchlistTopic: {
      findMany: async () => {
        tick('watchlistTopic.findMany');
        return [] as Array<{
          id: string;
          watchlistId: string;
          label: string;
          issueArea: string | null;
          position: string;
          priority: string;
        }>;
      },
    },
    watchlistTerm: {
      findMany: async () => {
        tick('watchlistTerm.findMany');
        return [] as Array<{
          watchlistId: string;
          topicId: string | null;
          termType: string;
          value: string;
          weight: number;
          id: string;
        }>;
      },
    },
  };
  const prisma = { withTenant: async (_t: string, fn: (t: unknown) => unknown) => fn(tx) } as never;
  const repo = {
    fetchRecommendationBills: async (ids: string[]) => {
      tick('repo.fetchRecommendationBills');
      return ids.map((id) => ({
        id,
        title: `Title ${id}`,
        latestActionText: null,
        latestActionDate: null,
        policyArea: null,
        subjects: [],
      }));
    },
    getClientNames: async () => {
      tick('repo.getClientNames');
      return new Map<string, string>();
    },
  } as never;
  const watchlists = {
    getCompiled: async () => {
      tick('watchlists.getCompiled');
      return {
        issueAreas: [],
        billMatchSet: [],
        hearingTerms: [],
        deepgramKeyterms: [],
        jurisdictions: [],
        termSurfaces: {},
      };
    },
  } as never;
  const stateRepo = { getStateBillsByIds: async () => [] } as never;
  return {
    svc: new TrackerBoardService(prisma, repo, watchlists, stateRepo),
    calls,
    totalCalls: () => Object.values(calls).reduce((n, v) => n + v, 0),
  };
}

describe('TrackerBoardService — getTenantBoard pagination (P1-18)', () => {
  it('a-8.1: 250 tracked bills, default limit -> 200 cards, hasMore true, total 250, withheld 50', async () => {
    const h = makeHarness(makeRows(250));
    const res = await h.svc.getTenantBoard(TENANT);
    const cardCount = res.columns.reduce((n, c) => n + c.cards.length, 0);
    expect(cardCount).toBe(200);
    expect(res.hasMore).toBe(true);
    expect(res.total).toBe(250);
    expect(res.withheld).toBe(50);
    expect(res.nextCursor).not.toBeNull();
  });

  it('a-8.2: following nextCursor returns the remaining 50 with no overlap and hasMore false', async () => {
    const h = makeHarness(makeRows(250));
    const page1 = await h.svc.getTenantBoard(TENANT);
    const page2 = await h.svc.getTenantBoard(TENANT, { cursor: page1.nextCursor! });

    const ids1 = new Set(page1.columns.flatMap((c) => c.cards.map((x) => x.billId)));
    const ids2 = page2.columns.flatMap((c) => c.cards.map((x) => x.billId));
    expect(ids2).toHaveLength(50);
    for (const id of ids2) expect(ids1.has(id)).toBe(false); // set-disjointness
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBeNull();
  });

  it('a-8.3: two bills with an IDENTICAL trackedAt are both returned exactly once across two pages (billId tiebreak)', async () => {
    const tied = new Date(BASE_MS);
    const rows: FakeBillRow[] = [
      { billId: 'bill-aaaa', clientId: 'client-1', stage: 'introduced', trackedAt: tied, note: null, isManual: true, unread: false, lastSeenActionText: null, lastSeenActionDate: null, lastHearingSessionId: null, lastHearingAt: null },
      { billId: 'bill-bbbb', clientId: 'client-1', stage: 'introduced', trackedAt: tied, note: null, isManual: true, unread: false, lastSeenActionText: null, lastSeenActionDate: null, lastHearingSessionId: null, lastHearingAt: null },
      ...makeRows(3, 'client-1', 10_000), // 3 rows older than the tied pair (positive offset = further in the past)
    ];
    const h = makeHarness(rows);
    const page1 = await h.svc.getTenantBoard(TENANT, { limit: 2 });
    expect(page1.hasMore).toBe(true);
    const page2 = await h.svc.getTenantBoard(TENANT, { cursor: page1.nextCursor!, limit: 2 });

    const allIds = [
      ...page1.columns.flatMap((c) => c.cards.map((x) => x.billId)),
      ...page2.columns.flatMap((c) => c.cards.map((x) => x.billId)),
    ];
    expect(allIds.filter((id) => id === 'bill-aaaa')).toHaveLength(1);
    expect(allIds.filter((id) => id === 'bill-bbbb')).toHaveLength(1);
  });

  it('a-8.4 (a-6 lock): query count is CONSTANT in client count — 1 client and 50 clients issue the same number of queries', async () => {
    const h1 = makeHarness(makeRows(5, 'client-1'));
    await h1.svc.getTenantBoard(TENANT);

    const manyRows = Array.from({ length: 50 }, (_, i) => makeRows(1, `client-${i}`, i * 1000)).flat();
    const h50 = makeHarness(manyRows);
    await h50.svc.getTenantBoard(TENANT);

    expect(h50.totalCalls()).toBe(h1.totalCalls());
    // Specifically: the batched compile is 3 queries total, not 3-per-client.
    expect(h50.calls['watchlistTopic.findMany']).toBe(1);
    expect(h50.calls['watchlistTerm.findMany']).toBe(1);
    expect(h50.calls['watchlist.findMany']).toBe(1);
    expect(h50.calls['watchlists.getCompiled']).toBeUndefined();
  });

  it('a-8.5: changedWithinDays excludes a bill whose only alert is 30 days old; omitting it includes that bill (default-off)', async () => {
    const rows = makeRows(2);
    const recentId = rows[0]!.billId; // newest
    const oldId = rows[1]!.billId;
    const alerts: FakeAlertRow[] = [
      { sourceRef: recentId, clientId: 'client-1', sourceType: 'bill', createdAt: new Date(Date.now() - 2 * 86_400_000) },
      { sourceRef: oldId, clientId: 'client-1', sourceType: 'bill', createdAt: new Date(Date.now() - 30 * 86_400_000) },
    ];
    const h = makeHarness(rows, alerts);

    const filtered = await h.svc.getTenantBoard(TENANT, { filters: { changedWithinDays: 7 } });
    const filteredIds = filtered.columns.flatMap((c) => c.cards.map((x) => x.billId));
    expect(filteredIds).toEqual([recentId]);

    const h2 = makeHarness(rows, alerts);
    const unfiltered = await h2.svc.getTenantBoard(TENANT);
    const unfilteredIds = unfiltered.columns.flatMap((c) => c.cards.map((x) => x.billId));
    expect(unfilteredIds.sort()).toEqual([recentId, oldId].sort());
  });

  it('a-8.6: activeOnly excludes an enacted bill; default includes it', async () => {
    const rows = makeRows(2);
    rows[0]!.stage = 'enacted';
    const h = makeHarness(rows);

    const active = await h.svc.getTenantBoard(TENANT, { filters: { activeOnly: true } });
    const activeIds = active.columns.flatMap((c) => c.cards.map((x) => x.billId));
    expect(activeIds).toEqual([rows[1]!.billId]);

    const h2 = makeHarness(rows);
    const all = await h2.svc.getTenantBoard(TENANT);
    expect(all.columns.flatMap((c) => c.cards.map((x) => x.billId))).toHaveLength(2);
  });

  it('a-8.0: a tenant with 0 tracked bills returns total 0, hasMore false, withheld 0, no cursor', async () => {
    const h = makeHarness([]);
    const res = await h.svc.getTenantBoard(TENANT);
    expect(res).toMatchObject({ total: 0, hasMore: false, withheld: 0, nextCursor: null });
    expect(res.columns.every((c) => c.cards.length === 0)).toBe(true);
  });
});

describe('TrackerBoardService — getBoard (single client) pagination (P1-18 a-7)', () => {
  it('a-8.7: getBoard for one client is bounded the same way as getTenantBoard', async () => {
    const h = makeHarness(makeRows(250, 'client-1'));
    const res = await h.svc.getBoard(TENANT, 'client-1');
    const cardCount = res.columns.reduce((n, c) => n + c.cards.length, 0);
    expect(cardCount).toBe(200);
    expect(res.hasMore).toBe(true);
    expect(res.total).toBe(250);
    expect(res.withheld).toBe(50);
  });

  it('a malformed cursor is ignored (returns page 1), never throws', async () => {
    const h = makeHarness(makeRows(5, 'client-1'));
    await expect(h.svc.getBoard(TENANT, 'client-1', { cursor: 'not-a-real-cursor' })).resolves.toMatchObject(
      { total: 5, hasMore: false },
    );
  });

  it('a stale cursor from a different (larger) page size still returns a valid, non-throwing page', async () => {
    const h = makeHarness(makeRows(10, 'client-1'));
    const page1 = await h.svc.getBoard(TENANT, 'client-1', { limit: 3 });
    const page2 = await h.svc.getBoard(TENANT, 'client-1', { cursor: page1.nextCursor!, limit: 7 });
    expect(page2.columns.reduce((n, c) => n + c.cards.length, 0)).toBe(7);
  });
});
