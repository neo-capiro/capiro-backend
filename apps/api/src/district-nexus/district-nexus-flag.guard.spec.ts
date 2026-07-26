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

/**
 * Records which prisma scope was used — the RLS discipline is the point — and
 * CAPTURES the SQL. Capturing matters: this mock previously discarded the
 * query entirely (`$queryRaw: async () => rows`), so it happily passed while
 * the real statement carried a `::uuid` cast against a TEXT column and threw
 * 42883 on every live call. A mock that ignores its input cannot catch a
 * defect in that input.
 */
function prismaMock(outcome: { rows?: unknown[]; throws?: Error }) {
  const captured: { sql: string | null; values: unknown[] } = { sql: null, values: [] };
  const withSystem = jest.fn(async (fn: (tx: unknown) => unknown) =>
    fn({
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        // Reassemble the literal SQL with `?` where a parameter was bound.
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

  /**
   * REGRESSION (2026-07-26). The query shipped with `tenant_id = ${id}::uuid`,
   * but intel_feature_flag.tenant_id is TEXT (intel-api declares it
   * `tenantId String`, no @db.Uuid; its RLS policy casts the other way:
   * `tenant_id = (current_tenant_id())::text`).
   *
   * Every live read therefore threw `42883 operator does not exist: text =
   * uuid`, hit the fail-closed catch, and 404'd the whole feature for a tenant
   * whose flag was genuinely ON. It stayed invisible for weeks because with no
   * flag rows anywhere the guard's answer was "denied" either way — it only
   * surfaced the hour the first row was written.
   */
  describe('the flag query matches the real column types', () => {
    test('does not cast tenant_id to uuid — the column is TEXT', async () => {
      const { guard, captured } = makeGuard({ rows: [{ ok: 1 }] });
      await guard.canActivate(ctxFor(TENANT));
      expect(captured.sql).not.toMatch(/::\s*uuid/i);
    });

    test('binds the tenant id as a parameter rather than interpolating it', async () => {
      const { guard, captured } = makeGuard({ rows: [{ ok: 1 }] });
      await guard.canActivate(ctxFor(TENANT));
      expect(captured.values).toContain(TENANT);
      expect(captured.sql).not.toContain(TENANT);
    });

    test('still filters on feature, tenant and enabled', async () => {
      const { guard, captured } = makeGuard({ rows: [{ ok: 1 }] });
      await guard.canActivate(ctxFor(TENANT));
      const sql = (captured.sql ?? '').toLowerCase();
      expect(sql).toContain('intel_feature_flag');
      expect(sql).toContain('feature =');
      expect(sql).toContain('tenant_id =');
      expect(sql).toContain('enabled = true');
    });
  });
});
