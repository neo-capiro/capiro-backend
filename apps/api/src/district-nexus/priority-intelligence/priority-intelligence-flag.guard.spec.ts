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
  test('internal missing row (configured UUID, no explicit row anywhere) → allowed, but now DOES hit the DB', async () => {
    // Regression guard for the release defect: the old fast path returned
    // true before any query, which meant an explicit disabled row could never
    // be consulted. The DB round-trip is now mandatory so a disabled row can
    // always be found. With zero rows (no disabled row exists), the
    // NOT EXISTS holds and access is still granted.
    const { guard, withSystem } = makeGuard({ rows: [{ ok: 1 }] }, INTERNAL);
    await expect(guard.canActivate(ctxFor(INTERNAL))).resolves.toBe(true);
    expect(withSystem).toHaveBeenCalledTimes(1);
  });

  test('internal missing row (slug-matched tenant, no configured UUID) → allowed', async () => {
    const { guard } = makeGuard({ rows: [{ ok: 1 }] });
    await expect(guard.canActivate(ctxFor(TENANT))).resolves.toBe(true);
  });

  test('internal enabled row (explicit enabled:true row for capiro-internal) → allowed', async () => {
    // Same DB shape as "missing row": an enabled=true row does not match the
    // `enabled = false` NOT EXISTS clause, so the internal-canary branch
    // still holds and the query returns a row.
    const { guard } = makeGuard({ rows: [{ ok: 1 }] }, INTERNAL);
    await expect(guard.canActivate(ctxFor(INTERNAL))).resolves.toBe(true);
  });

  test('internal explicit disabled row → 404 (the fixed defect: an explicit off-switch must win)', async () => {
    // The NOT EXISTS(disabled row) clause fails, and the tenant has no
    // separate enabled=true row either, so the whole WHERE is false → no
    // rows → 404. This is the exact scenario that was silently broken
    // before this fix: an admin inserting `enabled: false` for
    // capiro-internal had zero effect because the fallback never consulted
    // the row at all.
    const { guard } = makeGuard({ rows: [] }, INTERNAL);
    await expect(guard.canActivate(ctxFor(INTERNAL))).rejects.toBeInstanceOf(NotFoundException);
  });

  test('external missing row → 404 (no fallback for non-internal tenants)', async () => {
    const { guard } = makeGuard({ rows: [] });
    await expect(guard.canActivate(ctxFor(TENANT))).rejects.toBeInstanceOf(NotFoundException);
  });

  test('external enabled row (both parent and child flags enabled) → allowed', async () => {
    const { guard } = makeGuard({ rows: [{ ok: 1 }] });
    await expect(guard.canActivate(ctxFor(TENANT))).resolves.toBe(true);
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

  test('SQL checks BOTH feature keys via bound params, checks for a disabled row, and does not cast tenant_id to uuid', async () => {
    const { guard, captured } = makeGuard({ rows: [{ ok: 1 }] });
    await guard.canActivate(ctxFor(TENANT));
    expect(captured.sql).toContain('intel_feature_flag');
    expect(captured.sql).toContain('NOT EXISTS');
    // Feature keys are bound parameters (Prisma.sql), not string-literal SQL.
    expect(captured.values).toContain(DISTRICT_NEXUS_PRIORITY_INTELLIGENCE_FEATURE);
    expect(captured.values).toContain(DISTRICT_NEXUS_FEATURE);
    expect(captured.values).toContain(CAPIRO_INTERNAL_TENANT_SLUG);
    // The isConfiguredInternalTenant boolean is bound too.
    expect(captured.values).toContain(false);
    expect(captured.sql).not.toMatch(/tenant_id\s*::\s*uuid/);
    // id::text on tenants is fine; tenant_id column itself must not be cast.
    expect(captured.sql).toMatch(/tenant_id = \?/);
  });

  test('database-read failure fails closed on DB error', async () => {
    const { guard } = makeGuard({ throws: new Error('db down') });
    await expect(guard.canActivate(ctxFor(TENANT))).rejects.toBeInstanceOf(NotFoundException);
  });

  test('no tenant context → 404', async () => {
    const { guard } = makeGuard({ rows: [{ ok: 1 }] });
    await expect(guard.canActivate(ctxFor(undefined))).rejects.toBeInstanceOf(NotFoundException);
  });
});
