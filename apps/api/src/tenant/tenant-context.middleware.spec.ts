import { describe, expect, jest, test, beforeEach } from '@jest/globals';
import { ForbiddenException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { TenantContextMiddleware } from './tenant-context.middleware.js';
import type { ClerkService, ClerkSessionClaims } from '../auth/clerk.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { TenantContextStore } from './tenant-context.store.js';

// @clerk/backend pulls in a `#crypto` subpath import that jest's resolver can't
// follow. The middleware is constructed with a fake ClerkService below, so the
// real SDK is never used — stub the module so importing clerk.service is cheap.
jest.mock('@clerk/backend', () => ({
  __esModule: true,
  createClerkClient: () => ({}),
  verifyToken: async () => ({}),
}));

/**
 * Unit tests for the tenant-context middleware, focused on the self-heal path
 * added after the 2026-05 Clerk-webhook routing outage (the ALB never forwarded
 * /webhooks/* to the API, so newly-invited users were never mirrored into the
 * local tenant_memberships table and got a hard 403). The middleware now
 * provisions the membership from the verified Clerk JWT when the mirror is
 * missing it — without resurrecting explicitly-removed memberships.
 */
describe('TenantContextMiddleware', () => {
  // A fake interactive-transaction client. Each model method is a jest mock the
  // individual tests configure.
  // The fake transaction client is typed `any` on purpose: it is a mock harness,
  // and @jest/globals' strict mock-value inference adds no safety value here.
  function makeTx() {
    const tx: any = {
      user: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
      tenantMembership: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
      tenant: { findUnique: jest.fn() },
      impersonationSession: { findFirst: jest.fn() },
    };
    // Best-effort calls the middleware always makes; give them benign defaults.
    tx.user.update.mockResolvedValue({}); // last_seen_at update (.catch-guarded)
    tx.impersonationSession.findFirst.mockResolvedValue(null);
    return tx;
  }
  type FakeTx = ReturnType<typeof makeTx>;

  function build(claims: Partial<ClerkSessionClaims>, tx: FakeTx) {
    const clerk = {
      verifySessionToken: jest.fn(() =>
        Promise.resolve({ sub: 'clerk_user', ...claims } as ClerkSessionClaims),
      ),
    } as unknown as ClerkService;
    const prisma = {
      withSystem: jest.fn((fn: (t: FakeTx) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaService;
    const store = {
      run: jest.fn((_ctx: unknown, cb: () => void) => cb()),
    } as unknown as TenantContextStore;
    const middleware = new TenantContextMiddleware(clerk, prisma, store);
    return { middleware, store };
  }

  function makeReqRes() {
    const req = {
      headers: { authorization: 'Bearer token' },
      path: '/api/me',
      originalUrl: '/api/me',
      baseUrl: '',
      url: '/api/me',
      hostname: 'app.capiro.ai',
      header: jest.fn(() => undefined),
    } as unknown as Request & { tenantContext?: unknown };
    const res = {} as Response;
    return { req, res };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('bypasses tenant auth for the public /api/insights route (no bearer token required)', async () => {
    const tx = makeTx();
    const { middleware } = build({}, tx);
    const req = {
      headers: {}, // NO authorization header
      path: '/api/insights',
      originalUrl: '/api/insights',
      baseUrl: '',
      url: '/api/insights',
      hostname: 'app.capiro.ai',
      header: jest.fn(() => undefined),
    } as unknown as Request;
    const next = jest.fn();
    // Must NOT throw "Missing bearer token" — the public marketing endpoint is bypassed.
    await expect(middleware.use(req, {} as Response, next)).resolves.toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    // And it never tried to resolve a tenant.
    expect(tx.tenantMembership.findMany).not.toHaveBeenCalled();
  });

  test('bypasses tenant auth for BYOK3 /api/internal/* (InternalServiceGuard, no bearer token)', async () => {
    const tx = makeTx();
    const { middleware } = build({}, tx);
    const req = {
      headers: { 'x-internal-service-secret': 'shared-secret' }, // NO authorization/bearer
      path: '/api/internal/ai-credentials/resolve',
      originalUrl: '/api/internal/ai-credentials/resolve',
      baseUrl: '',
      url: '/api/internal/ai-credentials/resolve',
      hostname: 'app.capiro.ai',
      header: jest.fn(() => undefined),
    } as unknown as Request;
    const next = jest.fn();
    // Must NOT throw "Missing bearer token" — intel-api's service-to-service
    // call carries the shared secret, not a Clerk JWT; InternalServiceGuard
    // authenticates it downstream. Regression: the app.module `.exclude()`
    // misses under setGlobalPrefix('api'), so this list must catch it.
    await expect(middleware.use(req, {} as Response, next)).resolves.toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    expect(tx.tenantMembership.findMany).not.toHaveBeenCalled();
  });

  test('resolves an existing active membership (regression — no self-heal)', async () => {
    const tx = makeTx();
    tx.user.findUnique.mockResolvedValue({ id: 'u1', clerkUserId: 'clerk_user' });
    tx.tenantMembership.findMany.mockResolvedValue([
      {
        id: 'm1',
        tenantId: 't_acme',
        role: 'standard_user',
        status: 'active',
        tenant: { id: 't_acme', clerkOrgId: 'org_acme', slug: 'acme', status: 'active' },
      },
    ]);

    const { middleware, store } = build(
      {
        org_id: 'org_acme',
        capiro_tenant_id: 't_acme',
        capiro_tenant_slug: 'acme',
        org_role: 'org:member',
      },
      tx,
    );
    const { req, res } = makeReqRes();
    const next = jest.fn();

    await middleware.use(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(tx.tenantMembership.create).not.toHaveBeenCalled();
    expect(
      (req as { tenantContext?: { tenantId: string; role: string } }).tenantContext,
    ).toMatchObject({
      tenantId: 't_acme',
      role: 'standard_user',
    });
    expect(store.run).toHaveBeenCalledTimes(1);
  });

  test('self-heals a missing membership from a verified org claim and maps the role', async () => {
    const tx = makeTx();
    tx.user.findUnique.mockResolvedValue({ id: 'u_nicole', clerkUserId: 'clerk_user' });
    tx.tenantMembership.findMany.mockResolvedValue([]); // mirror is missing the row
    tx.tenant.findUnique.mockResolvedValue({
      id: 't_internal',
      clerkOrgId: 'org_internal',
      slug: 'capiro-internal',
      status: 'active',
    });
    tx.tenantMembership.findUnique.mockResolvedValue(null); // no prior row at all
    tx.tenantMembership.create.mockImplementation((args: { data: { role: string } }) =>
      Promise.resolve({
        id: 'm_new',
        tenantId: 't_internal',
        userId: 'u_nicole',
        role: args.data.role,
        status: 'active',
        tenant: {
          id: 't_internal',
          clerkOrgId: 'org_internal',
          slug: 'capiro-internal',
          status: 'active',
        },
      }),
    );

    const { middleware } = build(
      {
        org_id: 'org_internal',
        capiro_tenant_id: 't_internal',
        capiro_tenant_slug: 'capiro-internal',
        org_role: 'org:admin',
      },
      tx,
    );
    const { req, res } = makeReqRes();
    const next = jest.fn();

    await middleware.use(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(tx.tenantMembership.create).toHaveBeenCalledTimes(1);
    // capiro-internal + org:admin → capiro_admin (mirrors the webhook mapping).
    expect(tx.tenantMembership.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ role: 'capiro_admin', status: 'active' }),
      }),
    );
    expect(
      (req as { tenantContext?: { tenantId: string; role: string } }).tenantContext,
    ).toMatchObject({
      tenantId: 't_internal',
      role: 'capiro_admin',
    });
  });

  test('does NOT resurrect a removed membership (offboarding stays sticky)', async () => {
    const tx = makeTx();
    tx.user.findUnique.mockResolvedValue({ id: 'u_gone', clerkUserId: 'clerk_user' });
    tx.tenantMembership.findMany.mockResolvedValue([]);
    tx.tenant.findUnique.mockResolvedValue({
      id: 't_acme',
      clerkOrgId: 'org_acme',
      slug: 'acme',
      status: 'active',
    });
    tx.tenantMembership.findUnique.mockResolvedValue({ id: 'm_old', status: 'removed' });

    const { middleware } = build(
      {
        org_id: 'org_acme',
        capiro_tenant_id: 't_acme',
        capiro_tenant_slug: 'acme',
        org_role: 'org:admin',
      },
      tx,
    );
    const { req, res } = makeReqRes();
    const next = jest.fn();

    await expect(middleware.use(req, res, next)).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.tenantMembership.create).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  test('403s when there is no membership and no org claim to heal from', async () => {
    const tx = makeTx();
    tx.user.findUnique.mockResolvedValue(null); // brand-new user, stub created
    tx.user.create.mockResolvedValue({ id: 'u_new', clerkUserId: 'clerk_user' });
    tx.tenantMembership.findMany.mockResolvedValue([]);

    const { middleware } = build({}, tx); // no org_id / tenant claims at all
    const { req, res } = makeReqRes();
    const next = jest.fn();

    await expect(middleware.use(req, res, next)).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.user.create).toHaveBeenCalledTimes(1);
    expect(tx.tenant.findUnique).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});
