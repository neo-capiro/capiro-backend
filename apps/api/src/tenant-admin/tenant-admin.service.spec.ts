import { describe, expect, jest, test } from '@jest/globals';

// clerk.service is a transitive constructor dep; the SDK is never exercised here.
jest.mock('@clerk/backend', () => ({
  __esModule: true,
  createClerkClient: () => ({}),
  verifyToken: async () => ({}),
}));

import { TenantAdminService } from './tenant-admin.service.js';

const CTX = {
  tenantId: 'tenant-1',
  tenantSlug: 'acme',
  userId: 'user-1',
  clerkUserId: 'ck_1',
  role: 'user_admin' as const,
};

const D = (iso: string) => new Date(iso);

/**
 * Bespoke prisma mock for listAuditLogs (#3d): withTenant runs the callback with
 * a tx whose auditLog.findMany applies the select projection + tenant/action/date
 * filters + desc ordering, and count returns the filtered total. Every row in the
 * store carries INTERNAL fields (actorUserId/ip/before) so the spec can prove they
 * are NOT returned.
 */
function makeService(rows: Array<Record<string, unknown>>) {
  const calls: Array<{ where?: Record<string, unknown>; select?: Record<string, boolean> }> = [];
  const match = (r: Record<string, unknown>, where?: Record<string, unknown>): boolean => {
    if (!where) return true;
    if (where.tenantId && r.tenantId !== where.tenantId) return false;
    if (where.action && r.action !== where.action) return false;
    if (where.entityType && r.entityType !== where.entityType) return false;
    const occ = where.occurredAt as { gte?: Date; lte?: Date } | undefined;
    if (occ) {
      const v = r.occurredAt as Date;
      if (occ.gte && v < occ.gte) return false;
      if (occ.lte && v > occ.lte) return false;
    }
    return true;
  };
  const withTenant = jest.fn(async (_tid: string, fn: (tx: unknown) => Promise<unknown>) => fn(tx));
  const tx = {
    auditLog: {
      findMany: jest.fn(
        async (args: {
          where?: Record<string, unknown>;
          select?: Record<string, boolean>;
          skip?: number;
          take?: number;
        }) => {
          calls.push({ where: args.where, select: args.select });
          let out = rows.filter((r) => match(r, args.where));
          out = [...out].sort((a, b) => ((a.occurredAt as Date) < (b.occurredAt as Date) ? 1 : -1)); // desc
          const skip = args.skip ?? 0;
          out = args.take === undefined ? out.slice(skip) : out.slice(skip, skip + args.take);
          const select = args.select ?? {};
          return out.map((r) => {
            const proj: Record<string, unknown> = {};
            for (const k of Object.keys(select)) proj[k] = r[k];
            return proj;
          });
        },
      ),
      count: jest.fn(
        async (args: { where?: Record<string, unknown> }) =>
          rows.filter((r) => match(r, args.where)).length,
      ),
    },
  };
  const prisma = { withTenant };
  const service = new TenantAdminService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    // IdentityOutboxService seam: removal enqueues in-transaction, then the
    // Clerk call runs outside it.
    {
      enqueueClerkMembershipDelete: jest.fn(async () => 'job-1'),
      attemptNow: jest.fn(async () => true),
    } as never,
  );
  return { service, withTenant, calls, findMany: tx.auditLog.findMany };
}

const ROWS = [
  {
    id: 'a1',
    tenantId: 'tenant-1',
    action: 'impersonation.start',
    actorRole: 'capiro_admin',
    entityType: 'impersonation_session',
    entityId: 's1',
    occurredAt: D('2026-06-01T00:00:00Z'),
    // internal fields that MUST NOT be exposed to the customer:
    actorUserId: 'capiro-staff-uuid',
    ip: '10.0.0.1',
    userAgent: 'curl',
    requestId: 'req-1',
    before: { secret: 'internal' },
    after: { reason: 'debugging their tenant' },
  },
  {
    id: 'a2',
    tenantId: 'tenant-1',
    action: 'tenant.user.remove',
    actorRole: 'capiro_admin',
    entityType: 'tenant_membership',
    entityId: 'mem-1',
    occurredAt: D('2026-06-03T00:00:00Z'),
    actorUserId: 'capiro-staff-uuid',
  },
  {
    // a DIFFERENT tenant's row — must never appear
    id: 'other',
    tenantId: 'tenant-2',
    action: 'impersonation.start',
    actorRole: 'capiro_admin',
    entityType: 'impersonation_session',
    entityId: 'sX',
    occurredAt: D('2026-06-04T00:00:00Z'),
  },
];

describe('TenantAdminService.listAuditLogs (#3d customer read route)', () => {
  test('scopes to the caller tenant (withTenant + explicit where.tenantId) and orders desc', async () => {
    const { service, withTenant, calls } = makeService(ROWS);
    const result = await service.listAuditLogs(CTX, {});
    expect(withTenant).toHaveBeenCalledWith(CTX.tenantId, expect.any(Function));
    expect(calls[0]?.where?.tenantId).toBe(CTX.tenantId); // defense-in-depth, not RLS-only
    expect(result.total).toBe(2); // tenant-2 row excluded
    expect(result.data.map((r) => (r as { id: string }).id)).toEqual(['a2', 'a1']); // newest first
    expect(result.page).toBe(1);
    expect(result.limit).toBe(50);
  });

  test('returns ONLY the customer-safe projection — never internal fields', async () => {
    const { service } = makeService(ROWS);
    const result = await service.listAuditLogs(CTX, {});
    const row = result.data[0] as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(
      ['action', 'actorRole', 'entityId', 'entityType', 'id', 'occurredAt'].sort(),
    );
    // the sensitive internal fields must be absent
    for (const leak of ['actorUserId', 'ip', 'userAgent', 'requestId', 'before', 'after']) {
      expect(row).not.toHaveProperty(leak);
    }
  });

  test('filters by action and by date range', async () => {
    const { service } = makeService(ROWS);
    const byAction = await service.listAuditLogs(CTX, { action: 'tenant.user.remove' });
    expect(byAction.total).toBe(1);
    expect((byAction.data[0] as { entityId: string }).entityId).toBe('mem-1');

    const byDate = await service.listAuditLogs(CTX, {
      from: '2026-06-02T00:00:00Z',
      to: '2026-06-03T12:00:00Z',
    });
    expect(byDate.total).toBe(1);
    expect((byDate.data[0] as { id: string }).id).toBe('a2');
  });

  test('paginates and caps limit at 100', async () => {
    const { service } = makeService(ROWS);
    const r = await service.listAuditLogs(CTX, { page: 2, limit: 500 });
    expect(r.page).toBe(2);
    expect(r.limit).toBe(100); // capped
  });
});
