import { NewMatchDetectorService } from '../src/tracker/new-match-detector.service.js';

/**
 * LegiWatch B1 — the new-match emitter. Verifies: a bill that newly clears a
 * client's fit floor is persisted to intel_bill_match AND fires exactly one
 * bill_new_match alert (both in one tenant-scoped tx); an already-matched bill
 * only refreshes its snapshot (no re-alert); a concurrent P2002 is a clean skip.
 * Pure-unit — prisma + board are hand-rolled doubles (no DB).
 */
type Rec = {
  billId: string;
  displayNum: string;
  title: string | null;
  latestActionDate: Date | null;
  fit: number;
  matchedTags: string[];
  why: string;
  whyKind: string;
};

function rec(billId: string, fit: number, over: Partial<Rec> = {}): Rec {
  return {
    billId,
    displayNum: billId.toUpperCase(),
    title: 'A bill',
    latestActionDate: null,
    fit,
    matchedTags: ['tag'],
    why: 'matches your watchlist',
    whyKind: 'keyword',
    ...over,
  };
}

function makeService(opts: {
  recs: Rec[];
  existing?: string[]; // billIds already in intel_bill_match
  throwP2002On?: string; // billId whose create races (P2002)
}) {
  const matchCreates: string[] = [];
  const matchUpdates: string[] = [];
  const alertCreates: Array<{ changeType: string; triggerKey: unknown; sourceRef: string }> = [];
  const existing = new Set(opts.existing ?? []);
  const inner = {
    billMatch: {
      findMany: async () => [...existing].map((billId) => ({ billId })),
      update: async ({ where }: { where: { clientId_billId: { billId: string } } }) => {
        matchUpdates.push(where.clientId_billId.billId);
        return {};
      },
      create: async ({ data }: { data: { billId: string } }) => {
        if (opts.throwP2002On === data.billId) throw { code: 'P2002' };
        matchCreates.push(data.billId);
        return {};
      },
    },
    intelAlert: {
      create: async ({
        data,
      }: {
        data: { changeType: string; sourceRef: string; evidence: { triggerKey: unknown } };
      }) => {
        alertCreates.push({
          changeType: data.changeType,
          triggerKey: data.evidence.triggerKey,
          sourceRef: data.sourceRef,
        });
        return {};
      },
    },
  };
  const prisma = {
    withSystem: async <T>(cb: (tx: unknown) => Promise<T>) =>
      cb({ watchlist: { findMany: async () => [{ tenantId: 't1', clientId: 'c1' }] } }),
    withTenant: async <T>(_t: string, cb: (tx: typeof inner) => Promise<T>) => cb(inner),
  };
  const board = { getRecommendations: async () => opts.recs };
  const svc = new NewMatchDetectorService(prisma as never, board as never);
  return { svc, matchCreates, matchUpdates, alertCreates };
}

describe('NewMatchDetectorService.runNewMatchCycle', () => {
  it('persists a NEW match and fires exactly one bill_new_match alert (newMatch key)', async () => {
    const { svc, matchCreates, alertCreates } = makeService({ recs: [rec('119-hr-1', 0.72)] });
    const r = await svc.runNewMatchCycle();
    expect(r.newMatches).toBe(1);
    expect(r.alertsWritten).toBe(1);
    expect(matchCreates).toEqual(['119-hr-1']);
    expect(alertCreates).toHaveLength(1);
    expect(alertCreates[0]).toMatchObject({
      changeType: 'bill_new_match',
      triggerKey: 'newMatch',
      sourceRef: '119-hr-1',
    });
  });

  it('refreshes an already-matched bill without re-alerting', async () => {
    const { svc, matchCreates, matchUpdates, alertCreates } = makeService({
      recs: [rec('119-hr-1', 0.8)],
      existing: ['119-hr-1'],
    });
    const r = await svc.runNewMatchCycle();
    expect(r.newMatches).toBe(0);
    expect(r.refreshed).toBe(1);
    expect(matchUpdates).toEqual(['119-hr-1']);
    expect(matchCreates).toEqual([]);
    expect(alertCreates).toEqual([]); // never re-alert a known match
  });

  it('treats a concurrent P2002 as a clean skip (no alert double-fire)', async () => {
    const { svc, alertCreates } = makeService({
      recs: [rec('119-hr-9', 0.6)],
      throwP2002On: '119-hr-9',
    });
    const r = await svc.runNewMatchCycle();
    expect(r.newMatches).toBe(1); // counted as processed
    expect(r.alertsWritten).toBe(0); // but no alert — the racing cycle owns it
    expect(alertCreates).toEqual([]);
  });
});
