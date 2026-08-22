import { describe, expect, jest, test } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';
import {
  CAPIRO_INTERNAL_TENANT_SLUG,
  DefenseBudgetLifecycleInternalGuard,
} from './defense-budget-lifecycle-internal.guard.js';
import type { PrismaService } from '../prisma/prisma.service.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const INTERNAL = '22222222-2222-2222-2222-222222222222';

function ctxFor(tenantId?: string): ExecutionContext {
  const req = tenantId ? { tenantContext: { tenantId } } : {};
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function prismaMock(outcome: { rows?: unknown[]; throws?: Error }) {
  const captured: { sql: string | null; values: unknown[] } = { sql: null, values: [] };
  const withSystem = jest.fn(async (fn: (tx: unknown) => unknown) =>
    fn({
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        captured.sql = Array.isArray(strings) ? strings.join('?') : String(strings);
        captured.values = values;
        if (outcome.throws) throw outcome.throws;
        return outcome.rows ?? [];
      },
    }),
  );
  const withTenant = jest.fn();
  return {
    service: { withSystem, withTenant } as unknown as PrismaService,
    withSystem,
    withTenant,
    captured,
  };
}

function configMock(internalTenantId?: string): ConfigService {
  return { get: () => internalTenantId } as unknown as ConfigService;
}

function makeGuard(outcome: { rows?: unknown[]; throws?: Error }, internalTenantId?: string) {
  const prisma = prismaMock(outcome);
  return {
    guard: new DefenseBudgetLifecycleInternalGuard(prisma.service, configMock(internalTenantId)),
    ...prisma,
  };
}

describe('DefenseBudgetLifecycleInternalGuard', () => {
  test('allows capiro-internal via the DB-backed slug lookup', async () => {
    const { guard } = makeGuard({ rows: [{ ok: 1 }] });
    await expect(guard.canActivate(ctxFor(TENANT))).resolves.toBe(true);
  });

  test('404s — never 403s — when the tenant is not capiro-internal', async () => {
    const { guard } = makeGuard({ rows: [] });
    await expect(guard.canActivate(ctxFor(TENANT))).rejects.toBeInstanceOf(NotFoundException);
  });

  test('reads the tenant lookup under withSystem, never withTenant', async () => {
    const { guard, withSystem, withTenant } = makeGuard({ rows: [{ ok: 1 }] });
    await guard.canActivate(ctxFor(TENANT));
    expect(withSystem).toHaveBeenCalledTimes(1);
    expect(withTenant).not.toHaveBeenCalled();
  });

  test('treats the configured internal tenant id as always-on without touching the database', async () => {
    const { guard, withSystem } = makeGuard({ rows: [] }, INTERNAL);
    await expect(guard.canActivate(ctxFor(INTERNAL))).resolves.toBe(true);
    expect(withSystem).not.toHaveBeenCalled();
  });

  test('the configured internal override does not leak to other tenants', async () => {
    const { guard } = makeGuard({ rows: [] }, INTERNAL);
    await expect(guard.canActivate(ctxFor(TENANT))).rejects.toBeInstanceOf(NotFoundException);
  });

  test('falls back to the canonical internal tenant slug when the env id is absent', async () => {
    const { guard, withSystem, captured } = makeGuard({ rows: [{ ok: 1 }] });
    await expect(guard.canActivate(ctxFor(INTERNAL))).resolves.toBe(true);
    expect(withSystem).toHaveBeenCalledTimes(1);
    expect(captured.sql?.toLowerCase()).toContain('from tenants');
    expect(captured.sql?.toLowerCase()).toContain('slug =');
    expect(captured.values).toContain(CAPIRO_INTERNAL_TENANT_SLUG);
    expect(captured.values).toContain(INTERNAL);
  });

  test('404s when there is no tenant context at all', async () => {
    const { guard } = makeGuard({ rows: [{ ok: 1 }] });
    await expect(guard.canActivate(ctxFor(undefined))).rejects.toBeInstanceOf(NotFoundException);
  });

  test('fails CLOSED when the tenant lookup errors', async () => {
    const { guard } = makeGuard({ throws: new Error('connection reset') });
    await expect(guard.canActivate(ctxFor(TENANT))).rejects.toBeInstanceOf(NotFoundException);
  });

  test('never queries intel_feature_flag — this guard is strictly capiro-internal, not a rollout flag', async () => {
    const { guard, captured } = makeGuard({ rows: [{ ok: 1 }] });
    await guard.canActivate(ctxFor(TENANT));
    expect(captured.sql?.toLowerCase()).not.toContain('intel_feature_flag');
  });
});
