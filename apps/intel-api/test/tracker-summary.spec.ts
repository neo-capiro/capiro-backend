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
  it('tenant-scopes the query (intel-api has no RLS) and reduces the rows', async () => {
    let calledWith: any = null;
    const prisma = {
      trackedBill: {
        findMany: async (args: any) => {
          calledWith = args;
          return [{ unread: true }, { unread: false }];
        },
      },
    } as any;
    const svc = new TrackerBoardService(prisma, {} as any, {} as any);
    await expect(svc.getSummary('t1', 'c1')).resolves.toEqual({ boardCount: 2, unread: 1 });
    expect(calledWith.where).toEqual({ tenantId: 't1', clientId: 'c1' });
  });
});
