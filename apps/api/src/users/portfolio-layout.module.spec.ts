import 'reflect-metadata';
import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { UsersModule } from './users.module.js';
import { PortfolioLayoutController } from './portfolio-layout.controller.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ClerkService } from '../auth/clerk.service.js';
import { TenantModule } from '../tenant/tenant.module.js';
import { TenantContextMiddleware } from '../tenant/tenant-context.middleware.js';
import { TenantContextStore } from '../tenant/tenant-context.store.js';

const T = '11111111-1111-1111-1111-111111111111';
const U = '22222222-2222-2222-2222-222222222222';
const HOME = '33333333-3333-3333-3333-333333333333';
const path = '/api/me/portfolio-layout';

/** Actual UsersModule/controllers, native proof owner, middleware and guard.
 * Only DB and Clerk transports are replaced. No listener/native acceptance. */
async function fixture(role = 'standard_user', impersonating = false) {
  const events: string[] = [];
  const user = { id: U, clerkUserId: 'user_existing' };
  const tenant = { id: impersonating ? HOME : T, slug: 'home', status: 'active', clerkOrgId: 'org_existing' };
  const target = { id: T, slug: 'target', status: 'active', clerkOrgId: 'org_target' };
  const membership = { id: 'member_original', tenantId: tenant.id, userId: U, status: 'active', role, tenant, updatedAt: new Date(2) };
  const impersonation = { id: 'selected_impersonation', actorUserId: U, tenantId: T, endedAt: null,
    startedAt: new Date(3), expiresAt: new Date(Date.now() + 100000), tenant: target };
  const session = { id: 'session_existing', userId: 'user_existing', status: 'active', createdAt: 1,
    expireAt: Date.now() + 100000, abandonAt: Date.now() + 90000, expiresAtMs: Date.now() + 60000, actor: null };
  let row: unknown = null;
  let afterStage = () => {};
  let onSession = () => {};
  const authTx = {
    user: { findUnique: async () => user, findFirst: async ({ where }: any) => user.id === where.id && user.clerkUserId === where.clerkUserId ? user : null,
      update: async () => user },
    tenantMembership: { findMany: async () => [membership], findFirst: async ({ where }: any) =>
      membership.id === where.id && membership.tenantId === where.tenantId && membership.userId === where.userId && membership.status === where.status ? membership : null },
    impersonationSession: { findFirst: async ({ where }: any) => !impersonating ? null :
      impersonation.actorUserId === where.actorUserId && impersonation.endedAt === null && impersonation.expiresAt > where.expiresAt.gt ? impersonation : null },
  };
  const prisma = { withSystem: async (fn: any, opts?: any) => {
    if (!opts) return fn(authTx);
    expect(opts).toEqual({ isolationLevel: 'Serializable' });
    let staged = row;
    const tx = { $executeRaw: async () => 1, $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      events.push(sql);
      if (sql.includes('FROM tenant_memberships')) return [{ tenantId: tenant.id }];
      if (sql.startsWith('SELECT') && sql.includes('FROM user_portfolio_layouts')) return staged ? [staged] : [];
      if (sql.startsWith('INSERT') || sql.startsWith('UPDATE')) {
        expect(args.slice(0, 2)).toEqual([T, U]);
        staged = { tenantId: T, userId: U, clientOrder: args[2], version: args[3], updatedAt: new Date(10) };
        afterStage(); return [staged];
      }
      return [];
    } };
    const receipt = await fn(tx); row = staged; return receipt;
  } };
  const clerk = {
    verifySessionToken: async () => ({ sub: user.clerkUserId, sid: session.id, iss: 'issuer',
      exp: Math.floor(Date.now() / 1000) + 100, capiro_tenant_id: tenant.id, capiro_tenant_slug: tenant.slug, org_id: tenant.clerkOrgId }),
    assertActiveApplicationAuthoritySession: async () => { onSession(); return session; },
  };
  @Global()
  @Module({ providers: [{ provide: PrismaService, useValue: prisma }, { provide: ClerkService, useValue: clerk }], exports: [PrismaService, ClerkService] })
  class InertIoPorts {}
  const module = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), InertIoPorts, TenantModule, UsersModule] }).compile();
  const app = module.createNestApplication({ logger: false }); app.setGlobalPrefix('api'); await app.init();
  // A separate native middleware instance reproduces Nest's wrapper/provider provenance sharing.
  const middleware = new TenantContextMiddleware(clerk as any, prisma as any, module.get(TenantContextStore));
  let latestReq: any;
  async function invoke(method: 'get' | 'put', body?: unknown, bearer = true) {
    const headers: Record<string, string> = bearer ? { authorization: 'Bearer synthetic' } : {};
    if (impersonating) headers['x-capiro-impersonate-tenant'] = target.slug;
    const req: any = { method: method.toUpperCase(), path, originalUrl: path, url: path, headers, body,
      header: (name: string) => headers[name], hostname: 'localhost' };
    latestReq = req;
    const response: any = { statusCode: 200, headersSent: false, headers: {}, body: undefined,
      setHeader(key: string, value: string) { this.headers[key.toLowerCase()] = value; return this; },
      set(key: string, value: string) { return this.setHeader(key, value); }, getHeader(key: string) { return this.headers[key.toLowerCase()]; },
      status(code: number) { this.statusCode = code; return this; }, send(value: unknown) { this.body = value; this.headersSent = true; return this; },
      json(value: unknown) { return this.send(value); }, end() { this.headersSent = true; return this; } };
    try { await middleware.use(req, response, () => {}); }
    catch (error) { response.status((error as any).getStatus()).json((error as any).getResponse()); return response; }
    const router = app.getHttpAdapter().getInstance()._router;
    const layer = router.stack.find((entry: any) => entry.route?.path === path && entry.route.methods[method]);
    expect(layer).toBeDefined(); await layer.route.stack[0].handle(req, response, () => {}); return response;
  }
  return { app, module, invoke, user, membership, tenant, impersonation, session, events,
    get row() { return row; }, get latestReq() { return latestReq; },
    onSession(callback: () => void) { onSession = callback; }, afterStage(callback: () => void) { afterStage = callback; } };
}

describe('Portfolio layout actual UsersModule and synthetic registered HTTP', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  afterEach(async () => { if (f) await f.app.close(); });

  it('initializes actual module and serves GET/save/readback with normal middleware provenance and exact headers', async () => {
    f = await fixture();
    const initial = await f.invoke('get');
    expect(initial.statusCode).toBe(200); expect(initial.body).toEqual({ contractVersion: 1, tenantId: T, userId: U, version: 0, updatedAt: null, order: [] });
    expect(f.row).toBeNull(); expect(initial.headers['cache-control']).toBe('no-store');
    const saved = await f.invoke('put', { contractVersion: 1, expectedVersion: 0, order: [] });
    expect(saved.statusCode).toBe(200); expect(saved.body.version).toBe(1);
    expect((await f.invoke('get')).body).toEqual(saved.body);
  });

  it('requires the ordinary bearer login and standard role through actual middleware/guard', async () => {
    f = await fixture('client_portal_user');
    expect((await f.invoke('get', undefined, false)).statusCode).toBe(401);
    expect((await f.invoke('get')).statusCode).toBe(403); expect(f.row).toBeNull();
  });

  it('refuses copied request/context objects through the real private provenance owner', async () => {
    f = await fixture(); await f.invoke('get');
    const controller = f.module.get(PortfolioLayoutController), req = f.latestReq;
    await expect(controller.read({ ...req.tenantContext }, req)).rejects.toThrow('Application authority unavailable');
    await expect(controller.read(req.tenantContext, { ...req })).rejects.toThrow('Application authority unavailable');
  });

  it.each(['membership', 'Clerk binding', 'tenant', 'expiry'])('refuses current %s changes after normal login before save', async (change) => {
    f = await fixture();
    f.onSession(() => {
      if (change === 'membership') f.membership.status = 'removed';
      if (change === 'Clerk binding') f.user.clerkUserId = 'user_other';
      if (change === 'tenant') f.tenant.status = 'suspended';
      if (change === 'expiry') f.session.expiresAtMs = Date.now() - 1;
    });
    expect((await f.invoke('put', { contractVersion: 1, expectedVersion: 0, order: [] })).statusCode).toBe(403);
    expect(f.row).toBeNull();
  });

  it('rolls back staged save when the exact original membership fails final native recheck', async () => {
    f = await fixture(); f.afterStage(() => { f.membership.status = 'removed'; });
    expect((await f.invoke('put', { contractVersion: 1, expectedVersion: 0, order: [] })).statusCode).toBe(403);
    expect(f.row).toBeNull();
  });

  it('preserves existing admin impersonation home membership and target actor ownership without new target membership', async () => {
    f = await fixture('capiro_admin', true);
    expect(f.membership.tenantId).toBe(HOME);
    const saved = await f.invoke('put', { contractVersion: 1, expectedVersion: 0, order: [] });
    expect(saved.statusCode).toBe(200); expect(saved.body).toMatchObject({ tenantId: T, userId: U, version: 1 });
    f.impersonation.endedAt = new Date() as any;
    // Fresh middleware now denies the ended existing session; no replacement membership/session is selected.
    expect((await f.invoke('get')).statusCode).toBe(403);
  });
});
