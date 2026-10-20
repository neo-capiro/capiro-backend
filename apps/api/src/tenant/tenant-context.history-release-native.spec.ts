import { describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import type { ClerkService } from '../auth/clerk.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { TenantContextMiddleware } from './tenant-context.middleware.js';
import type { TenantContextStore } from './tenant-context.store.js';

jest.mock('@clerk/backend', () => ({
  __esModule: true,
  createClerkClient: () => ({}),
  verifyToken: async () => ({}),
}));

const path = '/api/clio/application-authority/history-release';
const user = { id: '00000000-0000-7000-8000-000000000001', clerkUserId: 'user_original' };
const tenant = {
  id: '00000000-0000-7000-8000-000000000002', slug: 'original',
  clerkOrgId: 'org_original', status: 'active',
};
const membership = {
  id: '00000000-0000-7000-8000-000000000003', tenantId: tenant.id,
  userId: user.id, role: 'standard_user', status: 'active',
  updatedAt: new Date(10), tenant,
};
const claims = {
  sub: user.clerkUserId, sid: 'session_original',
  iss: 'https://clerk.app.capiro.ai', exp: Math.floor(Date.now() / 1000) + 1800,
  org_id: tenant.clerkOrgId, capiro_tenant_id: tenant.id, capiro_tenant_slug: tenant.slug,
};

function fixture() {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const tx: any = {
    user: {
      findUnique: jest.fn(async () => user), findFirst: jest.fn(async () => user),
      update: jest.fn(async () => user),
    },
    tenantMembership: {
      findMany: jest.fn(async () => [membership]), findFirst: jest.fn(async () => membership),
    },
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?');
      queries.push({ sql, values });
      if (sql.includes('FROM users')) return [{ id: user.id }];
      if (sql.includes('FROM tenants')) return [{ id: tenant.id }];
      if (sql.includes('FROM tenant_memberships')) return [{ id: membership.id }];
      throw new Error('Unexpected identity lock query');
    }),
  };
  const session = {
    id: claims.sid, userId: claims.sub, status: 'active', createdAt: 1,
    expireAt: Date.now() + 100_000, abandonAt: Date.now() + 90_000,
    actor: null, expiresAtMs: Date.now() + 80_000,
  };
  const active = jest.fn(async () => session);
  const clerk = {
    verifySessionToken: jest.fn(async () => ({ ...claims })),
    assertActiveApplicationAuthoritySession: active,
  } as unknown as ClerkService;
  const withSystem = jest.fn(async (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx));
  const prisma = { withSystem } as unknown as PrismaService;
  const store = { run: jest.fn((_ctx: unknown, fn: () => void) => fn()) } as unknown as TenantContextStore;
  const middleware = new TenantContextMiddleware(clerk, prisma, store);
  const headers: Record<string, string> = { authorization: 'Bearer live-clerk-session', host: 'app.capiro.ai' };
  const req = {
    method: 'POST', path, originalUrl: path, url: path, baseUrl: '',
    hostname: 'app.capiro.ai', headers,
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request & { tenantContext?: any };
  const responseHeaders = new Map<string, string>();
  const res = {
    setHeader: (name: string, value: string) => responseHeaders.set(name.toLowerCase(), value),
  } as unknown as Response;
  return { middleware, req, res, tx, queries, active, withSystem, responseHeaders };
}

async function authenticate(h: ReturnType<typeof fixture>) {
  const next = jest.fn();
  await h.middleware.use(h.req, h.res, next);
  expect(next).toHaveBeenCalledTimes(1);
  expect(h.req.tenantContext).toMatchObject({
    userId: user.id, tenantId: tenant.id, clerkUserId: user.clerkUserId,
  });
  expect(h.responseHeaders.get('cache-control')).toBe('no-store');
  return h.req.tenantContext;
}

describe('history release native identity transaction leaf', () => {
  it('locks the original user, tenant and member by pinned identity before release', async () => {
    const h = fixture();
    const ctx = await authenticate(h);
    await h.middleware.lockOriginalApplicationAuthorityInTransaction(h.req, ctx, h.tx);
    expect(h.queries.map((query) => query.sql)).toEqual([
      expect.stringContaining('FROM users'),
      expect.stringContaining('FROM tenants'),
      expect.stringContaining('FROM tenant_memberships'),
    ]);
    expect(h.queries.every((query) => query.sql.includes('FOR SHARE'))).toBe(true);
    expect(h.queries.map((query) => query.values)).toEqual([
      [user.id, claims.sub], [tenant.id], [membership.id, tenant.id, user.id],
    ]);
  });

  it('rechecks the same online session and local facts on the caller transaction', async () => {
    const h = fixture();
    const ctx = await authenticate(h);
    const leaseCount = h.withSystem.mock.calls.length;
    const evidence = await h.middleware.readFreshApplicationAuthorityInTransaction(h.req, ctx, h.tx);
    expect(h.active).toHaveBeenCalledTimes(1);
    expect(h.active).toHaveBeenCalledWith(expect.objectContaining({ sub: claims.sub, sid: claims.sid }));
    expect(h.withSystem).toHaveBeenCalledTimes(leaseCount);
    expect(h.tx.user.findFirst).toHaveBeenCalledWith({
      where: { id: user.id, clerkUserId: claims.sub }, select: { id: true, clerkUserId: true },
    });
    expect(h.tx.tenantMembership.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: membership.id, tenantId: tenant.id, userId: user.id, status: 'active' },
    }));
    expect(evidence.principal).toEqual({ tenantId: tenant.id, actorId: user.id });
  });

  it('refuses changed context or ambiguous target before identity lock and online check', async () => {
    const h = fixture();
    const ctx = await authenticate(h);
    await expect(h.middleware.lockOriginalApplicationAuthorityInTransaction(
      h.req, { ...ctx }, h.tx,
    )).rejects.toMatchObject({ status: 403 });
    h.req.originalUrl = `${path}?selectedClient=other`;
    await expect(h.middleware.readFreshApplicationAuthorityInTransaction(
      h.req, ctx, h.tx,
    )).rejects.toMatchObject({ status: 403 });
    expect(h.queries).toHaveLength(0);
    expect(h.active).not.toHaveBeenCalled();
  });
});
