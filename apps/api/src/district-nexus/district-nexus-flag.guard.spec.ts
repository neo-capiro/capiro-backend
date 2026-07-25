import { describe, expect, jest, test } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';
import { DistrictNexusFlagGuard } from './district-nexus-flag.guard.js';
import type { PrismaService } from '../prisma/prisma.service.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const INTERNAL = '22222222-2222-2222-2222-222222222222';

function ctxFor(tenantId?: string): ExecutionContext {
  const req = tenantId ? { tenantContext: { tenantId } } : {};
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

/** Records which prisma scope was used — the RLS discipline is the point. */
function prismaMock(outcome: { rows?: unknown[]; throws?: Error }) {
  const withSystem = jest.fn(async (fn: (tx: unknown) => unknown) =>
    fn({
      $queryRaw: async () => {
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
  };
}

function configMock(internalTenantId?: string): ConfigService {
  return { get: () => internalTenantId } as unknown as ConfigService;
}

function makeGuard(outcome: { rows?: unknown[]; throws?: Error }, internalTenantId?: string) {
  const prisma = prismaMock(outcome);
  return {
    guard: new DistrictNexusFlagGuard(prisma.service, configMock(internalTenantId)),
    ...prisma,
  };
}

describe('DistrictNexusFlagGuard', () => {
  test('allows the request when an enabled flag row exists', async () => {
    const { guard } = makeGuard({ rows: [{ ok: 1 }] });
    await expect(guard.canActivate(ctxFor(TENANT))).resolves.toBe(true);
  });

  test('404s — never 403s — when no flag row exists', async () => {
    const { guard } = makeGuard({ rows: [] });
    // 403 would advertise that the feature exists and this tenant lacks it.
    await expect(guard.canActivate(ctxFor(TENANT))).rejects.toBeInstanceOf(NotFoundException);
  });

  test('reads the flag under withSystem, never withTenant', async () => {
    // intel_feature_flag has RLS FORCE-enabled and apps/api sets no tenant GUC,
    // so a withTenant read returns zero rows and darkens the feature for everyone.
    const { guard, withSystem, withTenant } = makeGuard({ rows: [{ ok: 1 }] });
    await guard.canActivate(ctxFor(TENANT));
    expect(withSystem).toHaveBeenCalledTimes(1);
    expect(withTenant).not.toHaveBeenCalled();
  });

  test('treats the internal tenant as always-on without touching the database', async () => {
    // Mirrors intel-api's FeatureFlagService, which the web flag hook follows.
    // Without this the internal canary sees the nav item then 404s on every call.
    const { guard, withSystem } = makeGuard({ rows: [] }, INTERNAL);
    await expect(guard.canActivate(ctxFor(INTERNAL))).resolves.toBe(true);
    expect(withSystem).not.toHaveBeenCalled();
  });

  test('the internal override does not leak to other tenants', async () => {
    const { guard } = makeGuard({ rows: [] }, INTERNAL);
    await expect(guard.canActivate(ctxFor(TENANT))).rejects.toBeInstanceOf(NotFoundException);
  });

  test('404s when there is no tenant context at all', async () => {
    const { guard } = makeGuard({ rows: [{ ok: 1 }] });
    await expect(guard.canActivate(ctxFor(undefined))).rejects.toBeInstanceOf(NotFoundException);
  });

  test('fails CLOSED when the flag read errors', async () => {
    // An erroring flag read must not open the feature.
    const { guard } = makeGuard({ throws: new Error('connection reset') });
    await expect(guard.canActivate(ctxFor(TENANT))).rejects.toBeInstanceOf(NotFoundException);
  });
});
