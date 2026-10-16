import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, Script } from 'node:vm';
import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import ts from 'typescript';
import type { ApplicationAuthorityIdentityProof } from './application-authority.js';

// Actual owner closures only: no application/bootstrap, Prisma client or SDK.
const root = resolve(__dirname, '../../../..');
const sources = (path: string) => readFileSync(resolve(root, 'apps/api/src', path), 'utf8');
class Refusal extends Error { constructor(public readonly response?: unknown) { super(String(response)); } }
const decorator = () => () => undefined;
const nest = { Injectable: decorator, Optional: decorator, Controller: decorator, UseGuards: decorator,
  Post: decorator, HttpCode: decorator, Header: decorator, Body: decorator, Req: decorator, Logger: class { log() {} warn() {} error() {} },
  UnauthorizedException: Refusal, ForbiddenException: Refusal, BadRequestException: Refusal,
  ConflictException: Refusal, RequestTimeoutException: Refusal,
  NotFoundException: Refusal };
function load(source: string, ports: Record<string, unknown>, timers = { setTimeout, clearTimeout }, clock: Pick<typeof Date, 'now'> = Date) {
  const module = { exports: {} as any };
  const context = createContext({ module, exports: module.exports, Date: clock, Object, Reflect, Array,
    Promise, Number, JSON, Map, WeakMap, Error, ...timers,
    require(id: string) {
      if (Object.hasOwn(ports, id)) return ports[id];
      throw new Error(`Unexpected runtime import: ${id}`);
    },
  });
  const js = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true,
    esModuleInterop: true,
  }, reportDiagnostics: true });
  expect(js.diagnostics?.filter((d) => d.category === ts.DiagnosticCategory.Error)).toEqual([]);
  new Script(js.outputText).runInContext(context);
  return module.exports;
}
const contract = load(sources('auth/application-authority.ts'), {
  '@nestjs/common': nest, 'node:crypto': { createHash }, 'node:util': { types: nodeTypes },
});
const tenantId = '00000000-0000-7000-8000-000000000001';
const actorId = '00000000-0000-0000-0000-000000000002';
const clientId = '00000000-0000-8000-8000-000000000003';
const conversationId = '00000000-0000-0000-0000-000000000004';
const input = { identitySha256: 'a'.repeat(64), conversationId, clientId };
const ctx = { tenantId, tenantSlug: 'tenant', userId: actorId, clerkUserId: 'user_test', role: 'standard_user' };
const session = () => ({ id: 'sess_test', userId: 'user_test', status: 'active',
  createdAt: 1, expireAt: Date.now() + 100_000, abandonAt: Date.now() + 90_000, actor: null });
const claims = () => ({ sub: 'user_test', sid: 'sess_test', iss: 'issuer', exp: Math.floor(Date.now() / 1000) + 80,
  capiro_tenant_id: tenantId, capiro_tenant_slug: 'tenant', org_id: 'org_test' });
const identity = (): ApplicationAuthorityIdentityProof => ({ principal: { tenantId, actorId }, identityRevision: 'b'.repeat(64), expiresAtMs: Date.now() + 20_000,
  recheckCurrent: async () => identity() });
const conversation = () => ({ id: conversationId, tenantId, userId: actorId, clientId, status: 'active', archivedAt: null,
  updatedAt: new Date(), title: 'not a revision input', metadata: {} });
function clerkFixture(timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout }, clock: Pick<typeof Date, 'now'> = Date) {
  const events: string[] = [];
  let row = session();
  let reader = async (_id: string) => row;
  const exports = load(sources('auth/clerk.service.ts'), {
    '@nestjs/common': nest, '@nestjs/config': {},
    '@clerk/backend': { createClerkClient: () => ({ sessions: { getSession: (id: string) => {
      events.push(`getSession:${id}`); return reader(id);
    } } }), verifyToken: () => { throw new Error('JWT port must not be called by the dedicated assertion'); } },
  }, timers, clock);
  const clerk = new exports.ClerkService({ get: (key: string) => key === 'CLERK_SECRET_KEY' ? 'synthetic-test-secret' : undefined });
  return { clerk, events, row, setReader(next: typeof reader) { reader = next; } };
}
function tenantFixture(options: { impersonated?: boolean } = {}) {
  const events: string[] = [];
  const user = { id: actorId, clerkUserId: 'user_test' };
  const tenant = { id: tenantId, slug: 'tenant', status: 'active', clerkOrgId: 'org_test' };
  const membership = { id: 'membership', tenantId, userId: actorId, status: 'active', role: 'standard_user', tenant,
    updatedAt: new Date(2), lastSeenAt: new Date(3) };
  const impersonation = { id: 'impersonation', actorUserId: actorId, tenantId: clientId, startedAt: new Date(1),
    expiresAt: new Date(Date.now() + 15_000), endedAt: null as Date | null,
    tenant: { id: clientId, slug: 'target', status: 'active', clerkOrgId: 'org_target' } };
  if (options.impersonated) membership.role = 'capiro_admin';
  const tx = {
    user: { findUnique: async () => user, findFirst: async (args: any) => { events.push('currentUser'); return user; },
      update: async () => { events.push('existingLastSeenWrite'); return user; } },
    tenantMembership: { findMany: async () => [membership], findFirst: async (args: any) => {
      events.push('currentMembership'); expect(args.where).toEqual({ id: membership.id, tenantId, userId: actorId, status: 'active' });
      return membership;
    } },
    impersonationSession: { findFirst: async (args: any) => {
      events.push('impersonation');
      if (Object.hasOwn(args.where, 'id')) expect(args.where).toMatchObject({ id: 'impersonation', actorUserId: actorId, tenantId: clientId, endedAt: null });
      return impersonation;
    } },
  };
  let sessionReader = async (_claims: any) => ({ ...session(), expiresAtMs: Date.now() + 60_000 });
  const middleware = load(sources('tenant/tenant-context.middleware.ts'), {
    '@nestjs/common': nest, '@capiro/shared': { TENANT_HEADER: 'x-capiro-tenant', authDeniedEvent: () => ({}) },
    '../auth/clerk.service.js': {}, '../prisma/prisma.service.js': {}, '../auth/clerk-role.util.js': {},
    './tenant-context.store.js': {}, '../auth/application-authority.js': contract,
  }).TenantContextMiddleware;
  let activeContext: any;
  const clerkPort = { verifySessionToken: async () => claims(), assertActiveApplicationAuthoritySession: async (value: any) => {
    events.push('onlineSession'); return sessionReader(value);
  } };
  const prismaPort = { withSystem: async (fn: any) => fn(tx) };
  const storePort = { run: (value: any, fn: any) => { activeContext = value; return fn(); } };
  const owner = new middleware(clerkPort, prismaPort, storePort);
  const headers: Record<string, string> = { authorization: 'Bearer synthetic' };
  if (options.impersonated) headers['x-capiro-impersonate-tenant'] = 'target';
  const req = { path: '/api/clio/application-authority/identity', originalUrl: '/api/clio/application-authority/identity',
    headers, header: (name: string) => headers[name], hostname: 'localhost' } as any;
  const responseHeaders: Record<string, string> = {};
  return { owner, req, user, tenant, membership, impersonation, tx, events, responseHeaders,
    separateProvider() { return new middleware(clerkPort, prismaPort, storePort); },
    setSessionReader(next: typeof sessionReader) { sessionReader = next; },
    async authenticate() {
      await owner.use(req, { setHeader: (key: string, value: string) => { responseHeaders[key] = value; } }, () => {});
      return activeContext;
    } };
}

describe('application-authority closed wire and minimal receipts', () => {
  it('accepts exact empty identity and lowercase nil/v7/v8 context syntax', () => {
    expect(contract.assertApplicationAuthorityIdentityBody({})).toBeUndefined();
    expect(contract.parseApplicationAuthorityContextBody(input)).toEqual(input);
  });
  for (const [name, body] of [
    ['absent', undefined], ['null', null], ['array', []], ['extra capability', { scopes: [] }],
    ['symbol', { [Symbol('hidden')]: true }], ['inherited', Object.create({ permission: true })],
    ['proxy', new Proxy({}, {})],
  ]) it(`refuses identity ${name}`, () => expect(() => contract.assertApplicationAuthorityIdentityBody(body)).toThrow());
  for (const [name, body] of [
    ['missing run field', { conversationId, clientId }], ['extra authority', { ...input, tenantId }],
    ['uppercase hash', { ...input, identitySha256: 'A'.repeat(64) }],
    ['uppercase UUID', { ...input, clientId: 'A'.repeat(8) + clientId.slice(8) }],
    ['non-string UUID', { ...input, clientId: null }],
    ['accessor', Object.defineProperty({ ...input }, 'clientId', { get() { throw new Error('getter executed'); } })],
    ['proxy', new Proxy({ ...input }, {})],
  ]) it(`refuses context ${name}`, () => expect(() => contract.parseApplicationAuthorityContextBody(body)).toThrow());
  it('refuses proxies before any user-defined reflection trap', () => {
    let traps = 0;
    const proxy = new Proxy({}, { getPrototypeOf() { traps++; throw new Error('trap'); }, ownKeys() { traps++; throw new Error('trap'); } });
    expect(() => contract.assertApplicationAuthorityIdentityBody(proxy)).toThrow('Invalid application authority request');
    expect(() => contract.parseApplicationAuthorityContextBody(proxy)).toThrow('Invalid application authority request');
    expect(traps).toBe(0);
  });
  it('projects closed identity output and refuses original expired bounds', () => {
    const result = contract.applicationAuthorityIdentityReceipt({ ...identity(), privateProfile: 'discard' });
    expect(Object.keys(result).sort()).toEqual(['checkedAtMs', 'expiresAtMs', 'identityRevision', 'principal']);
    expect(Object.keys(result.principal).sort()).toEqual(['actorId', 'tenantId']);
    expect(() => contract.applicationAuthorityIdentityReceipt({ ...identity(), expiresAtMs: 1 })).toThrow();
  });
  it('makes revisions deterministic and rejects accessor or unsupported facts', () => {
    expect(contract.applicationAuthorityRevision('identity', { a: 1, b: 2 })).toBe(contract.applicationAuthorityRevision('identity', { b: 2, a: 1 }));
    expect(() => contract.applicationAuthorityRevision('identity', { a: undefined })).toThrow();
    expect(() => contract.applicationAuthorityRevision('identity', Object.defineProperty({}, 'x', { get() { throw new Error('getter'); } }))).toThrow();
  });
});

describe('actual Clerk owner bounded read-only session assertion', () => {
  it('uses exact verified sid and clips JWT/session/abandon bounds', async () => {
    const f = clerkFixture(); const claim = claims();
    const value = await f.clerk.assertActiveApplicationAuthoritySession(claim);
    expect(f.events).toEqual(['getSession:sess_test']);
    expect(value.expiresAtMs).toBe(Math.min(claim.exp * 1000, f.row.expireAt, f.row.abandonAt));
  });
  for (const [name, mutate] of [
    ['missing sid', (c: any) => delete c.sid], ['missing exp', (c: any) => delete c.exp],
    ['expired JWT', (c: any) => { c.exp = 1; }], ['path-shaped sid', (c: any) => { c.sid = '../session'; }],
  ] as const) it(`refuses ${name} before SDK work`, async () => {
    const f = clerkFixture(); const c = claims(); mutate(c);
    await expect(f.clerk.assertActiveApplicationAuthoritySession(c)).rejects.toThrow(); expect(f.events).toEqual([]);
  });
  for (const [key, value] of [ ['id', 'other'], ['userId', 'other'], ['status', 'revoked'], ['status', 'ended'],
    ['expireAt', 1], ['abandonAt', 1], ['expireAt', NaN], ['createdAt', Date.now() + 1_000_000] ]) {
    it(`refuses current session ${key}=${String(value)}`, async () => {
      const f = clerkFixture(); (f.row as any)[key as string] = value;
      await expect(f.clerk.assertActiveApplicationAuthoritySession(claims())).rejects.toThrow();
    });
  }
  it('fails closed on provider failure and consumes timeout late rejection', async () => {
    const f = clerkFixture(); f.setReader(async () => { throw new Error('private provider payload'); });
    await expect(f.clerk.assertActiveApplicationAuthoritySession(claims())).rejects.toThrow('Application authority unavailable');
    let rejectLate!: (error: Error) => void; let timeout!: () => void; let cleared = 0;
    const timed = clerkFixture({ setTimeout: ((fn: () => void) => { timeout = fn; return 1; }) as any,
      clearTimeout: (() => { cleared++; }) as any });
    timed.setReader(() => new Promise((_resolve, reject) => { rejectLate = reject; }));
    const pending = timed.clerk.assertActiveApplicationAuthoritySession(claims());
    await Promise.resolve(); timeout();
    await expect(pending).rejects.toThrow('Application authority unavailable');
    rejectLate(new Error('late')); await Promise.resolve(); expect(cleared).toBe(1);
  });
  it('refuses late resolution even when a delayed event loop has not fired the timeout callback', async () => {
    let now = Date.now();
    class Clock extends Date { static now() { return now; } }
    const f = clerkFixture({ setTimeout: (() => 1) as any, clearTimeout: (() => {}) as any }, Clock);
    f.setReader(async () => { now += 2001; return f.row; });
    await expect(f.clerk.assertActiveApplicationAuthoritySession(claims())).rejects.toThrow('Application authority unavailable');
  });
});

describe('actual middleware selected-provenance current authority', () => {
  it('shares authentic request provenance across the actual separate middleware/provider instances', async () => {
    const f = tenantFixture(); const selected = await f.authenticate();
    const provider = f.separateProvider();
    expect((await provider.readApplicationAuthority(f.req, selected)).principal).toEqual({ tenantId, actorId });
    await expect(provider.readApplicationAuthority({ ...f.req }, selected)).rejects.toThrow();
    await expect(provider.readApplicationAuthority(f.req, { ...selected })).rejects.toThrow();
  });
  it('keeps normal pipeline effects but dedicated current checks are read-only and session first', async () => {
    const f = tenantFixture(); const selected = await f.authenticate();
    expect(f.responseHeaders['Cache-Control']).toBe('no-store');
    expect(f.events).toContain('existingLastSeenWrite'); f.events.length = 0;
    const result = await f.owner.readApplicationAuthority(f.req, selected);
    expect(result.principal).toEqual({ tenantId, actorId });
    expect(f.events).toEqual(['onlineSession', 'currentUser', 'currentMembership']);
    await expect(f.owner.readApplicationAuthority({ ...f.req }, selected)).rejects.toThrow();
    await expect(f.owner.readApplicationAuthority(f.req, { ...selected })).rejects.toThrow();
  });
  for (const [name, mutate] of [
    ['user mapping', (f: any) => { f.user.clerkUserId = 'replacement'; }],
    ['member removed', (f: any) => { f.membership.status = 'removed'; }],
    ['member role', (f: any) => { f.membership.role = 'user_admin'; }],
    ['tenant suspended', (f: any) => { f.tenant.status = 'suspended'; }],
    ['org remapped', (f: any) => { f.tenant.clerkOrgId = 'replacement'; }],
    ['tenant slug', (f: any) => { f.tenant.slug = 'replacement'; }],
  ] as const) it(`refuses ${name} changing during session await`, async () => {
    const f = tenantFixture(); const selected = await f.authenticate();
    f.setSessionReader(async () => { mutate(f); return { ...session(), expiresAtMs: Date.now() + 60_000 }; });
    await expect(f.owner.readApplicationAuthority(f.req, selected)).rejects.toThrow('Application authority unavailable');
  });
  it('excludes activity but includes exact membership version', async () => {
    const f = tenantFixture(); const selected = await f.authenticate();
    const fixed = { ...session(), expiresAtMs: Date.now() + 60_000 };
    f.setSessionReader(async () => fixed);
    const first = await f.owner.readApplicationAuthority(f.req, selected);
    f.membership.lastSeenAt = new Date(999); (f.user as any).lastSeenAt = new Date(999); (fixed as any).lastActiveAt = 999;
    expect((await f.owner.readApplicationAuthority(f.req, selected)).identityRevision).toBe(first.identityRevision);
    f.membership.updatedAt = new Date(4);
    expect((await f.owner.readApplicationAuthority(f.req, selected)).identityRevision).not.toBe(first.identityRevision);
  });
  it('rechecks exact selected impersonation and clips original operator expiry', async () => {
    const f = tenantFixture({ impersonated: true }); const selected = await f.authenticate();
    const receipt = await f.owner.readApplicationAuthority(f.req, selected);
    expect(receipt.principal).toEqual({ tenantId: clientId, actorId });
    expect(receipt.expiresAtMs).toBe(f.impersonation.expiresAt.getTime());
    f.impersonation.endedAt = new Date();
    await expect(f.owner.readApplicationAuthority(f.req, selected)).rejects.toThrow();
  });
  it('stamps no-store even on missing bearer denial', async () => {
    const f = tenantFixture(); delete f.req.headers.authorization;
    await expect(f.authenticate()).rejects.toThrow(); expect(f.responseHeaders['Cache-Control']).toBe('no-store');
  });
});

describe('context receipt existing-owner ordering and correlation boundary', () => {
  function ports() {
    const events: string[] = []; let row = conversation(); let current = identity(); let revision = ['wall', false];
    return { events, setRow(value: any) { row = value; }, setIdentity(value: any) { current = value; }, setWall(value: any) { revision = value; },
      ports: { identity: async () => { events.push('identity'); return current; },
        conversation: async () => { events.push('conversation'); return row; },
        conversationScope: async () => { events.push('scope'); return null; },
        clientVisible: async () => { events.push('visible'); }, clientAuthority: async () => { events.push('wall'); return revision; } },
    };
  }
  it('has closed minimal output, rechecks identity last and echoes unrelated valid hash without granting anything', async () => {
    const f = ports(); const result = await contract.readApplicationAuthorityContext(input, f.ports);
    expect(f.events).toEqual(['identity', 'conversation', 'scope', 'visible', 'wall', 'identity', 'conversation', 'scope', 'visible', 'wall']);
    expect(result.identitySha256).toBe(input.identitySha256);
    expect(Object.keys(result).sort()).toEqual(['checkedAtMs', 'contextRevision', 'conversationId', 'expiresAtMs', 'identityRevision', 'identitySha256', 'principal', 'selectedClientId']);
    expect(result.selectedClientId).toBe(clientId);
  });
  for (const [key, value] of [ ['id', clientId], ['tenantId', clientId], ['userId', clientId],
    ['clientId', null], ['clientId', tenantId], ['archivedAt', new Date()], ['status', 'closed'] ]) {
    it(`refuses conversation ${key} mismatch before client owners`, async () => {
      const f = ports(); f.setRow({ ...conversation(), [key as string]: value });
      await expect(contract.readApplicationAuthorityContext(input, f.ports)).rejects.toThrow();
      expect(f.events).toEqual(['identity', 'conversation']);
    });
  }
  for (const owner of ['conversationScope', 'clientVisible', 'clientAuthority']) {
    it(`preserves ${owner} refusal`, async () => {
      const f = ports(); (f.ports as any)[owner] = async () => { throw new Refusal('denied'); };
      await expect(contract.readApplicationAuthorityContext(input, f.ports)).rejects.toThrow();
    });
  }
  it('refuses identity mutation after asynchronous wall lookup', async () => {
    const f = ports(); f.ports.clientAuthority = async () => { f.setIdentity({ ...identity(), identityRevision: 'c'.repeat(64) }); return ['wall', false]; };
    await expect(contract.readApplicationAuthorityContext(input, f.ports)).rejects.toThrow();
  });
  it('refuses a conversation retarget during the final online identity read', async () => {
    const f = ports(); let reads = 0;
    f.ports.identity = async () => {
      if (++reads === 2) f.setRow({ ...conversation(), clientId: tenantId });
      return identity();
    };
    await expect(contract.readApplicationAuthorityContext(input, f.ports)).rejects.toThrow();
  });
  it('refuses wall revocation during the final online identity read', async () => {
    const f = ports(); let reads = 0;
    f.ports.identity = async () => {
      if (++reads === 2) f.ports.clientAuthority = async () => { throw new Refusal('revoked'); };
      return identity();
    };
    await expect(contract.readApplicationAuthorityContext(input, f.ports)).rejects.toThrow();
  });
  it('refuses local membership drift during final context reads', async () => {
    const f = ports(); const proof = identity();
    proof.recheckCurrent = async () => ({ ...identity(), identityRevision: 'c'.repeat(64) });
    f.setIdentity(proof);
    await expect(contract.readApplicationAuthorityContext(input, f.ports)).rejects.toThrow();
  });
  it('ignores activity/title, but changes revision for wall/security facts', async () => {
    const f = ports(); const first = await contract.readApplicationAuthorityContext(input, f.ports);
    f.setRow({ ...conversation(), title: 'different', updatedAt: new Date(123) });
    expect((await contract.readApplicationAuthorityContext(input, f.ports)).contextRevision).toBe(first.contextRevision);
    f.setWall(['wall', true, 'grant']);
    expect((await contract.readApplicationAuthorityContext(input, f.ports)).contextRevision).not.toBe(first.contextRevision);
  });
});

describe('actual Meri and scope-owner source integration', () => {
  it('uses original active conversation and client lookup plus current prospect owner without constructing service', async () => {
    const events: string[] = [];
    const scopes = {
      authorizeResearchPortfolioConversation: async (_tx: unknown, _ctx: unknown, row: any) => { events.push('portfolio'); if (row.metadata.portfolio) throw new Refusal('portfolio'); },
      authorizeMeriProspectScope: async (_owner: unknown, _ctx: unknown, metadata: any) => { events.push('prospect'); return metadata.prospect ?? null; },
    };
    const resources = load(sources('context/application-authority-resource.helpers.ts'), {
      '@nestjs/common': nest, '../research-portfolios/research-portfolio-artifact-authority.js': scopes,
    });
    const cls = load(sources('auth/application-authority.controller.ts'), {
      '@nestjs/common': nest, './application-authority.js': contract,
      '../context/application-authority-resource.helpers.js': resources,
      '../business-development/bizdev-meri-scope.authorization.js': scopes,
      './roles.decorator.js': { Roles: decorator }, './roles.guard.js': {},
      '../tenant/current-tenant.decorator.js': { CurrentTenant: decorator },
    }).ApplicationAuthorityController;
    const row = conversation();
    const tenant = { readApplicationAuthority: async () => { events.push('identity'); return identity(); } };
    const scope = { resolveApplicationAuthorityClient: async (...args: any[]) => { expect(args).toEqual([tenantId, actorId, clientId]); events.push('wall'); return ['client', false]; } };
    const prisma = { withTenant: async (id: string, fn: any) => { expect(id).toBe(tenantId); return fn({
      clioConversation: { findFirst: async (args: any) => { expect(args.where).toEqual({ id: conversationId, tenantId, userId: actorId, archivedAt: null }); return row; } },
      client: { findFirst: async (args: any) => { expect(args.where).toEqual({ id: clientId, tenantId, status: { not: 'archived' } }); events.push('visible'); return { id: clientId }; } },
    }); } };
    const owner = new cls(prisma, tenant, scope, {});
    await owner.applicationAuthorityContext(ctx, {}, input);
    expect(events).toEqual(['identity', 'portfolio', 'prospect', 'visible', 'wall', 'identity', 'portfolio', 'prospect', 'visible', 'wall']);
    events.length = 0;
    await expect(owner.applicationAuthorityContext(ctx, {}, { ...input, scopes: [] })).rejects.toThrow(); expect(events).toEqual([]);
    (row.metadata as any).portfolio = true;
    await expect(owner.applicationAuthorityContext(ctx, {}, input)).rejects.toThrow();
    expect(events).toEqual(['identity', 'portfolio']);
  });
  it('uses canonical wall predicate before/after tenant/client-bounded fact read', async () => {
    const exports = load(sources('context/context-security-scope.service.ts'), {
      '@nestjs/common': nest, '../prisma/prisma.service.js': {}, './context.types.js': { ContextResolutionError: Refusal },
    });
    const events: string[] = []; let allowed = true;
    const owner = new exports.ContextSecurityScopeService({ withTenant: async (id: string, fn: any) => {
      expect(id).toBe(tenantId); return fn({ client: {
        findMany: async (args: any) => { events.push('canonicalWall'); expect(args.where).toEqual({ tenantId, id: { in: [clientId] }, OR: [{ memoryWall: false }, { memoryAccessGrants: { some: { tenantId, userId: actorId } } }] }); return allowed ? [{ id: clientId }] : []; },
        findFirst: async (args: any) => { events.push('facts'); expect(args.where).toEqual({ id: clientId, tenantId, status: { not: 'archived' } }); expect(args.select.memoryAccessGrants.where).toEqual({ tenantId, clientId, userId: actorId }); return { id: clientId, tenantId, status: 'active', memoryWall: true, memoryAccessGrants: [{ id: 'grant', tenantId, clientId, userId: actorId, createdAt: new Date(1) }] }; },
      } });
    } });
    expect(await owner.resolveApplicationAuthorityClient(tenantId, actorId, clientId)).toEqual([clientId, tenantId, 'active', true, [['grant', tenantId, clientId, actorId, 1]]]);
    expect(events).toEqual(['canonicalWall', 'facts', 'canonicalWall']); allowed = false; events.length = 0;
    await expect(owner.resolveApplicationAuthorityClient(tenantId, actorId, clientId)).rejects.toThrow(); expect(events).toEqual(['canonicalWall']);
  });
  it('pins all three POST200 no-store routes under existing role guard and provider wiring', () => {
    const controller = sources('auth/application-authority.controller.ts');
    expect(controller).toContain("@Controller('clio/application-authority')");
    for (const route of ['identity', 'membership', 'context']) expect(controller).toContain(`@Post('${route}')\n  @HttpCode(200)\n  @Header('Cache-Control', 'no-store')`);
    expect(sources('meri/meri.controller.ts')).not.toContain("@Post('application-authority/");
    expect(controller).toContain("@Roles('standard_user')");
    const module = sources('context/context.module.ts');
    expect(module).toContain('    ContextSecurityScopeModule,');
    expect(module).not.toContain('    ContextSecurityScopeService,');
    expect(sources('context/context-security-scope.module.ts')).toContain('providers: [ContextSecurityScopeService]');
  });
  it('canonical resolver rejects a foreign-tenant wall grant and preserves same-tenant/unwalled admission in both consumers', async () => {
    const exports = load(sources('context/context-security-scope.service.ts'), {
      '@nestjs/common': nest, '../prisma/prisma.service.js': {}, './context.types.js': { ContextResolutionError: Refusal },
    });
    let wall = true;
    let grantTenant = tenantId;
    const queries: any[] = [];
    const tx = { client: {
      findMany: async ({ where }: any) => {
        queries.push(where);
        expect(where.tenantId).toBe(tenantId);
        const grant = where.OR[1].memoryAccessGrants.some;
        expect(grant).toEqual({ tenantId, userId: actorId });
        return (!wall || (grant.tenantId === grantTenant && grant.userId === actorId)) ? [{ id: clientId }] : [];
      },
      findFirst: async () => ({ id: clientId, tenantId, status: 'active', memoryWall: wall,
        memoryAccessGrants: grantTenant === tenantId ? [{ id: 'grant', tenantId, clientId, userId: actorId, createdAt: new Date(1) }] : [] }),
    } };
    const owner = new exports.ContextSecurityScopeService({ withTenant: async (id: string, fn: any) => {
      expect(id).toBe(tenantId); return fn(tx);
    } });
    const request = { tenantId, actorUserId: actorId, securityScope: { authorizedClientIds: [clientId], authorizedMailboxConnectionIds: [] } };
    expect((await owner.resolve(request)).authorizedClientIds).toEqual([clientId]);
    expect((await owner.resolveApplicationAuthorityClient(tenantId, actorId, clientId))[3]).toBe(true);
    grantTenant = conversationId;
    await expect(owner.resolve(request)).rejects.toThrow();
    await expect(owner.resolveApplicationAuthorityClient(tenantId, actorId, clientId)).rejects.toThrow();
    wall = false;
    expect((await owner.resolve(request)).authorizedClientIds).toEqual([clientId]);
    expect((await owner.resolveApplicationAuthorityClient(tenantId, actorId, clientId))[4]).toEqual([]);
    expect(queries.length).toBe(8);
  });
});
