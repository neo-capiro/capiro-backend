import { TrackerBoardService, summarizeTrackedRows } from '../src/tracker/tracker-board.service.js';

/**
 * Phase 7 — client-profile tab-badge summary (GET .../tracker/summary),
 * legacy-identical `{ boardCount, unread }` (apps/api tracker.service.getSummary).
 * Pure-unit: the reducer is a pure export; the service is exercised with a
 * mocked PrismaService (no DB).
 */
describe('summarizeTrackedRows', () => {
  it('counts all rows and the unread subset', () => {
    expect(summarizeTrackedRows([{ unread: true }, { unread: false }, { unread: true }])).toEqual({
      boardCount: 3,
      unread: 2,
    });
  });

  it('returns zeros for an empty board', () => {
    expect(summarizeTrackedRows([])).toEqual({ boardCount: 0, unread: 0 });
  });
});

describe('TrackerBoardService.getSummary', () => {
  /**
   * The mock routes through `withTenant`, which is how the service actually
   * reads (this spec predated that and was failing on
   * `this.prisma.withTenant is not a function` — a stale mock, not a real bug).
   */
  function makeSvc(watchlist: { issueAreas: string[]; topics: number } | null) {
    const calls: { trackedBill?: any; watchlist?: any } = {};
    const tx = {
      trackedBill: {
        findMany: async (args: any) => {
          calls.trackedBill = args;
          return [{ unread: true }, { unread: false }];
        },
      },
      watchlist: {
        findFirst: async (args: any) => {
          calls.watchlist = args;
          return watchlist
            ? { issueAreas: watchlist.issueAreas, _count: { topics: watchlist.topics } }
            : null;
        },
      },
    };
    const prisma = { withTenant: async (_t: string, fn: any) => fn(tx) } as any;
    return { svc: new TrackerBoardService(prisma, {} as any, {} as any, {} as any), calls };
  }

  it('tenant-scopes the query (intel-api has no RLS) and reduces the rows', async () => {
    const { svc, calls } = makeSvc({ issueAreas: ['Energy'], topics: 2 });
    await expect(svc.getSummary('t1', 'c1')).resolves.toEqual({
      boardCount: 2,
      unread: 1,
      hasWatchlist: true,
    });
    expect(calls.trackedBill.where).toEqual({ tenantId: 't1', clientId: 'c1' });
    expect(calls.watchlist.where).toEqual({ tenantId: 't1', clientId: 'c1' });
  });

  /**
   * P2-01 (Gate D g-4): the cold-start gate needs an ALWAYS-AVAILABLE signal,
   * because the profile's own watchlistQuery is `enabled: activePanel ===
   * 'config'` and has no data on the Board. This flag rides the summary the tab
   * badge already fetches.
   */
  describe('hasWatchlist (P2-01)', () => {
    it('is true when the client has topics', async () => {
      const { svc } = makeSvc({ issueAreas: [], topics: 3 });
      expect((await svc.getSummary('t1', 'c1')).hasWatchlist).toBe(true);
    });

    it('is true when the client has only issue areas', async () => {
      const { svc } = makeSvc({ issueAreas: ['Energy'], topics: 0 });
      expect((await svc.getSummary('t1', 'c1')).hasWatchlist).toBe(true);
    });

    it('is FALSE when the client has neither — the cold start', async () => {
      const { svc } = makeSvc({ issueAreas: [], topics: 0 });
      expect((await svc.getSummary('t1', 'c1')).hasWatchlist).toBe(false);
    });

    it('is FALSE when there is no watchlist row at all', async () => {
      const { svc } = makeSvc(null);
      expect((await svc.getSummary('t1', 'c1')).hasWatchlist).toBe(false);
    });
  });
});
