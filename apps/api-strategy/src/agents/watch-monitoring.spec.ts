import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { WatcherService } from './watcher.service.js';
import { WATCH_MISSION_NAME } from './watch-mission.js';

describe('Scoped Watch monitoring', () => {
  let missions: any[];
  let logs: any[];
  let service: WatcherService;
  let enabled: boolean;
  let archived: boolean;
  let lastRun: any;
  let tx: any;
  beforeEach(() => {
    missions = []; logs = []; enabled = true; archived = false; lastRun = null;
    tx = {
      $queryRaw: jest.fn(async () => [{ id: 'strategy' }]),
      spStrategy: { findFirst: jest.fn(async () => archived ? null : { id: 'strategy' }) },
      spAgentMission: {
        findMany: jest.fn(async ({ where }: any) => missions.filter((m) => m.strategyId === where.strategyId && m.name !== 'Execute this strategy' && (m.purpose === 'watch' || m.name === WATCH_MISSION_NAME || m.cadence != null || m.watchRun === true) && where.state.in.includes(m.state))),
        create: jest.fn(async ({ data }: any) => { const row = { id: `mission-${missions.length}`, ...data }; missions.push(row); return row; }),
        update: jest.fn(async ({ where, data }: any) => { const row = missions.find((m) => m.id === where.id); Object.assign(row, data); return row; }),
      },
      spAgentRun: { findFirst: jest.fn(async () => lastRun) },
    };
    const prisma: any = { withTenant: async (_t: string, f: any) => f(tx), withTenantUser: async (_t: string, _u: string, f: any) => f(tx) };
    service = new WatcherService(prisma, { logActivity: async (_tx: any, event: any) => logs.push(event) } as any,
      { isAgenticFlagEnabled: async () => enabled } as any, {} as any, {} as any, {} as any, {} as any);
  });

  it('distinguishes never checked from unavailable without creating a mission', async () => {
    expect(await service.monitoring('tenant', 'strategy')).toMatchObject({ available: true, mission: null, lastRun: null });
    enabled = false;
    expect(await service.monitoring('tenant', 'strategy')).toMatchObject({ available: false, mission: null });
    expect(tx.spAgentMission.create).not.toHaveBeenCalled();
  });

  it('reuses one Watch mission, never the Execution mission, and audits a scoped save', async () => {
    missions.push({ id: 'execution', strategyId: 'strategy', name: 'Execute this strategy', state: 'active', cadence: null, nextRunAt: null });
    await service.configureMonitoring('tenant', 'user', 'strategy', 'manual');
    await service.configureMonitoring('tenant', 'user', 'strategy', 'manual');
    expect(tx.spAgentMission.create).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(missions.find((m) => m.name === WATCH_MISSION_NAME)).toMatchObject({ state: 'active', cadence: null, nextRunAt: null });
    expect(missions[0]).toMatchObject({ id: 'execution', state: 'active' });
    expect(logs).toHaveLength(1);
  });

  it('keeps a custom scheduled mission discoverable after switching to manual or paused', async () => {
    missions.push({ id: 'custom', strategyId: 'strategy', name: 'Quarterly client rhythm', state: 'active', cadence: 'daily', nextRunAt: new Date() });
    expect((await service.configureMonitoring('tenant', 'user', 'strategy', 'manual')).mission?.id).toBe('custom');
    expect((await service.configureMonitoring('tenant', 'user', 'strategy', 'paused')).mission?.id).toBe('custom');
    expect((await service.configureMonitoring('tenant', 'user', 'strategy', 'manual')).mission?.id).toBe('custom');
    expect(missions[0].name).toBe('Quarterly client rhythm');
    expect(tx.spAgentMission.create).not.toHaveBeenCalled();
  });

  it('shows an active duplicate instead of claiming monitoring is paused, then pauses all schedules', async () => {
    missions.push({ id: 'old', strategyId: 'strategy', name: WATCH_MISSION_NAME, state: 'paused', cadence: null, nextRunAt: null });
    missions.push({ id: 'active', strategyId: 'strategy', name: WATCH_MISSION_NAME, state: 'active', cadence: 'daily', nextRunAt: new Date() });
    expect((await service.monitoring('tenant', 'strategy')).mission?.id).toBe('active');
    await service.configureMonitoring('tenant', 'user', 'strategy', 'paused');
    expect(missions.every((m) => m.state === 'paused' && m.nextRunAt === null)).toBe(true);
    expect(tx.spAgentMission.create).not.toHaveBeenCalled();
  });

  it('does not silently claim scheduled monitoring is active while the scheduler is disabled', async () => {
    const previous = process.env.STRATEGY_WATCHER_SCHEDULER;
    process.env.STRATEGY_WATCHER_SCHEDULER = 'false';
    try {
      await expect(service.configureMonitoring('tenant', 'user', 'strategy', 'daily')).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.spAgentMission.create).not.toHaveBeenCalled();
    } finally { if (previous === undefined) delete process.env.STRATEGY_WATCHER_SCHEDULER; else process.env.STRATEGY_WATCHER_SCHEDULER = previous; }
  });

  it('reports a failed attempt separately from a successful no-findings check', async () => {
    await service.configureMonitoring('tenant', 'user', 'strategy', 'manual');
    lastRun = { id: 'run', state: 'failed_recoverable', createdAt: new Date('2026-09-08T12:00:00Z'), error: 'Context service unavailable', findings: null };
    expect((await service.monitoring('tenant', 'strategy')).lastRun).toMatchObject({ state: 'failed_recoverable', checkedAt: null, findingCount: null, error: 'Context service unavailable' });
    lastRun = { ...lastRun, state: 'ready_for_review', error: null, findings: { checkedOn: '2026-09-08', checkedAt: '2026-09-08T12:01:00Z', findings: [] } };
    expect((await service.monitoring('tenant', 'strategy')).lastRun).toMatchObject({ checkedAt: '2026-09-08T12:01:00Z', findingCount: 0 });
  });

  it('refuses unauthorized or archived-strategy configuration', async () => {
    enabled = false;
    await expect(service.configureMonitoring('tenant', 'user', 'strategy', 'manual')).rejects.toBeInstanceOf(ForbiddenException);
    enabled = true; archived = true;
    await expect(service.configureMonitoring('tenant', 'user', 'strategy', 'manual')).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.spAgentMission.create).not.toHaveBeenCalled();
  });
});
