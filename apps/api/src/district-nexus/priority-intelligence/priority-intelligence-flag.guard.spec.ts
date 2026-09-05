/**
 * District Nexus Release 4 — priority intelligence flag guard tests.
 * Mirrors district-nexus-strategic-flag.guard.spec.ts.
 */

import { describe, expect, jest, test } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';
import {
  DISTRICT_NEXUS_PRIORITY_INTELLIGENCE_FEATURE,
  DistrictNexusPriorityIntelligenceFlagGuard,
} from './priority-intelligence-flag.guard.js';
import {
  CAPIRO_INTERNAL_TENANT_SLUG,
  DISTRICT_NEXUS_FEATURE,
} from '../district-nexus-flag.guard.js';
import type { PrismaService } from '../../prisma/prisma.service.js';

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
    guard: new DistrictNexusPriorityIntelligenceFlagGuard(
      prisma.service,
      configMock(internalTenantId),
    ),
    ...prisma,
  };
}

describe('DistrictNexusPriorityIntelligenceFlagGuard', () => {
  test('allows configured internal tenant without DB round-trip', async () => {
    const { guard, withSystem } = makeGuard({ rows: [] }, INTERNAL);
    await expect(guard.canActivate(ctxFor(INTERNAL))).resolves.toBe(true);
    expect(withSystem).not.toHaveBeenCalled();
  });

  test('allows when both parent DN flag and priority intelligence flag are enabled', async () => {
    const { guard } = makeGuard({ rows: [{ ok: 1 }] });
    await expect(guard.canActivate(ctxFor(TENANT))).resolves.toBe(true);
  });

  test('404s when flags are off — never 403', async () => {
    const { guard } = makeGuard({ rows: [] });
    await expect(guard.canActivate(ctxFor(TENANT))).rejects.toBeInstanceOf(NotFoundException);
  });

  test('parent off + child on → 404 (child cannot bypass district_nexus_v2)', async () => {
    // DB enforces AND: only the child row exists → parent EXISTS fails → no rows.
    const { guard } = makeGuard({ rows: [] });
    await expect(guard.canActivate(ctxFor(TENANT))).rejects.toBeInstanceOf(NotFoundException);
  });

  test('parent on + child off → 404 (child row required)', async () => {
    // DB enforces AND: only the parent row exists → child EXISTS fails → no rows.
    const { guard } = makeGuard({ rows: [] });
    await expect(guard.canActivate(ctxFor(TENANT))).rejects.toBeInstanceOf(NotFoundException);
  });

  test('reads under withSystem, never withTenant', async () => {
    const { guard, withSystem, withTenant } = makeGuard({ rows: [{ ok: 1 }] });
    await guard.canActivate(ctxFor(TENANT));
    expect(withSystem).toHaveBeenCalledTimes(1);
    expect(withTenant).not.toHaveBeenCalled();
  });

  test('SQL checks BOTH feature keys via bound params and does not cast tenant_id to uuid', async () => {
    const { guard, captured } = makeGuard({ rows: [{ ok: 1 }] });
    await guard.canActivate(ctxFor(TENANT));
    expect(captured.sql).toContain('intel_feature_flag');
    // Feature keys are bound parameters (Prisma.sql), not string-literal SQL.
    expect(captured.values).toContain(DISTRICT_NEXUS_PRIORITY_INTELLIGENCE_FEATURE);
    expect(captured.values).toContain(DISTRICT_NEXUS_FEATURE);
    expect(captured.values).toContain(CAPIRO_INTERNAL_TENANT_SLUG);
    expect(captured.sql).not.toMatch(/tenant_id\s*::\s*uuid/);
    // id::text on tenants is fine; tenant_id column itself must not be cast.
    expect(captured.sql).toMatch(/tenant_id = \?/);
  });

  test('fails closed on DB error', async () => {
    const { guard } = makeGuard({ throws: new Error('db down') });
    await expect(guard.canActivate(ctxFor(TENANT))).rejects.toBeInstanceOf(NotFoundException);
  });

  test('no tenant context → 404', async () => {
    const { guard } = makeGuard({ rows: [{ ok: 1 }] });
    await expect(guard.canActivate(ctxFor(undefined))).rejects.toBeInstanceOf(NotFoundException);
  });
});
