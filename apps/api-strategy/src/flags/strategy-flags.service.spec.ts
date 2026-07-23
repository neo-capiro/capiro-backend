import { describe, expect, it, jest, afterEach } from '@jest/globals';
import { StrategyFlagsService } from './strategy-flags.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/*
 * StrategyFlagsService is the sole DB-backed half of the G5 kill-switch:
 * isMeriEnabled short-circuits on the env var BEFORE any query (fail-closed,
 * cheap), then fail-closed again if the query throws. Both are safety-critical
 * — a bug here would let Meri activate without one of the two required gates.
 */

function stubPrisma(rows: Array<{ settings_jsonb: unknown }> | Error) {
  const $queryRaw = jest.fn(async () => {
    if (rows instanceof Error) throw rows;
    return rows;
  });
  // The service reads inside withTenant (sets app.current_tenant so the tenants
  // RLS exposes the row); model it as "run fn with a tx exposing $queryRaw".
  const withTenant = jest.fn(async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({ $queryRaw }),
  );
  return { prisma: { withTenant, $queryRaw } as unknown as PrismaService, $queryRaw };
}

describe('StrategyFlagsService.isEnabled (strategyPlanner surface flag)', () => {
  it('reads the per-tenant flag from settings_jsonb.clioFeatureFlags', async () => {
    const { prisma } = stubPrisma([
      { settings_jsonb: { clioFeatureFlags: { 'strategyPlanner.enabled': true } } },
    ]);
    const svc = new StrategyFlagsService(prisma);
    expect(await svc.isEnabled('t1')).toBe(true);
  });

  it('defaults to false (fail-closed) when the flag is absent', async () => {
    const { prisma } = stubPrisma([{ settings_jsonb: {} }]);
    const svc = new StrategyFlagsService(prisma);
    expect(await svc.isEnabled('t1')).toBe(false);
  });

  it('defaults to false when the tenant row is missing entirely', async () => {
    const { prisma } = stubPrisma([]);
    const svc = new StrategyFlagsService(prisma);
    expect(await svc.isEnabled('t1')).toBe(false);
  });

  it('fails closed (false, no throw) when the query rejects', async () => {
    const { prisma } = stubPrisma(new Error('connection reset'));
    const svc = new StrategyFlagsService(prisma);
    await expect(svc.isEnabled('t1')).resolves.toBe(false);
  });

  it('caches a positive read for 60s (no re-query within the window)', async () => {
    const { prisma, $queryRaw } = stubPrisma([
      { settings_jsonb: { clioFeatureFlags: { 'strategyPlanner.enabled': true } } },
    ]);
    const svc = new StrategyFlagsService(prisma);
    expect(await svc.isEnabled('t1')).toBe(true);
    expect(await svc.isEnabled('t1')).toBe(true);
    expect($queryRaw).toHaveBeenCalledTimes(1);
  });

  it('caches per-tenant independently', async () => {
    const { prisma, $queryRaw } = stubPrisma([
      { settings_jsonb: { clioFeatureFlags: { 'strategyPlanner.enabled': true } } },
    ]);
    const svc = new StrategyFlagsService(prisma);
    await svc.isEnabled('t1');
    await svc.isEnabled('t2');
    expect($queryRaw).toHaveBeenCalledTimes(2);
  });
});

describe('StrategyFlagsService.isMeriEnabled (G5 kill-switch: env AND tenant flag)', () => {
  const ORIGINAL_ENV = process.env.STRATEGY_MERI_ENABLED;
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.STRATEGY_MERI_ENABLED;
    else process.env.STRATEGY_MERI_ENABLED = ORIGINAL_ENV;
  });

  it('short-circuits to false WITHOUT a DB read when the env switch is off', async () => {
    delete process.env.STRATEGY_MERI_ENABLED;
    const { prisma, $queryRaw } = stubPrisma([
      { settings_jsonb: { clioFeatureFlags: { 'strategyPlannerMeri.enabled': true } } },
    ]);
    const svc = new StrategyFlagsService(prisma);
    expect(await svc.isMeriEnabled('t1')).toBe(false);
    expect($queryRaw).not.toHaveBeenCalled();
  });

  it('only the literal "true" counts as env-on — any other value stays dormant, no query', async () => {
    process.env.STRATEGY_MERI_ENABLED = '1';
    const { prisma, $queryRaw } = stubPrisma([
      { settings_jsonb: { clioFeatureFlags: { 'strategyPlannerMeri.enabled': true } } },
    ]);
    const svc = new StrategyFlagsService(prisma);
    expect(await svc.isMeriEnabled('t1')).toBe(false);
    expect($queryRaw).not.toHaveBeenCalled();
  });

  it('true only when env is on AND the tenant flag resolves true', async () => {
    process.env.STRATEGY_MERI_ENABLED = 'true';
    const { prisma } = stubPrisma([
      { settings_jsonb: { clioFeatureFlags: { 'strategyPlannerMeri.enabled': true } } },
    ]);
    const svc = new StrategyFlagsService(prisma);
    expect(await svc.isMeriEnabled('t1')).toBe(true);
  });

  it('false when env is on but the tenant flag is absent (default OFF)', async () => {
    process.env.STRATEGY_MERI_ENABLED = 'true';
    const { prisma } = stubPrisma([{ settings_jsonb: {} }]);
    const svc = new StrategyFlagsService(prisma);
    expect(await svc.isMeriEnabled('t1')).toBe(false);
  });

  it('false when env is on but the tenant explicitly opted out', async () => {
    process.env.STRATEGY_MERI_ENABLED = 'true';
    const { prisma } = stubPrisma([
      { settings_jsonb: { clioFeatureFlags: { 'strategyPlannerMeri.enabled': false } } },
    ]);
    const svc = new StrategyFlagsService(prisma);
    expect(await svc.isMeriEnabled('t1')).toBe(false);
  });

  it('fails closed (false, no throw) when the query rejects, even with env on', async () => {
    process.env.STRATEGY_MERI_ENABLED = 'true';
    const { prisma } = stubPrisma(new Error('connection reset'));
    const svc = new StrategyFlagsService(prisma);
    await expect(svc.isMeriEnabled('t1')).resolves.toBe(false);
  });

  it('caches a positive read for 60s independently of the surface-flag cache', async () => {
    process.env.STRATEGY_MERI_ENABLED = 'true';
    const { prisma, $queryRaw } = stubPrisma([
      { settings_jsonb: { clioFeatureFlags: { 'strategyPlannerMeri.enabled': true } } },
    ]);
    const svc = new StrategyFlagsService(prisma);
    expect(await svc.isMeriEnabled('t1')).toBe(true);
    expect(await svc.isMeriEnabled('t1')).toBe(true);
    expect($queryRaw).toHaveBeenCalledTimes(1);
  });
});
