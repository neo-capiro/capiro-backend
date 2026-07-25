import { WatchlistService } from '../watchlist/watchlist.service';
import { TrackerWatchlistService } from './tracker-watchlist.service';
import { TrackerBoardService } from './tracker-board.service';
import { FeatureFlagService } from '../feature-flags/feature-flag.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * G3 (full sweep) proof: every remaining intel_* CRUD call is scoped through
 * withTenant (per-tenant) — the tenant GUC an RLS policy checks. Currently a
 * behavioral no-op (RLS held back in the HOLD migration); these tests prove the
 * WIRING before that migration makes it load-bearing. Cross-tenant sweeps
 * (watchlist-sync, bill-change-detector, data-parity, intel-alert emit) use
 * withSystem by design and are exercised by their own paths — this file covers
 * the per-tenant user surfaces.
 */
interface Recorder {
  withTenant: jest.Mock;
  withSystem: jest.Mock;
}

function makeFakePrisma(): { prisma: PrismaService } & Recorder {
  // Every model access returns a fresh set of benign-resolving method mocks.
  const tx = new Proxy(
    {},
    {
      get: () => ({
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'x' }),
        update: jest.fn().mockResolvedValue({ id: 'x' }),
        upsert: jest.fn().mockResolvedValue({ id: 'x' }),
        delete: jest.fn().mockResolvedValue({ id: 'x' }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      }),
    },
  );
  const withTenant = jest.fn((_t: string, fn: (tx: unknown) => unknown) => fn(tx));
  const withSystem = jest.fn((fn: (tx: unknown) => unknown) => fn(tx));
  const prisma = { withTenant, withSystem } as unknown as PrismaService;
  return { prisma, withTenant, withSystem };
}

describe('G3 full sweep: per-tenant intel_* calls are scoped via withTenant', () => {
  it('WatchlistService.list scopes to the caller tenantId', async () => {
    const { prisma, withTenant } = makeFakePrisma();
    const svc = new WatchlistService(prisma, {} as never);
    await svc.list('tenant-1');
    expect(withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
  });

  it('WatchlistService.create scopes to the caller tenantId', async () => {
    const { prisma, withTenant } = makeFakePrisma();
    const svc = new WatchlistService(prisma, {} as never);
    await svc.create('tenant-1', 'user-1', { clientId: 'c1', name: 'WL' });
    expect(withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
  });

  it('TrackerWatchlistService.getAlertPrefs scopes to the caller tenantId', async () => {
    const { prisma, withTenant } = makeFakePrisma();
    const svc = new TrackerWatchlistService(prisma);
    await svc.getAlertPrefs('tenant-1', 'c1', 'u1');
    expect(withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
  });

  it('TrackerBoardService.getSummary scopes to the caller tenantId', async () => {
    const { prisma, withTenant } = makeFakePrisma();
    const svc = new TrackerBoardService(prisma, {} as never, {} as never, {} as never);
    await svc.getSummary('tenant-1', 'c1');
    expect(withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
  });

  it('TrackerBoardService.untrackBill scopes to the caller tenantId', async () => {
    const { prisma, withTenant } = makeFakePrisma();
    // P1-03/P1-04: untrackBill now asserts client ownership before its delete —
    // stub it resolved so this test can keep proving the withTenant scoping.
    const watchlists = { assertClientInTenant: jest.fn().mockResolvedValue(undefined) } as never;
    const svc = new TrackerBoardService(prisma, {} as never, watchlists, {} as never);
    await svc.untrackBill('tenant-1', 'c1', '119-hr-1');
    expect(withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
  });

  it('FeatureFlagService.enabledFor scopes to the caller tenantId', async () => {
    const { prisma, withTenant } = makeFakePrisma();
    const config = { get: () => undefined } as never;
    const svc = new FeatureFlagService(prisma, config);
    await svc.enabledFor('tenant-1');
    expect(withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
  });
});
