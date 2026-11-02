import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ForbiddenException } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ClerkService, ClerkSessionClaims } from '../auth/clerk.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { TenantContextMiddleware } from './tenant-context.middleware.js';
import type { TenantContextStore } from './tenant-context.store.js';

// The real Clerk SDK has a #crypto import that Jest cannot resolve. The fake
// below exercises the middleware boundary without contacting Clerk.
jest.mock('@clerk/backend', () => ({
  __esModule: true,
  createClerkClient: () => ({}),
  verifyToken: async () => ({}),
}));

const previewHost = 'first-chat-preview.app-dev.capiro.ai';
const priorPreviewSetting = process.env.PREVIEW_NATIVE_GETS_ENABLED;
const claims: ClerkSessionClaims = {
  sub: 'clerk_preview_actor',
  iss: 'https://clerk.app.capiro.ai',
  sid: 'sess_preview',
  exp: Math.floor(Date.now() / 1000) + 1800,
  org_id: 'org_preview',
  capiro_tenant_id: 'tenant_preview',
  capiro_tenant_slug: 'preview',
};
const user = { id: 'actor_preview', clerkUserId: claims.sub };
const membership = {
  id: 'member_preview', userId: user.id, tenantId: 'tenant_preview',
  role: 'standard_user', status: 'active',
  tenant: { id: 'tenant_preview', clerkOrgId: 'org_preview', slug: 'preview', status: 'active' },
};

function fixture(path = '/api/me', host = previewHost, method = 'GET', originalUrl = path,
  verifiedClaims: ClerkSessionClaims = claims) {
  // Keep all possible local mutations visible. In particular, the ordinary
  // middleware can create/rebind a user, self-heal a member and update lastSeenAt.
  const tx: any = {
    user: {
      findUnique: jest.fn(async () => user), findFirst: jest.fn(),
      create: jest.fn(), update: jest.fn(async () => user), upsert: jest.fn(), delete: jest.fn(),
    },
    tenantMembership: {
      findMany: jest.fn(async () => [membership]), findUnique: jest.fn(), findFirst: jest.fn(),
      create: jest.fn(), update: jest.fn(), upsert: jest.fn(), delete: jest.fn(),
    },
    tenant: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    auditLog: { create: jest.fn() },
    impersonationSession: { findFirst: jest.fn() },
  };
  const verify = jest.fn(async () => ({ ...verifiedClaims }));
  const active = jest.fn(async () => ({ id: 'session_preview' }));
  const clerk = {
    verifySessionToken: verify,
    assertActiveApplicationAuthoritySession: active,
  } as unknown as ClerkService;
  const system = jest.fn(async (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx));
  const prisma = { withSystem: system } as unknown as PrismaService;
  const run = jest.fn((_ctx: unknown, continuation: () => void) => continuation());
  const store = { run } as unknown as TenantContextStore;
  const middleware = new TenantContextMiddleware(clerk, prisma, store);
  const headers = new Map<string, string>();
  const request = {
    method,
    headers: { host, authorization: 'Bearer native-session' },
    rawHeaders: ['Host', host],
    path: path.split('?')[0], originalUrl, url: originalUrl, baseUrl: '', hostname: host,
    header: jest.fn(() => undefined),
  } as unknown as Request & { tenantContext?: unknown };
  const response = {
    setHeader(name: string, value: string) { headers.set(name.toLowerCase(), value); },
  } as unknown as Response;
  const next = jest.fn();
  const mutations = [
    tx.user.create, tx.user.update, tx.user.upsert, tx.user.delete,
    tx.tenantMembership.create, tx.tenantMembership.update,
    tx.tenantMembership.upsert, tx.tenantMembership.delete,
    tx.tenant.create, tx.tenant.update, tx.auditLog.create,
  ];
  return { middleware, request, response, next, tx, verify, active, system, run, headers, mutations };
}

function expectNoLocalMutation(mutations: readonly unknown[]) {
  for (const mutation of mutations) expect(mutation).not.toHaveBeenCalled();
}

describe('TenantContextMiddleware preview native GET context', () => {
  beforeEach(() => { process.env.PREVIEW_NATIVE_GETS_ENABLED = 'true'; });
  it.each(['versions', 'evidence'])('keeps %s GET/HEAD on existing-member resolution, including malformed IDs', async leaf => {
    for (const method of ['GET', 'HEAD']) {
      for (const itemId of ['11111111-1111-4111-8111-111111111111', 'not-a-uuid']) {
        const path = `/api/memory/owner/items/${itemId}/${leaf}?limit=25`;
        const h = fixture(path, previewHost, method);
        await h.middleware.use(h.request, h.response, h.next);
        expect(h.active).toHaveBeenCalledTimes(1);
        expect(h.next).toHaveBeenCalledTimes(1);
        expect(h.request.tenantContext).toMatchObject({ userId: user.id, tenantId: membership.tenantId });
        expect(h.tx.user.findUnique).toHaveBeenCalled();
        expect(h.tx.tenantMembership.findMany).toHaveBeenCalled();
        expect(h.tx.user.findFirst).not.toHaveBeenCalled();
        expectNoLocalMutation(h.mutations);
      }
    }
  });
  afterEach(() => {
    if (priorPreviewSetting === undefined) delete process.env.PREVIEW_NATIVE_GETS_ENABLED;
    else process.env.PREVIEW_NATIVE_GETS_ENABLED = priorPreviewSetting;
  });

  it.each([
    '/api/me', '/api/clients?includeArchived=true', '/api/clients/11111111-1111-4111-8111-111111111111',
    '/api/client-account-owners', '/api/client-account-owners/options', '/api/billing/state',
    '/api/memory/candidates/mine?limit=25',
    '/api/memory/candidates/mine/11111111-1111-4111-8111-111111111111/status',
    '/api/memory/owner/items?limit=25',
    '/api/clio/completed-reports?limit=10',
    '/api/clio/completed-reports/11111111-1111-4111-8111-111111111111',
  ])
  ('resolves %s from an online native session and existing member without local writes', async (path) => {
    const h = fixture(path);
    await h.middleware.use(h.request, h.response, h.next);
    expect(h.next).toHaveBeenCalledTimes(1);
    expect(h.verify).toHaveBeenCalledWith('native-session');
    expect(h.active).toHaveBeenCalledWith(expect.objectContaining({ sub: claims.sub, sid: claims.sid, exp: claims.exp }));
    expect(h.verify.mock.invocationCallOrder[0]).toBeLessThan(h.active.mock.invocationCallOrder[0]!);
    expect(h.active.mock.invocationCallOrder[0]).toBeLessThan(h.system.mock.invocationCallOrder[0]!);
    expect(h.tx.user.findUnique).toHaveBeenCalledTimes(1);
    expect(h.tx.user.findUnique).toHaveBeenCalledWith({ where: { clerkUserId: claims.sub } });
    expect(h.tx.tenantMembership.findMany).toHaveBeenCalledWith({
      where: { userId: user.id, status: 'active' }, include: { tenant: true },
    });
    expect(h.request.tenantContext).toMatchObject({
      tenantId: membership.tenantId, userId: user.id, role: membership.role,
    });
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.headers.get('cache-control')).toBe('no-store');
    expectNoLocalMutation(h.mutations);
  });

  it.each([
    ['POST', '/api/clients'],
    ['PUT', '/api/clients/11111111-1111-4111-8111-111111111111'],
    ['DELETE', '/api/clients/11111111-1111-4111-8111-111111111111'],
    ['PUT', '/api/clients/11111111-1111-4111-8111-111111111111/account-owners'],
  ])('resolves %s %s online without provisioning; revoked sessions never reach the writer', async (method, path) => {
    const h = fixture(path, previewHost, method);
    await h.middleware.use(h.request, h.response, h.next);
    expect(h.active).toHaveBeenCalledTimes(1);
    expect(h.active.mock.invocationCallOrder[0]).toBeLessThan(h.system.mock.invocationCallOrder[0]!);
    expect(h.next).toHaveBeenCalledTimes(1);
    expectNoLocalMutation(h.mutations);
    const revoked = fixture(path, previewHost, method);
    revoked.active.mockRejectedValueOnce(new ForbiddenException('Revoked'));
    await expect(revoked.middleware.use(revoked.request, revoked.response, revoked.next)).rejects.toMatchObject({ status: 403 });
    expect(revoked.system).not.toHaveBeenCalled(); expect(revoked.next).not.toHaveBeenCalled();
    expectNoLocalMutation(revoked.mutations);
  });

  it.each([
    '/api/me', '/api/clients/11111111-1111-4111-8111-111111111111',
    '/api/memory/candidates/mine', '/api/memory/owner/items',
    '/api/clio/completed-reports',
    '/api/clio/completed-reports/11111111-1111-4111-8111-111111111111',
  ])
  ('keeps HEAD %s on the online native read-only path', async (path) => {
    const h = fixture(path, previewHost, 'HEAD');
    await h.middleware.use(h.request, h.response, h.next);
    expect(h.next).toHaveBeenCalledTimes(1);
    expect(h.verify).toHaveBeenCalledWith('native-session');
    expect(h.active).toHaveBeenCalledTimes(1);
    expect(h.active.mock.invocationCallOrder[0]).toBeLessThan(h.system.mock.invocationCallOrder[0]!);
    expect(h.tx.user.findUnique).toHaveBeenCalledWith({ where: { clerkUserId: claims.sub } });
    expect(h.tx.tenantMembership.findMany).toHaveBeenCalledTimes(1);
    expect(h.headers.get('cache-control')).toBe('no-store');
    expectNoLocalMutation(h.mutations);
  });

  it('checks native authority for an absolute-form target parsed by Express as /api/me', async () => {
    const h = fixture('/api/me', previewHost, 'GET', `http://${previewHost}/api/me`);
    await h.middleware.use(h.request, h.response, h.next);
    expect(h.next).toHaveBeenCalledTimes(1);
    expect(h.verify).toHaveBeenCalledWith('native-session');
    expect(h.active).toHaveBeenCalledTimes(1);
    expect(h.active.mock.invocationCallOrder[0]).toBeLessThan(h.system.mock.invocationCallOrder[0]!);
    expect(h.tx.user.findUnique).toHaveBeenCalledWith({ where: { clerkUserId: claims.sub } });
    expect(h.headers.get('cache-control')).toBe('no-store');
    expectNoLocalMutation(h.mutations);
  });

  it.each([
    '/api/clio/completed-reports',
    '/api/clio/completed-reports/11111111-1111-4111-8111-111111111111',
  ])('refuses completed-reports missing user/member and revoked native sessions without repair: %s', async (path) => {
    const missing = fixture(path);
    missing.tx.user.findUnique.mockResolvedValueOnce(null);
    await expect(missing.middleware.use(missing.request, missing.response, missing.next)).rejects.toMatchObject({ status: 403 });
    expect(missing.next).not.toHaveBeenCalled(); expectNoLocalMutation(missing.mutations);
    const removed = fixture(path);
    removed.tx.tenantMembership.findMany.mockResolvedValueOnce([]);
    await expect(removed.middleware.use(removed.request, removed.response, removed.next)).rejects.toMatchObject({ status: 403 });
    expect(removed.next).not.toHaveBeenCalled(); expectNoLocalMutation(removed.mutations);
    const revoked = fixture(path);
    revoked.active.mockRejectedValueOnce(new ForbiddenException('Revoked'));
    await expect(revoked.middleware.use(revoked.request, revoked.response, revoked.next)).rejects.toMatchObject({ status: 403 });
    expect(revoked.system).not.toHaveBeenCalled(); expect(revoked.next).not.toHaveBeenCalled(); expectNoLocalMutation(revoked.mutations);
  });

  it.each(['GET', 'HEAD'])('checks native authority for absolute-form %s', async (method) => {
    const h = fixture('/api/me', previewHost, method, `http://${previewHost}/api/me`);
    await h.middleware.use(h.request, h.response, h.next);
    expect(h.next).toHaveBeenCalledTimes(1);
    expect(h.active).toHaveBeenCalledWith(expect.objectContaining({ sid: claims.sid, sub: claims.sub }));
    expect(h.active.mock.invocationCallOrder[0]).toBeLessThan(h.system.mock.invocationCallOrder[0]!);
    expect(h.headers.get('cache-control')).toBe('no-store');
    expectNoLocalMutation(h.mutations);
  });

  it.each([
    { credential: 'sidless', verifiedClaims: { ...claims, sid: undefined } },
    { credential: 'marked control', verifiedClaims: { ...claims, sid: undefined, meri_control_credential: true,
      iat: claims.exp! - 60, jti: 'control_preview' } },
    { credential: 'marked with sid', verifiedClaims: { ...claims, meri_control_credential: true,
      iat: claims.exp! - 60, jti: 'control_preview' } },
  ])('refuses a $credential credential on every preview read before local DB access', async ({ verifiedClaims }) => {
    for (const [method, path, originalUrl] of [
      ['GET', '/api/me', '/api/me'],
      ['HEAD', '/api/clients', '/api/clients'],
      ['GET', '/api/memory/candidates/mine', '/api/memory/candidates/mine'],
      ['HEAD', '/api/memory/owner/items', '/api/memory/owner/items'],
      ['GET', '/api/me', `http://${previewHost}/api/me`],
      ['HEAD', '/api/me', `http://${previewHost}/api/me`],
    ]) {
      const h = fixture(path!, previewHost, method!, originalUrl!, verifiedClaims as ClerkSessionClaims);
      await expect(h.middleware.use(h.request, h.response, h.next)).rejects.toMatchObject({ status: 401 });
      expect(h.verify).toHaveBeenCalledTimes(1);
      expect(h.system).not.toHaveBeenCalled();
      expect(h.next).not.toHaveBeenCalled();
      expect(h.headers.get('cache-control')).toBe('no-store');
      expectNoLocalMutation(h.mutations);
    }
  });

  it('refuses an unknown Clerk actor without an email fallback, create or identity rebind', async () => {
    const h = fixture();
    h.tx.user.findUnique.mockResolvedValue(null);
    await expect(h.middleware.use(h.request, h.response, h.next)).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.tx.user.findUnique).toHaveBeenCalledTimes(1);
    expect(h.tx.tenantMembership.findMany).not.toHaveBeenCalled();
    expect(h.next).not.toHaveBeenCalled();
    expectNoLocalMutation(h.mutations);
  });

  it.each([
    { caseName: 'missing', memberships: [] },
    { caseName: 'removed', memberships: [{ ...membership, status: 'removed' }] },
    { caseName: 'inactive tenant', memberships: [{ ...membership, tenant: { ...membership.tenant, status: 'inactive' } }] },
  ])('refuses $caseName membership without self-heal', async ({ memberships }) => {
    const h = fixture();
    h.tx.tenantMembership.findMany.mockResolvedValue(memberships);
    await expect(h.middleware.use(h.request, h.response, h.next)).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.next).not.toHaveBeenCalled();
    expectNoLocalMutation(h.mutations);
  });

  it('rejects an online-revoked session before local database access', async () => {
    const h = fixture();
    h.active.mockImplementation(async () => { throw new ForbiddenException('Revoked session'); });
    await expect(h.middleware.use(h.request, h.response, h.next)).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.verify).toHaveBeenCalledTimes(1);
    expect(h.system).not.toHaveBeenCalled();
    expect(h.next).not.toHaveBeenCalled();
    expectNoLocalMutation(h.mutations);
  });

  it.each([
    { enabled: 'false', host: previewHost },
    { enabled: 'true', host: 'app.capiro.ai' },
    { enabled: 'true', host: `${previewHost}:443` },
  ])('refuses a preview task Host/flag mismatch before auth or DB (%#)', async ({ enabled, host }) => {
    process.env.PREVIEW_NATIVE_GETS_ENABLED = enabled;
    for (const path of ['/api/me', '/api/memory/candidates/mine', '/api/memory/owner/items']) {
      const h = fixture(path, host);
      await expect(h.middleware.use(h.request, h.response, h.next)).rejects.toMatchObject({ status: 503 });
      expect(h.headers.get('cache-control')).toBe('no-store');
      expect(h.verify).not.toHaveBeenCalled();
      expect(h.system).not.toHaveBeenCalled();
      expect(h.next).not.toHaveBeenCalled();
    }
  });

  it('leaves the ordinary host with the flag off on the existing update path', async () => {
    process.env.PREVIEW_NATIVE_GETS_ENABLED = 'false';
    const h = fixture('/api/me', 'app.capiro.ai');
    await h.middleware.use(h.request, h.response, h.next);
    expect(h.next).toHaveBeenCalledTimes(1);
    expect(h.active).not.toHaveBeenCalled();
    expect(h.tx.user.update).toHaveBeenCalledWith({
      where: { id: user.id }, data: { lastSeenAt: expect.any(Date) },
    });
  });

  it.each([
    ['POST', '/api/clients/11111111-1111-4111-8111-111111111111/people'],
    ['GET', '/api/clients/11111111-1111-4111-8111-111111111111/people/requests/22222222-2222-4222-8222-222222222222'],
    ['POST', '/api/clients/11111111-1111-4111-8111-111111111111/activity-commands/22222222-2222-4222-8222-222222222222/undo'],
    ['PATCH', '/api/clients/11111111-1111-4111-8111-111111111111/files/22222222-2222-4222-8222-222222222222/folder'],
  ])('authenticates canonical nested route through the ordinary resolver: %s %s', async (method, path) => {
    const h = fixture(path, previewHost, method);
    await h.middleware.use(h.request, h.response, h.next);
    expect(h.verify).toHaveBeenCalledWith('native-session');
    expect(h.request.tenantContext).toEqual({
      tenantId: membership.tenantId, tenantSlug: membership.tenant.slug,
      userId: user.id, clerkUserId: user.clerkUserId, role: membership.role,
    });
    expect(h.next).toHaveBeenCalledTimes(1);
    expect(h.active).not.toHaveBeenCalled();
    expect(h.tx.user.update).toHaveBeenCalledWith({
      where: { id: user.id }, data: { lastSeenAt: expect.any(Date) },
    });
  });

  it('still rejects a missing bearer on an ordinary nested route before DB', async () => {
    const h = fixture('/api/clients/11111111-1111-4111-8111-111111111111/people', previewHost, 'POST');
    delete h.request.headers.authorization;
    await expect(h.middleware.use(h.request, h.response, h.next)).rejects.toMatchObject({ status: 401 });
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.system).not.toHaveBeenCalled();
    expect(h.next).not.toHaveBeenCalled();
  });

  it('retains ordinary tenant-claim isolation on a nested route', async () => {
    const h = fixture('/api/clients/11111111-1111-4111-8111-111111111111/people', previewHost, 'POST',
      '/api/clients/11111111-1111-4111-8111-111111111111/people', { ...claims, capiro_tenant_id: 'other_tenant' });
    await expect(h.middleware.use(h.request, h.response, h.next)).rejects.toMatchObject({ status: 403 });
    expect(h.verify).toHaveBeenCalledTimes(1);
    expect(h.next).not.toHaveBeenCalled();
    expect(h.tx.user.update).not.toHaveBeenCalled();
  });
});
