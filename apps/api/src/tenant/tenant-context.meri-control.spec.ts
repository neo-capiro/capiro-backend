import { describe, expect, it, jest } from '@jest/globals';
import { UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ClerkService, ClerkSessionClaims } from '../auth/clerk.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { TenantContextMiddleware } from './tenant-context.middleware.js';
import type { TenantContextStore } from './tenant-context.store.js';

// The injected Clerk port is synthetic. No credential, SDK or database is used.
jest.mock('@clerk/backend', () => ({
  __esModule: true,
  createClerkClient: () => ({}),
  verifyToken: async () => ({}),
}));

const actor = { id: 'actor_control', clerkUserId: 'clerk_control' };
const tenant = { id: 'tenant_control', clerkOrgId: 'org_control', slug: 'control', status: 'active' };
const member = {
  id: 'member_control', userId: actor.id, tenantId: tenant.id,
  role: 'standard_user', status: 'active', updatedAt: new Date(2), tenant,
};
const futureExp = () => Math.floor(Date.now() / 1000) + 120;

function fixture(method: string, path: string, options: {
  marked?: boolean; originalUrl?: string; baseUrl?: string; sid?: string;
  claimOverrides?: Partial<ClerkSessionClaims>;
} = {}) {
  const claims: ClerkSessionClaims = {
    sub: actor.clerkUserId,
    iss: 'https://clerk.app.capiro.ai',
    exp: futureExp(),
    ...(options.marked === false ? { sid: options.sid ?? 'sess_native' } : {
      meri_control_credential: true, jti: 'control_jti', iat: futureExp() - 120,
      ...(options.sid ? { sid: options.sid } : {}),
    }),
    org_id: tenant.clerkOrgId,
    capiro_tenant_id: tenant.id,
    capiro_tenant_slug: tenant.slug,
    ...options.claimOverrides,
  };
  const onlineSession = {
    id: options.marked === false ? 'sess_native' : 'meri-template:control_jti',
    userId: actor.clerkUserId, status: 'active', createdAt: 1,
    expireAt: Date.now() + 120_000, abandonAt: Date.now() + 120_000,
    actor: null, expiresAtMs: Date.now() + 60_000,
  };
  const tx = {
    user: {
      findUnique: jest.fn(async () => actor), findFirst: jest.fn(async () => actor),
      create: jest.fn(), update: jest.fn(async () => actor),
    },
    tenantMembership: {
      findMany: jest.fn(async () => [member]), findFirst: jest.fn(async () => member),
      create: jest.fn(), update: jest.fn(),
    },
    tenant: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    auditLog: { create: jest.fn() },
    impersonationSession: { findFirst: jest.fn() },
  };
  const verify = jest.fn(async () => claims);
  const controlSession = jest.fn(async () => onlineSession);
  const nativeSession = jest.fn(async () => onlineSession);
  const clerk = {
    verifySessionToken: verify,
    assertActiveMeriControlCredentialSession: controlSession,
    assertActiveApplicationAuthoritySession: nativeSession,
  } as unknown as ClerkService;
  const system = jest.fn(async (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx));
  const prisma = { withSystem: system } as unknown as PrismaService;
  const store = { run: jest.fn((_ctx: unknown, continuation: () => void) => continuation()) } as unknown as TenantContextStore;
  const middleware = new TenantContextMiddleware(clerk, prisma, store);
  const originalUrl = options.originalUrl ?? path;
  const req = {
    method, path, originalUrl, url: originalUrl, baseUrl: options.baseUrl ?? '',
    hostname: 'app.capiro.ai',
    headers: { authorization: 'Bearer verified-token', host: 'app.capiro.ai' },
    header: jest.fn(() => undefined),
  } as unknown as Request & { tenantContext?: unknown };
  const headers = new Map<string, string>();
  const res = { setHeader: (name: string, value: string) => { headers.set(name.toLowerCase(), value); } } as unknown as Response;
  const next = jest.fn();
  return { middleware, req, res, next, tx, verify, controlSession, nativeSession, system, headers };
}

describe('marked Meri control credential route boundary', () => {
  it.each(['identity', 'context', 'membership', 'current'])(
    'admits the exact mounted %s target without broadening the original target check', async (operation) => {
      const target = `/api/clio/application-authority/${operation}`;
      for (const [baseUrl, path] of [[target, '/'], ['/api/clio/application-authority', `/${operation}`]] as const) {
        const f = fixture('POST', path, { baseUrl, originalUrl: target });
        await f.middleware.use(f.req, f.res, f.next);
        expect(f.next).toHaveBeenCalledTimes(1);
        const identity = await f.middleware.readApplicationAuthority(f.req, f.req.tenantContext! as never);
        expect(identity.principal).toEqual({ tenantId: tenant.id, actorId: actor.id });
        expect(f.controlSession).toHaveBeenCalledTimes(2);
      }
    },
  );

  it.each([
    '/api/clio/application-authority/identity/',
    '/api/clio/conversations/bootstrap',
    'http://app.capiro.ai/api/clio/application-authority/identity',
  ])('refuses a mounted identity route whose original target differs: %s', async (originalUrl) => {
    const f = fixture('POST', '/', { baseUrl: '/api/clio/application-authority/identity', originalUrl });
    await expect(f.middleware.use(f.req, f.res, f.next)).rejects.toMatchObject({ status: 401 });
    expect(f.system).not.toHaveBeenCalled();
    expect(f.next).not.toHaveBeenCalled();
  });

  it.each([
    '/api/clio/application-authority/identity',
    '/api/clio/application-authority/context',
    '/api/clio/application-authority/membership',
    '/api/clio/application-authority/current',
  ])('accepts only the exact authority POST and checks the dedicated online control owner for %s', async (path) => {
    const f = fixture('POST', path);
    await f.middleware.use(f.req, f.res, f.next);
    expect(f.next).toHaveBeenCalledTimes(1);
    expect(f.req.tenantContext).toMatchObject({ tenantId: tenant.id, userId: actor.id });
    expect(f.headers.get('cache-control')).toBe('no-store');
    expect(f.controlSession).toHaveBeenCalledTimes(1);
    expect(f.controlSession.mock.invocationCallOrder[0]).toBeLessThan(f.system.mock.invocationCallOrder[0]!);
    const beforeRead = f.system.mock.calls.length;
    const identity = await f.middleware.readApplicationAuthority(f.req, f.req.tenantContext! as never);
    expect(identity.principal).toEqual({ tenantId: tenant.id, actorId: actor.id });
    expect(f.controlSession).toHaveBeenCalledTimes(2);
    expect(f.controlSession).toHaveBeenCalledWith(expect.objectContaining({ meri_control_credential: true, sub: actor.clerkUserId }));
    expect(f.nativeSession).not.toHaveBeenCalled();
    expect(f.system.mock.calls.length).toBe(beforeRead + 1);
    expect(f.controlSession.mock.invocationCallOrder[1]).toBeLessThan(f.system.mock.invocationCallOrder[beforeRead]!);
  });

  it('refuses a revoked control credential before any tenant lookup, repair or activity write', async () => {
    const f = fixture('POST', '/api/clio/application-authority/identity');
    f.controlSession.mockImplementation(async () => { throw new UnauthorizedException('Revoked control credential'); });
    await expect(f.middleware.use(f.req, f.res, f.next)).rejects.toMatchObject({ status: 401 });
    expect(f.verify).toHaveBeenCalledTimes(1);
    expect(f.controlSession).toHaveBeenCalledTimes(1);
    expect(f.system).not.toHaveBeenCalled();
    expect(f.tx.user.create).not.toHaveBeenCalled();
    expect(f.tx.user.update).not.toHaveBeenCalled();
    expect(f.tx.tenantMembership.create).not.toHaveBeenCalled();
    expect(f.next).not.toHaveBeenCalled();
  });

  it.each([
    ['missing jti', { jti: undefined }],
    ['unbounded lifetime', { iat: 1 }],
    ['expired', { exp: 1 }],
    ['session id mixed into template', { sid: 'sess_wrong' }],
  ])('rejects a %s control shape before tenant lookup', async (_name, claimOverrides) => {
    const f = fixture('POST', '/api/clio/application-authority/identity', {
      claimOverrides: claimOverrides as Partial<ClerkSessionClaims>,
    });
    await expect(f.middleware.use(f.req, f.res, f.next)).rejects.toMatchObject({ status: 401 });
    expect(f.system).not.toHaveBeenCalled();
    expect(f.next).not.toHaveBeenCalled();
    expect(f.controlSession).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', '/api/me'],
    ['HEAD', '/api/clients'],
    ['POST', '/api/clio/conversations/bootstrap'],
    ['POST', '/api/clio/conversations'],
    ['POST', '/api/clio/tools/search_funding_opportunities'],
    ['GET', '/api/clio/application-authority/identity'],
    ['HEAD', '/api/clio/application-authority/context'],
    ['POST', '/api/clio/application-authority/identity/'],
    ['POST', '/api/clio/application-authority/identity-extra'],
    ['POST', '/api/clio/application-authority/IDENTITY'],
    ['POST', '/api/clio/application-authority/%69dentity'],
  ])('rejects marked %s %s before any local DB access', async (method, path) => {
    const f = fixture(method, path);
    await expect(f.middleware.use(f.req, f.res, f.next)).rejects.toMatchObject({ status: 401 });
    expect(f.verify).toHaveBeenCalledTimes(1);
    expect(f.system).not.toHaveBeenCalled();
    expect(f.next).not.toHaveBeenCalled();
    expect(f.controlSession).not.toHaveBeenCalled();
    expect(f.nativeSession).not.toHaveBeenCalled();
    expect(f.tx.user.update).not.toHaveBeenCalled();
  });

  it.each([
    '/api/clio/conversations/bootstrap',
    'http://app.capiro.ai/api/clio/application-authority/identity',
    '/api/clio/application-authority/context/',
  ])('refuses a rewritten or absolute-form control target before DB: %s', async (originalUrl) => {
    const f = fixture('POST', '/api/clio/application-authority/identity', { originalUrl });
    await expect(f.middleware.use(f.req, f.res, f.next)).rejects.toMatchObject({ status: 401 });
    expect(f.system).not.toHaveBeenCalled();
    expect(f.next).not.toHaveBeenCalled();
  });

  it('retains the ordinary native bearer path and uses the native online session owner', async () => {
    const f = fixture('POST', '/api/clio/application-authority/identity', { marked: false });
    await f.middleware.use(f.req, f.res, f.next);
    expect(f.next).toHaveBeenCalledTimes(1);
    const identity = await f.middleware.readApplicationAuthority(f.req, f.req.tenantContext! as never);
    expect(identity.principal).toEqual({ tenantId: tenant.id, actorId: actor.id });
    expect(f.nativeSession).toHaveBeenCalledTimes(1);
    expect(f.controlSession).not.toHaveBeenCalled();
  });

  it('does not turn an unmarked native bearer into a marked control credential', async () => {
    const f = fixture('POST', '/api/clio/conversations/bootstrap', { marked: false });
    await f.middleware.use(f.req, f.res, f.next);
    expect(f.next).toHaveBeenCalledTimes(1);
    expect(f.controlSession).not.toHaveBeenCalled();
  });
});
