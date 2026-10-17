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
  org_id: 'org_preview',
  capiro_tenant_id: 'tenant_preview',
  capiro_tenant_slug: 'preview',
} as ClerkSessionClaims;
const user = { id: 'actor_preview', clerkUserId: claims.sub };
const membership = {
  id: 'member_preview', userId: user.id, tenantId: 'tenant_preview',
  role: 'standard_user', status: 'active',
  tenant: { id: 'tenant_preview', clerkOrgId: 'org_preview', slug: 'preview', status: 'active' },
};

function fixture(path = '/api/me', host = previewHost, method = 'GET', originalUrl = path) {
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
  const verify = jest.fn(async () => ({ ...claims }));
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
  afterEach(() => {
    if (priorPreviewSetting === undefined) delete process.env.PREVIEW_NATIVE_GETS_ENABLED;
    else process.env.PREVIEW_NATIVE_GETS_ENABLED = priorPreviewSetting;
  });

  it.each(['/api/me', '/api/clients?includeArchived=true', '/api/clients/11111111-1111-4111-8111-111111111111'])
  ('resolves %s from an online native session and existing member without local writes', async (path) => {
    const h = fixture(path);
    await h.middleware.use(h.request, h.response, h.next);
    expect(h.next).toHaveBeenCalledTimes(1);
    expect(h.verify).toHaveBeenCalledWith('native-session');
    expect(h.active).toHaveBeenCalledWith(expect.objectContaining({ sub: claims.sub }));
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

  it.each(['/api/me', '/api/clients/11111111-1111-4111-8111-111111111111'])
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
    const h = fixture('/api/me', host);
    await expect(h.middleware.use(h.request, h.response, h.next)).rejects.toMatchObject({ status: 503 });
    expect(h.headers.get('cache-control')).toBe('no-store');
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.system).not.toHaveBeenCalled();
    expect(h.next).not.toHaveBeenCalled();
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
});
