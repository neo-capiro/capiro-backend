import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { ApplicationAuthorityModule } from './application-authority.module.js';
import { ApplicationAuthorityController } from './application-authority.controller.js';
import { ClerkService } from './clerk.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantContextMiddleware } from '../tenant/tenant-context.middleware.js';
import { TenantContextStore } from '../tenant/tenant-context.store.js';
import { ContextSecurityScopeModule } from '../context/context-security-scope.module.js';
import { ContextSecurityScopeService } from '../context/context-security-scope.service.js';
import { BizDevMeriScopeModule } from '../business-development/bizdev-meri-scope.module.js';
import { BizDevMeriScopeService } from '../business-development/bizdev-meri-scope.service.js';
import { computeMeriProspectScopeVersion } from '../business-development/bizdev-meri-scope.service.js';

const tenantId = '00000000-0000-7000-8000-000000000001';
const actorId = '00000000-0000-0000-0000-000000000002';
const clientId = '00000000-0000-8000-8000-000000000003';
const conversationId = '00000000-0000-0000-0000-000000000004';
const input = { identitySha256: 'a'.repeat(64), conversationId, clientId };

/** Real Nest/controller/guard/middleware, with only Clerk and DB I/O replaced.
 * Registered HTTP handlers use a synthetic response; no socket listens or SDK call. */
async function fixture() {
  const events: string[] = [];
  const user = { id: actorId, clerkUserId: 'user_test' };
  const tenant = { id: tenantId, slug: 'tenant', status: 'active', clerkOrgId: 'org_test',
    settings: { clioFeatureFlags: { 'businessDevelopment.enabled': true, 'businessDevelopment.meriProspectTools.enabled': true } } };
  const membership = { id: 'membership', tenantId, userId: actorId, status: 'active',
    role: 'standard_user', tenant, updatedAt: new Date(2), lastSeenAt: new Date(3) };
  const row: any = { id: conversationId, tenantId, userId: actorId, clientId, status: 'active', archivedAt: null, metadata: {} };
  let wallAllowed = true;
  let clientRows = [{ id: clientId }];
  let onSession = () => {};
  const tx: any = {
    user: { findUnique: async () => user, findFirst: async () => user, update: async () => user },
    tenant: { findUnique: async () => tenant },
    tenantMembership: { findMany: async ({ where }: any) => {
      expect(where).toEqual({ userId: actorId, status: 'active' });
      return membership.status === 'active' ? [membership] : [];
    }, findUnique: async () => membership, findFirst: async ({ where, select }: any) => {
      if (select) {
        expect(where).toEqual({ tenantId, userId: actorId, status: 'active' });
        events.push('membershipFacts');
      }
      return membership.status === 'active' ? membership : null;
    } },
    clioConversation: { findFirst: async ({ where }: any) => {
      events.push('conversation');
      return row && Object.entries(where).every(([key, value]) => row[key] === value) ? row : null;
    } },
    client: {
      findMany: async ({ where, take }: any) => {
        if (where.status) {
          expect(where).toEqual({ tenantId, status: { not: 'archived' },
            OR: [{ memoryWall: false }, { memoryAccessGrants: { some: { tenantId, userId: actorId } } }] });
          expect(take).toBe(4097);
          events.push('membershipRoster');
          return wallAllowed ? clientRows : [];
        }
        events.push('wall'); return wallAllowed ? [{ id: clientId }] : [];
      },
      findFirst: async ({ where, select }: any) => {
        expect(where).toEqual({ id: clientId, tenantId, status: { not: 'archived' } });
        events.push(select.memoryWall ? 'wallFacts' : 'visible');
        return { id: clientId, tenantId, status: 'active', memoryWall: !wallAllowed, memoryAccessGrants: [] };
      },
    },
  };
  const prisma = { withSystem: async (fn: any) => fn(tx), withTenant: async (id: string, fn: any) => {
    expect(id).toBe(tenantId); return fn(tx);
  } };
  const originalSession = { id: 'sess_test', userId: 'user_test', status: 'active', createdAt: 1,
    expireAt: Date.now() + 100_000, abandonAt: Date.now() + 90_000, expiresAtMs: Date.now() + 60_000, actor: null };
  const clerk = {
    verifySessionToken: async () => ({ sub: 'user_test', sid: 'sess_test', iss: 'issuer',
      exp: Math.floor(Date.now() / 1000) + 80, capiro_tenant_id: tenantId, capiro_tenant_slug: 'tenant', org_id: 'org_test' }),
    assertActiveApplicationAuthoritySession: async () => {
      events.push('session'); onSession();
      return originalSession;
    },
  };
  const module = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), ApplicationAuthorityModule],
  }).overrideProvider(PrismaService).useValue(prisma).overrideProvider(ClerkService).useValue(clerk).compile();
  const app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  await app.init();
  // Authenticate through a separate middleware instance; controller uses the Nest provider.
  const middleware = new TenantContextMiddleware(clerk as any, prisma as any, module.get(TenantContextStore));
  const router = app.getHttpAdapter().getInstance()._router;
  async function request(path: 'identity' | 'context' | 'membership', body: unknown, bearer = true,
    extraHeaders: Record<string, string> = {}) {
    const headers: Record<string, string> = { ...(bearer ? { authorization: 'Bearer synthetic' } : {}), ...extraHeaders };
    const req: any = { method: 'POST', path: `/api/clio/application-authority/${path}`,
      originalUrl: `/api/clio/application-authority/${path}`, url: `/api/clio/application-authority/${path}`,
      headers, body, header: (name: string) => headers[name], hostname: 'localhost' };
    const response: any = { statusCode: 200, headersSent: false, headers: {}, body: undefined,
      setHeader(key: string, value: string) { this.headers[key.toLowerCase()] = value; return this; },
      set(key: string, value: string) { return this.setHeader(key, value); },
      getHeader(key: string) { return this.headers[key.toLowerCase()]; },
      status(code: number) { this.statusCode = code; return this; },
      send(value: unknown) { this.body = value; this.headersSent = true; return this; },
      json(value: unknown) { return this.send(value); },
      end() { this.headersSent = true; return this; },
    };
    try { await middleware.use(req, response, () => {}); }
    catch (error) { response.status((error as any).getStatus()).json((error as any).getResponse()); return response; }
    const layer = router.stack.find((entry: any) => entry.route?.path === req.path && entry.route.methods.post);
    expect(layer).toBeDefined();
    await layer.route.stack[0].handle(req, response, () => {});
    return response;
  }
  return { module, app, request, row, membership, tenant, events, tx,
    revokeWall() { wallAllowed = false; }, setClientRows(rows: Array<{ id: string }>) { clientRows = rows; },
    onSession(fn: () => void) { onSession = fn; } };
}

describe('actual narrow authority Nest composition and synthetic HTTP', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });
  afterEach(async () => { await f?.app.close(); });

  it('constructs only existing leaf owners, with single scope instances and two original routes', () => {
    expect(f.module.get(ApplicationAuthorityController)).toBeInstanceOf(ApplicationAuthorityController);
    expect(f.module.select(ContextSecurityScopeModule).get(ContextSecurityScopeService, { strict: true }))
      .toBe(f.module.get(ContextSecurityScopeService));
    expect(f.module.select(BizDevMeriScopeModule).get(BizDevMeriScopeService, { strict: true }))
      .toBe(f.module.get(BizDevMeriScopeService));
    const container = (f.module as any).container;
    const modules = [...container.getModules().values()] as any[];
    const names = modules.flatMap((entry) => [entry.metatype?.name, ...[...entry.providers.values()].map((p: any) => p.metatype?.name)]).filter(Boolean);
    for (const name of ['MeriModule', 'MeriService', 'MeriToolsService', 'ContextModule', 'BusinessDevelopmentModule', 'EngagementService']) {
      expect(names).not.toContain(name);
    }
    for (const type of [ContextSecurityScopeService, BizDevMeriScopeService]) {
      expect(modules.filter((entry) => entry.providers.has(type))).toHaveLength(1);
    }
  });

  it('serves identity and context200 with exact closed receipts, original headers and native user actor', async () => {
    const identity = await f.request('identity', {});
    expect(identity.statusCode).toBe(200);
    expect(Object.keys(identity.body).sort()).toEqual(['checkedAtMs', 'expiresAtMs', 'identityRevision', 'principal']);
    expect(identity.body.principal).toEqual({ tenantId, actorId });
    const response = await f.request('context', input);
    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(['checkedAtMs', 'contextRevision', 'conversationId', 'expiresAtMs', 'identityRevision', 'identitySha256', 'principal', 'selectedClientId']);
    expect(response.body).toMatchObject({ principal: { tenantId, actorId }, identitySha256: input.identitySha256, conversationId, selectedClientId: clientId });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.body.expiresAtMs).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it('serves current membership200 with exact Meri receipt, scoped roster and bounded expiry', async () => {
    const deadlineMs = Date.now() + 30_000;
    const response = await f.request('membership', {}, true, { 'x-meri-deadline-at': String(deadlineMs) });
    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual([
      'actorId', 'checkedAtMs', 'clientIds', 'expiresAtMs', 'membershipRevision',
      'permissions', 'role', 'status', 'tenantId',
    ]);
    expect(response.body).toMatchObject({ tenantId, actorId, status: 'active', role: 'standard_user',
      permissions: [], clientIds: [clientId] });
    expect(response.body.membershipRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(response.body.expiresAtMs).toBeLessThanOrEqual(deadlineMs);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(f.events.filter((event) => event === 'membershipRoster')).toHaveLength(2);
  });

  it.each(['user_admin', 'capiro_admin'])('admits active %s membership at the standard_user minimum rank', async (role) => {
    f.membership.role = role;
    const response = await f.request('membership', {});
    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual([
      'actorId', 'checkedAtMs', 'clientIds', 'expiresAtMs', 'membershipRevision',
      'permissions', 'role', 'status', 'tenantId',
    ]);
    expect(response.body).toMatchObject({ tenantId, actorId, status: 'active', role,
      permissions: [], clientIds: [clientId] });
  });

  it('refuses client_portal_user below the standard_user minimum rank', async () => {
    f.membership.role = 'client_portal_user';
    expect((await f.request('membership', {})).statusCode).toBe(403);
  });

  it('refuses malformed membership body and a wall revocation during the online identity reread', async () => {
    expect((await f.request('membership', { grant: true })).statusCode).toBe(400);
    let reads = 0;
    f.onSession(() => { if (++reads === 2) f.revokeWall(); });
    expect((await f.request('membership', {})).statusCode).toBe(409);
    expect(f.events.filter((event) => event === 'membershipRoster')).toHaveLength(2);
  });

  it('refuses removed membership and oversized roster', async () => {
    f.membership.status = 'removed';
    expect((await f.request('membership', {})).statusCode).toBe(403);
    f.membership.status = 'active';
    f.setClientRows(Array.from({ length: 4097 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    })));
    expect((await f.request('membership', {})).statusCode).toBe(403);
  });

  it('returns408 for an expired caller deadline before membership reads', async () => {
    expect((await f.request('membership', {}, true,
      { 'x-meri-deadline-at': String(Date.now() - 1) })).statusCode).toBe(408);
    expect(f.events).toEqual([]);
  });

  it('preserves current-session 401 when the online Clerk read refuses', async () => {
    f.onSession(() => { throw new UnauthorizedException('Session expired'); });
    expect((await f.request('membership', {})).statusCode).toBe(401);
  });

  it('returns400 before authority ports for malformed bodies and never exposes private failure payloads', async () => {
    const response = await f.request('context', { ...input, tenantId });
    expect(response.statusCode).toBe(400); expect(f.events).toEqual([]);
    expect((await f.request('identity', { grant: true })).statusCode).toBe(400);
  });

  it('keeps no-store on absent bearer and refuses unknown roles through actual existing guards', async () => {
    const response = await f.request('identity', {}, false);
    expect(response.statusCode).toBe(401); expect(response.headers['cache-control']).toBe('no-store');
    f.membership.role = 'unknown';
    expect((await f.request('identity', {})).statusCode).toBe(403);
  });

  it.each(['tenantId', 'userId', 'clientId', 'archivedAt'])('masks foreign/retired conversation %s as403', async (key) => {
    f.row[key] = key === 'archivedAt' ? new Date(1) : tenantId === f.row[key] ? actorId : tenantId;
    const response = await f.request('context', input);
    expect(response.statusCode).toBe(403);
    expect(response.body.message).toBe('Application authority unavailable');
    expect(f.events).not.toContain('visible');
  });

  it('refuses wall or membership revocation during repeated current reads', async () => {
    let reads = 0;
    f.onSession(() => { if (++reads === 2) f.revokeWall(); });
    expect((await f.request('context', input)).statusCode).toBe(403);
    expect(reads).toBe(2);
    f.onSession(() => { f.membership.status = 'removed'; });
    expect((await f.request('identity', {})).statusCode).toBe(403);
  });

  it('refuses changed linked-client prospect and existing client-null research profile', async () => {
    const prospectId = '00000000-0000-4000-8000-000000000005';
    const stored = { prospectId, prospectName: 'synthetic', canonicalOrganizationId: null, linkedClientId: clientId,
      scopeVersion: computeMeriProspectScopeVersion({ prospectId, canonicalOrganizationId: null, linkedClientId: clientId }) };
    f.row.metadata = { bizdevProspectScope: stored };
    // Existing canonical owner is the only prospect authority; changed scope refuses.
    let linkedClientId = clientId;
    const prospectRead = jest.fn(async () => ({ id: prospectId, tenantId, displayName: 'synthetic', canonicalEntityId: null, linkedClientId }));
    f.tx.businessDevelopmentProspect = { findFirst: prospectRead };
    expect((await f.request('context', input)).statusCode).toBe(200);
    expect(prospectRead).toHaveBeenCalledTimes(2);
    linkedClientId = tenantId;
    expect((await f.request('context', input)).statusCode).toBe(403);
    expect(prospectRead).toHaveBeenCalledTimes(3);
    f.row.metadata = {}; f.row.clientId = null;
    expect((await f.request('context', input)).statusCode).toBe(403);
  });
});
