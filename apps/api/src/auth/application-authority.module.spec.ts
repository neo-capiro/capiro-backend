import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { ApplicationAuthorityModule } from './application-authority.module.js';
import { ApplicationAuthorityController } from './application-authority.controller.js';
import { ApplicationMembershipController } from './application-membership.controller.js';
import { ApplicationMembershipService } from './application-membership.service.js';
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
  let onSession: () => void | Promise<void> = () => {};
  let onClientScopeRead = () => {};
  let allowedClients = [{ id: clientId, revision: '1'.repeat(32) }];
  const tx: any = {
    $queryRaw: async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const sql = parts.join('?').replace(/\s+/g, ' ');
      expect(sql).toContain('FROM clients c');
      expect(sql).toContain('JOIN tenant_memberships m');
      expect(sql).toContain("m.status::text='active'");
      expect(sql).toContain("c.status::text<>'archived'");
      expect(sql).toContain('a.tenant_id=c.tenant_id');
      expect(sql).toContain('a.client_id=c.id');
      expect(sql).toContain('a.user_id=u.id');
      expect(values.slice(0, 2)).toEqual(['user_test', tenantId]);
      if (values.length > 2) expect(values.slice(2)).toEqual([4097]);
      events.push('clientScope');
      onClientScopeRead();
      return wallAllowed ? allowedClients.map((client) => ({ ...client })) : [];
    },
    user: { findUnique: async () => user, findFirst: async () => user, update: async () => user },
    tenant: { findUnique: async () => tenant },
    tenantMembership: { findMany: async () => [membership], findFirst: async () => membership },
    clioConversation: { findFirst: async ({ where }: any) => {
      events.push('conversation');
      return row && Object.entries(where).every(([key, value]) => row[key] === value) ? row : null;
    } },
    client: {
      findMany: async () => { events.push('wall'); return wallAllowed ? [{ id: clientId }] : []; },
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
      events.push('session'); await onSession();
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
  async function request(
    path: 'identity' | 'context' | 'membership' | 'MEMBERSHIP' | 'membership/',
    body: unknown,
    bearer = true,
    options: {
      headers?: Record<string, string>;
      afterAuthentication?: (req: any, response: any) => void;
      unboundRequest?: boolean;
      aborted?: boolean;
    } = {},
  ) {
    const headers: Record<string, string> = {
      ...(bearer ? { authorization: 'Bearer synthetic' } : {}),
      ...options.headers,
    };
    const req: any = Object.assign(new EventEmitter(), { method: 'POST', path: `/api/clio/application-authority/${path}`,
      originalUrl: `/api/clio/application-authority/${path}`, url: `/api/clio/application-authority/${path}`,
      headers, body, header: (name: string) => headers[name], hostname: 'localhost', aborted: options.aborted === true });
    const response: any = Object.assign(new EventEmitter(), { statusCode: 200, headersSent: false,
      headers: {} as Record<string, string>, body: undefined as unknown,
      writableEnded: false, destroyed: false,
      setHeader(key: string, value: string) { this.headers[key.toLowerCase()] = value; return this; },
      set(key: string, value: string) { return this.setHeader(key, value); },
      getHeader(key: string) { return this.headers[key.toLowerCase()]; },
      status(code: number) { this.statusCode = code; return this; },
      send(value: unknown) { this.body = value; this.headersSent = true; this.writableEnded = true; return this; },
      json(value: unknown) { return this.send(value); },
      end() { this.headersSent = true; this.writableEnded = true; return this; },
    });
    req.res = response;
    try { await middleware.use(req, response, () => {}); }
    catch (error) { response.status((error as any).getStatus()).json((error as any).getResponse()); return response; }
    options.afterAuthentication?.(req, response);
    const dispatchRequest = options.unboundRequest ? Object.assign(new EventEmitter(), req) : req;
    const layer = router.stack.find((entry: any) => entry.route?.path === req.path && entry.route.methods.post);
    expect(layer).toBeDefined();
    await layer.route.stack[0].handle(dispatchRequest, response, () => {});
    return response;
  }
  return { module, app, request, row, membership, tenant, events, tx,
    revokeWall() { wallAllowed = false; }, onSession(fn: () => void | Promise<void>) { onSession = fn; },
    onClientScopeRead(fn: () => void) { onClientScopeRead = fn; },
    setAllowedClients(rows: Array<{ id: string; revision: string }>) { allowedClients = rows; },
    originalSession,
  };
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

describe('current membership authority registered HTTP boundary', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });
  afterEach(async () => { await f?.app.close(); });

  it('registers the membership controller and a single service in the actual authority module', () => {
    const authorityModule = f.module.select(ApplicationAuthorityModule);
    expect(authorityModule.get(ApplicationMembershipController, { strict: true }))
      .toBeInstanceOf(ApplicationMembershipController);
    expect(authorityModule.get(ApplicationMembershipService, { strict: true }))
      .toBeInstanceOf(ApplicationMembershipService);
    const modules = [...(f.module as any).container.getModules().values()] as any[];
    expect(modules.filter((entry) => entry.providers.has(ApplicationMembershipService))).toHaveLength(1);
  });

  it('serves a fresh closed membership receipt without reading a legacy conversation', async () => {
    const otherClientId = '00000000-0000-8000-8000-000000000006';
    f.setAllowedClients([
      { id: otherClientId, revision: '2'.repeat(32) },
      { id: clientId, revision: '1'.repeat(32) },
    ]);
    f.tx.clioConversation.findFirst = async () => { throw new Error('Legacy conversation is unavailable'); };
    const startedAt = Date.now();
    const response = await f.request('membership', {});
    const finishedAt = Date.now();
    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual([
      'actorId', 'checkedAtMs', 'clientIds', 'expiresAtMs', 'membershipRevision',
      'permissions', 'role', 'status', 'tenantId',
    ]);
    expect(response.body).toMatchObject({
      tenantId, actorId, status: 'active', role: 'standard_user', permissions: [],
      clientIds: [clientId, otherClientId],
    });
    expect(response.body.membershipRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(Number.isSafeInteger(response.body.checkedAtMs)).toBe(true);
    expect(response.body.checkedAtMs).toBeGreaterThanOrEqual(startedAt);
    expect(response.body.checkedAtMs).toBeLessThanOrEqual(finishedAt);
    expect(response.body.expiresAtMs).toBeGreaterThan(response.body.checkedAtMs);
    expect(response.body.expiresAtMs).toBeLessThanOrEqual(f.originalSession.expiresAtMs);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(f.events).not.toContain('conversation');
    expect(f.events).not.toContain('visible');
    expect(f.events).not.toContain('wallFacts');
  });

  it('keeps an active member with an empty permitted roster distinct from failed membership', async () => {
    f.setAllowedClients([]);
    const response = await f.request('membership', {});
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ tenantId, actorId, status: 'active', permissions: [], clientIds: [] });
    expect(response.body.membershipRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it.each(['user_admin', 'capiro_admin'])('does not expand an active %s roster through a wall or claimed scope headers', async (role) => {
    f.membership.role = role;
    f.revokeWall();
    const response = await f.request('membership', {}, true, {
      headers: { 'x-meri-permitted-client-ids': clientId, 'x-meri-tenant-id': clientId },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ tenantId, actorId, role, permissions: [], clientIds: [] });
  });

  it('refuses a client_portal_user below the standard_user role floor', async () => {
    f.membership.role = 'client_portal_user';
    const response = await f.request('membership', {});
    expect(response.statusCode).toBe(403);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(f.events).toEqual([]);
  });

  it('retains the existing role guard before membership owner reads', async () => {
    f.membership.role = 'unknown';
    const response = await f.request('membership', {});
    expect(response.statusCode).toBe(403);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(f.events).toEqual([]);
  });

  it('requires the native bearer even when service and claimed scope headers are supplied', async () => {
    const response = await f.request('membership', {}, false, {
      headers: {
        'x-internal-service-secret': 'synthetic-not-user-authority',
        'x-meri-tenant-id': tenantId,
        'x-meri-actor-id': actorId,
        'x-meri-permitted-client-ids': clientId,
      },
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(f.events).toEqual([]);
  });

  it('keeps no-store on pre-controller bearer denial for the membership path', async () => {
    const response = await f.request('membership', {}, false);
    expect(response.statusCode).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(f.events).toEqual([]);
  });

  it.each(['MEMBERSHIP', 'membership/'] as const)('keeps no-store on pre-controller bearer denial for route alias %s', async (path) => {
    const response = await f.request(path, {}, false);
    expect(response.statusCode).toBe(401);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(f.events).toEqual([]);
  });

  it.each([
    [{ tenantId }],
    [{ actorId }],
    [{ clientId }],
    [{ clientIds: [clientId] }],
    [{ permittedClientIds: [clientId] }],
    [{ selector: clientId }],
    [{ role: 'capiro_admin' }],
    [{ permissions: ['*'] }],
    [{ subject: { tenantId, actorId } }],
    [null],
    [[]],
  ])('rejects nonempty or malformed membership body before current authority reads: %j', async (body) => {
    const response = await f.request('membership', body);
    expect(response.statusCode).toBe(400);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(f.events).toEqual([]);
  });

  it.each(['removed', 'suspended'])('refuses a membership becoming %s during the online check', async (status) => {
    f.onSession(() => { f.membership.status = status; });
    const response = await f.request('membership', {});
    expect(response.statusCode).toBe(403);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(f.events).not.toContain('clientScope');
  });

  it('refuses a selected membership moving to a foreign tenant during the online check', async () => {
    f.onSession(() => { f.membership.tenantId = clientId; });
    const response = await f.request('membership', {});
    expect(response.statusCode).toBe(403);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(f.events).not.toContain('clientScope');
  });

  it('refuses wall/client revocation between the repeated canonical roster reads', async () => {
    let reads = 0;
    f.onClientScopeRead(() => { if (++reads === 2) f.revokeWall(); });
    const response = await f.request('membership', {});
    expect([403, 409]).toContain(response.statusCode);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(f.events).not.toContain('conversation');
  });

  it('refuses current local membership drift after the first roster await', async () => {
    f.onClientScopeRead(() => { f.membership.status = 'removed'; });
    const response = await f.request('membership', {});
    expect([403, 409]).toContain(response.statusCode);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('does not accept a copied request as authenticated request provenance', async () => {
    const response = await f.request('membership', {}, true, { unboundRequest: true });
    expect(response.statusCode).toBe(403);
    expect(f.events).not.toContain('clientScope');
  });

  it('does not accept a copied tenant context as the middleware-selected actor', async () => {
    const response = await f.request('membership', {}, true, {
      afterAuthentication(req) { req.tenantContext = { ...req.tenantContext }; },
    });
    expect(response.statusCode).toBe(403);
    expect(f.events).not.toContain('clientScope');
  });

  it('refuses an already-expired shorten-only deadline before current owner dispatch', async () => {
    const response = await f.request('membership', {}, true, {
      headers: { 'x-meri-deadline-at': String(Date.now() - 1) },
    });
    expect(response.statusCode).toBe(408);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(f.events).toEqual([]);
  });

  it('returns no membership receipt when the authenticated request is already aborted', async () => {
    const response = await f.request('membership', {}, true, { aborted: true });
    expect(response.statusCode).toBe(408);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(f.events).not.toContain('clientScope');
  });

  it('refuses a response destroyed before cancellation listeners attach', async () => {
    const response = await f.request('membership', {}, true, {
      afterAuthentication(_req, res) {
        res.destroyed = true;
        res.emit('close');
      },
    });
    expect(response.statusCode).toBe(408);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(f.events).toEqual([]);
  });

  it('refuses request cancellation during an asynchronous current session read', async () => {
    const response = await f.request('membership', {}, true, {
      afterAuthentication(req) { f.onSession(() => { req.emit('aborted'); }); },
    });
    expect(response.statusCode).toBe(408);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(f.events).not.toContain('clientScope');
  });

  it('returns408 on abort while the current owner is still pending and removes request listeners', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let ownerSettled = false;
    let request: any;
    try {
      const response = await f.request('membership', {}, true, {
        afterAuthentication(req) {
          request = req;
          f.onSession(async () => {
            req.emit('aborted');
            await pending;
            ownerSettled = true;
          });
        },
      });
      expect(response.statusCode).toBe(408);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(ownerSettled).toBe(false);
      expect(request.listenerCount('aborted')).toBe(0);
      expect(response.listenerCount('close')).toBe(0);
      expect(f.events).not.toContain('clientScope');
    } finally {
      release();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(f.events).not.toContain('clientScope');
  });

  it('returns408 at the shorten-only deadline while the current owner is still pending', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let ownerSettled = false;
    let request: any;
    try {
      const response = await f.request('membership', {}, true, {
        headers: { 'x-meri-deadline-at': String(Date.now() + 25) },
        afterAuthentication(req) {
          request = req;
          f.onSession(async () => {
            jest.advanceTimersByTime(25);
            await pending;
            ownerSettled = true;
          });
        },
      });
      expect(response.statusCode).toBe(408);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(ownerSettled).toBe(false);
      expect(request.listenerCount('aborted')).toBe(0);
      expect(response.listenerCount('close')).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
      expect(f.events).not.toContain('clientScope');
    } finally {
      release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      jest.useRealTimers();
    }
    expect(f.events).not.toContain('clientScope');
  });
});
