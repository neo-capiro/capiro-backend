import { PlannerSchedulerService } from './planner-scheduler.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { PlannerService } from './planner.service.js';
describe('Planner scheduler tenant discovery and lifecycle', () => {
  const tenant = '10000000-0000-4000-8000-000000000001';
  function fixture() {
    const query = jest.fn(async (_sql: unknown) => [{ tenantId: tenant }]);
    const prisma = { withSystem: jest.fn(async (run) => run({ $queryRaw: query })) };
    const planner = {
      runScheduledGoalWork: jest.fn(async (_tenantId: string, _now: Date, _cursor?: string) => ({
        executed: 0,
        failed: 0,
        nextCursor: null as string | null,
      })),
      runScheduledWork: jest.fn(async (_tenantId: string, _now: Date, _cursor?: string) => ({
        executed: 1,
        failed: 0,
        nextCursor: null as string | null,
      })),
    };
    return {
      service: new PlannerSchedulerService(
        prisma as unknown as PrismaService,
        planner as unknown as PlannerService,
      ),
      prisma,
      planner,
      query,
    };
  }
  it('uses the canonical system lookup for IDs only and passes them to tenant-scoped Planner processing', async () => {
    const { service, planner, query } = fixture();
    const now = new Date('2026-11-01T12:00:00Z');
    await service.tickOnce(now);
    const sql = query.mock.calls[0]?.[0] as unknown as string[];
    expect(sql.join('')).toContain('tenant_memberships');
    expect(sql.join('')).not.toContain('sp_planner');
    expect(planner.runScheduledWork).toHaveBeenCalledWith(tenant, now, undefined);
    expect(planner.runScheduledGoalWork).toHaveBeenCalledWith(tenant, now, undefined);
  });
  it('retains task cursors, isolates a failed tenant and retries discovery after failure', async () => {
    const { service, planner, query } = fixture();
    const second = '10000000-0000-4000-8000-000000000002';
    query.mockResolvedValue([{ tenantId: tenant }, { tenantId: second }]);
    planner.runScheduledWork.mockRejectedValueOnce(new Error('isolated')).mockResolvedValue({
      executed: 1,
      failed: 0,
      nextCursor: '30000000-0000-4000-8000-000000000001',
    });
    await service.tickOnce();
    await service.tickOnce();
    expect(planner.runScheduledWork).toHaveBeenCalledWith(
      second,
      expect.any(Date),
      '30000000-0000-4000-8000-000000000001',
    );
    query.mockRejectedValueOnce(new Error('discovery'));
    await service.tick();
    await service.tick();
    expect(query).toHaveBeenCalledTimes(4);
  });
  it('prevents overlapping ticks and clears its unreferenced timer on shutdown', async () => {
    jest.useFakeTimers();
    const { service, planner } = fixture();
    let resolve!: (value: { executed: number; failed: number; nextCursor: null }) => void;
    planner.runScheduledWork.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    service.onModuleInit();
    const tick = service.tick();
    await Promise.resolve();
    await Promise.resolve();
    await service.tick();
    expect(planner.runScheduledWork).toHaveBeenCalledTimes(1);
    resolve({ executed: 1, failed: 0, nextCursor: null });
    await tick;
    service.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });
});
