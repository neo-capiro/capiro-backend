import { NotFoundException } from '@nestjs/common';
import { TrackerBoardService } from '../src/tracker/tracker-board.service.js';
import { TrackerWatchlistService } from '../src/tracker/tracker-watchlist.service.js';

/**
 * Gate A, P1-03/P1-04 — trackBill/untrackBill/recordFeedback must prove the
 * client belongs to the caller's tenant BEFORE any read or write, exactly like
 * the sibling watchlist writers (tracker-watchlist.spec.ts's cross-tenant
 * guard test). intel-api has no RLS, so clientId is a globally unique id an
 * unscoped write could otherwise clobber across tenants.
 *
 * Uses a REAL TrackerWatchlistService (hand-rolled prisma double, no DB) so
 * these tests prove the actual guard runs, not just that a mock was wired up —
 * same fixture shape as tracker-watchlist.spec.ts's `withSystem` double.
 */

const TENANT = 'tenant-1';
const CLIENT = '11111111-1111-1111-1111-111111111111';

/** withSystem resolves a row only for clientIds in `owned` — mirrors the real assertClientInTenant SQL guard. */
function watchlistsOwning(owned: string[]): TrackerWatchlistService {
  const prisma = {
    withSystem: async (fn: (t: unknown) => unknown) =>
      fn({
        $queryRawUnsafe: async (_sql: string, clientId: string) =>
          owned.includes(clientId) ? [{ id: clientId }] : [],
      }),
  } as any;
  return new TrackerWatchlistService(prisma);
}

/** Records every trackedBill/intelFeedback write TrackerBoardService attempts — proves the guard runs first. */
function recordingBoardPrisma() {
  const calls: string[] = [];
  const tx = {
    trackedBill: {
      upsert: async () => {
        calls.push('trackedBill.upsert');
        return {};
      },
      deleteMany: async () => {
        calls.push('trackedBill.deleteMany');
        return { count: 0 };
      },
    },
    intelFeedback: {
      create: async () => {
        calls.push('intelFeedback.create');
        return {};
      },
    },
  };
  const prisma = {
    withTenant: async (_tid: string, fn: (t: unknown) => unknown) => fn(tx),
  } as any;
  return { prisma, calls };
}

describe('TrackerBoardService — cross-tenant ownership guard (P1-03/P1-04)', () => {
  it('trackBill rejects a clientId belonging to another tenant and writes nothing', async () => {
    const { prisma, calls } = recordingBoardPrisma();
    const svc = new TrackerBoardService(prisma, {} as any, watchlistsOwning([]), {} as any);

    await expect(svc.trackBill(TENANT, CLIENT, 'user-1', '119-hr-1234')).rejects.toThrow(
      NotFoundException,
    );
    expect(calls).toEqual([]);
  });

  it('untrackBill rejects a clientId belonging to another tenant and writes nothing', async () => {
    const { prisma, calls } = recordingBoardPrisma();
    const svc = new TrackerBoardService(prisma, {} as any, watchlistsOwning([]), {} as any);

    await expect(svc.untrackBill(TENANT, CLIENT, '119-hr-1234')).rejects.toThrow(NotFoundException);
    expect(calls).toEqual([]);
  });

  it('recordFeedback rejects a clientId belonging to another tenant and writes nothing', async () => {
    const { prisma, calls } = recordingBoardPrisma();
    const svc = new TrackerBoardService(prisma, {} as any, watchlistsOwning([]), {} as any);

    await expect(
      svc.recordFeedback(TENANT, CLIENT, 'user-1', { targetRef: '119-hr-1234', signal: 'tracked' }),
    ).rejects.toThrow(NotFoundException);
    expect(calls).toEqual([]);
  });

  it('trackBill rejects the literal "_all" as a non-UUID clientId, even if the fixture would otherwise allow it', async () => {
    const { prisma, calls } = recordingBoardPrisma();
    // Fixture owns CLIENT (and would own "_all" too if the guard didn't UUID-check first) —
    // proves the rejection comes from the UUID_RE early-return, not from ownership.
    const svc = new TrackerBoardService(prisma, {} as any, watchlistsOwning([CLIENT, '_all']), {} as any);

    await expect(svc.trackBill(TENANT, '_all', 'user-1', '119-hr-1234')).rejects.toThrow(
      NotFoundException,
    );
    expect(calls).toEqual([]);
  });

  it("trackBill succeeds for the caller's own client, and the guard was invoked first", async () => {
    const { prisma, calls } = recordingBoardPrisma();
    const watchlists = watchlistsOwning([CLIENT]);
    const spy = jest.spyOn(watchlists, 'assertClientInTenant');
    const repo = {
      getBillById: async () => ({
        latestActionText: 'Referred to the Committee on Energy and Commerce.',
        latestActionDate: new Date('2026-06-01'),
      }),
    } as any;
    const svc = new TrackerBoardService(prisma, repo, watchlists, {} as any);

    await expect(svc.trackBill(TENANT, CLIENT, 'user-1', '119-hr-1234')).resolves.toBeDefined();
    expect(spy).toHaveBeenCalledWith(TENANT, CLIENT);
    expect(calls).toContain('trackedBill.upsert');
  });
});
