import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/config.schema.js';
import type { TenantContext } from '@capiro/shared';
import { ClerkService } from './clerk.service.js';
import { TenantContextMiddleware } from '../tenant/tenant-context.middleware.js';
import { TenantContextStore } from '../tenant/tenant-context.store.js';
import { PortfolioLayoutController } from '../users/portfolio-layout.controller.js';
import { ObjectiveWorkService, UNCONNECTED_OBJECTIVE_WORK_OWNER } from '../clients/objectives/work/objective-work.service.js';

const NOW = 1_800_000_000_000;
const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const mockGetSession = jest.fn<() => Promise<any>>();
const mockVerifyToken = jest.fn<() => Promise<any>>();
jest.mock('@clerk/backend', () => ({
  createClerkClient: () => ({ sessions: { getSession: () => mockGetSession() } }),
  verifyToken: () => mockVerifyToken(),
}));

beforeEach(() => { jest.useFakeTimers({ now: NOW }); mockGetSession.mockReset(); mockVerifyToken.mockReset(); });
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

/** Real Clerk cache, native authentication/provenance owner and both existing
 * production callers. Only SDK and Prisma I/O are synthetic. Unlike the older
 * source-loader suites this loads the actual middleware import graph, so these
 * DB-revocation assertions run independently of their known sandbox failures. */
async function fixture() {
  const user = { id: USER, clerkUserId: 'user_cache_callers' };
  const tenant = { id: TENANT, slug: 'cache-callers', status: 'active', clerkOrgId: 'org_cache_callers' };
  const membership = { id: 'membership_cache_callers', tenantId: TENANT, userId: USER,
    status: 'active', role: 'standard_user', tenant, updatedAt: new Date(2) };
  const session = { id: 'session_cache_callers', userId: user.clerkUserId, status: 'active',
    createdAt: NOW - 1000, expireAt: NOW + 100_000, abandonAt: NOW + 90_000, actor: null as unknown };
  mockGetSession.mockResolvedValue(session);
  mockVerifyToken.mockResolvedValue({ sub: user.clerkUserId, sid: session.id, iss: 'issuer',
    exp: NOW / 1000 + 120, capiro_tenant_id: TENANT, capiro_tenant_slug: tenant.slug, org_id: tenant.clerkOrgId });
  const memberRead = jest.fn(async ({ where }: any) => membership.id === where.id &&
    membership.tenantId === where.tenantId && membership.userId === where.userId &&
    membership.status === where.status ? membership : null);
  const authTx = {
    user: { findUnique: async () => user, findFirst: async ({ where }: any) =>
      user.id === where.id && user.clerkUserId === where.clerkUserId ? user : null, update: async () => user },
    tenantMembership: { findMany: async () => [membership], findFirst: memberRead },
    impersonationSession: { findFirst: async () => null },
  };
  const portfolioTx = { $executeRaw: async () => 1,
    $queryRawUnsafe: async (sql: string) => sql.includes('FROM tenant_memberships') ? [{ tenantId: TENANT }] : [] };
  const portfolioTransactions = jest.fn(async (run: (tx: any) => unknown) => run(portfolioTx));
  const prisma = { withSystem: async (run: (tx: any) => unknown, opts?: unknown) => {
    if (!opts) return run(authTx);
    expect(opts).toEqual({ isolationLevel: 'Serializable' });
    return portfolioTransactions(run);
  } };
  const clerk = new ClerkService({ get: (key: string) => key === 'CLERK_SECRET_KEY' ? 'synthetic-key' : undefined } as unknown as ConfigService<AppConfig, true>);
  const middleware = new TenantContextMiddleware(clerk, prisma as any, new TenantContextStore());
  const headers: Record<string, string> = { authorization: 'Bearer synthetic-cache-callers' };
  const req: any = { method: 'GET', path: '/api/me/portfolio-layout', originalUrl: '/api/me/portfolio-layout',
    url: '/api/me/portfolio-layout', hostname: 'localhost', headers, header: (name: string) => headers[name] };
  await middleware.use(req, { setHeader() {} } as any, () => {});
  const ctx: TenantContext = req.tenantContext;
  expect(ctx).toMatchObject({ tenantId: TENANT, userId: USER, clerkUserId: user.clerkUserId });
  const portfolio = new PortfolioLayoutController(prisma as any, middleware);
  const objective = new ObjectiveWorkService(prisma as any, middleware, UNCONNECTED_OBJECTIVE_WORK_OWNER);
  return { middleware, req, ctx, membership, user, tenant, session, memberRead, portfolio, objective, portfolioTransactions };
}

describe('Clerk positive cache never substitutes for fresh local caller authority', () => {
  it('rereads membership in real middleware on every cache hit and refuses current revocation with 403', async () => {
    const f = await fixture();
    const first = await f.middleware.readApplicationAuthority(f.req, f.ctx);
    expect(first.principal).toEqual({ tenantId: TENANT, actorId: USER });
    const reads = f.memberRead.mock.calls.length;
    f.membership.status = 'removed'; jest.setSystemTime(NOW + 100);
    await expect(f.middleware.readApplicationAuthority(f.req, f.ctx)).rejects.toMatchObject({ status: 403 });
    expect(f.memberRead).toHaveBeenCalledTimes(reads + 1);
    expect(mockGetSession).toHaveBeenCalledTimes(1);
  });

  it('retains PortfolioLayoutController.operate DB checks on a hit and refuses before another layout transaction', async () => {
    const f = await fixture();
    await expect(f.portfolio.read(f.ctx, f.req)).resolves.toEqual({ contractVersion: 1,
      tenantId: TENANT, userId: USER, version: 0, updatedAt: null, order: [] });
    expect(f.portfolioTransactions).toHaveBeenCalledTimes(1);
    const reads = f.memberRead.mock.calls.length;
    f.membership.status = 'removed'; jest.setSystemTime(NOW + 100);
    await expect(f.portfolio.read(f.ctx, f.req)).rejects.toMatchObject({ status: 403 });
    expect(f.memberRead).toHaveBeenCalledTimes(reads + 1);
    expect(f.portfolioTransactions).toHaveBeenCalledTimes(1);
    expect(mockGetSession).toHaveBeenCalledTimes(1);
  });

  it('retains ObjectiveWorkService.proof DB checks on a hit and its existing NOT_AVAILABLE refusal contract', async () => {
    const f = await fixture();
    // This is the existing private owner used by command/read/confirmation, not
    // a stand-in. Its existing catch maps local 403 into NOT_AVAILABLE.
    const proof = () => (f.objective as any).proof(f.ctx, f.req);
    await expect(proof()).resolves.toMatchObject({ principal: { tenantId: TENANT, actorId: USER } });
    const reads = f.memberRead.mock.calls.length;
    f.membership.status = 'removed'; jest.setSystemTime(NOW + 100);
    await expect(proof()).rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
    expect(f.memberRead).toHaveBeenCalledTimes(reads + 1);
    expect(mockGetSession).toHaveBeenCalledTimes(1);
  });

  it.each(['user binding', 'tenant state', 'role'])('also rereads current %s on a cache hit', async (fact) => {
    const f = await fixture(); await f.middleware.readApplicationAuthority(f.req, f.ctx);
    if (fact === 'user binding') f.user.clerkUserId = 'other_clerk_user';
    if (fact === 'tenant state') f.tenant.status = 'suspended';
    if (fact === 'role') f.membership.role = 'client_portal_user';
    await expect(f.middleware.readApplicationAuthority(f.req, f.ctx)).rejects.toMatchObject({ status: 403 });
    expect(mockGetSession).toHaveBeenCalledTimes(1);
  });

  it('refuses malformed provider actor facts before caching and permits immediate valid recovery', async () => {
    const f = await fixture();
    class MalformedActor { sub = 'actor'; }
    f.session.actor = new MalformedActor();
    for (let n = 0; n < 2; n++) await expect(f.middleware.readApplicationAuthority(f.req, f.ctx)).rejects.toMatchObject({ status: 401 });
    expect(mockGetSession).toHaveBeenCalledTimes(2);
    f.session.actor = { sub: 'valid_actor' };
    await expect(f.middleware.readApplicationAuthority(f.req, f.ctx)).resolves.toMatchObject({ principal: { tenantId: TENANT, actorId: USER } });
    await f.middleware.readApplicationAuthority(f.req, f.ctx);
    expect(mockGetSession).toHaveBeenCalledTimes(3);
  });
});
