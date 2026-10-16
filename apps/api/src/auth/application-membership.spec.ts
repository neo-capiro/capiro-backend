import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, Script } from 'node:vm';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual, types as nodeTypes } from 'node:util';
import ts from 'typescript';

// Exercise actual owner sources. Only Nest/Clerk/Prisma/request I/O is synthetic.
// Authenticate through the real middleware so request-local provenance is real;
// no fabricated identity receipt or duplicated membership/wall policy is used.
const root = resolve(__dirname, '../../../..');
const source = (name: string) => readFileSync(resolve(root, 'apps/api/src', name), 'utf8');
const decorator = () => () => undefined;
class HttpRefusal extends Error {
  constructor(readonly status: number, readonly response: unknown) { super(String(response)); }
  getStatus() { return this.status; }
  getResponse() { return this.response; }
}
const refusal = (status: number) => class extends HttpRefusal {
  constructor(response: unknown) { super(status, response); }
};
const nest = {
  Injectable: decorator, Optional: decorator, Inject: decorator,
  Logger: class { log() {} warn() {} error() {} }, HttpException: HttpRefusal,
  BadRequestException: refusal(400), UnauthorizedException: refusal(401),
  ForbiddenException: refusal(403), NotFoundException: refusal(404),
  ConflictException: refusal(409), ServiceUnavailableException: refusal(503),
};
function load(text: string, ports: Record<string, unknown>) {
  const module = { exports: {} as any };
  const context = createContext({
    module, exports: module.exports, Date, Object, Reflect, Array, Promise, Number,
    String, Boolean, RegExp, Math, JSON, Map, Set, WeakMap, Error, TypeError,
    Buffer, setTimeout, clearTimeout,
    require(id: string) {
      if (Object.hasOwn(ports, id)) return ports[id];
      throw new Error(`Unexpected actual-owner runtime import: ${id}`);
    },
  });
  const compiled = ts.transpileModule(text, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    experimentalDecorators: true, esModuleInterop: true,
  }, reportDiagnostics: true });
  expect(compiled.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error)).toEqual([]);
  new Script(compiled.outputText).runInContext(context);
  return module.exports;
}

// Read the actual canonical ROLE_RANK declaration without loading its unrelated
// barrel exports or substituting a hand-written rank table.
const sharedSource = ts.createSourceFile('shared-index.ts', readFileSync(resolve(root, 'packages/shared/src/index.ts'), 'utf8'), ts.ScriptTarget.ES2022);
const sharedDeclarations = sharedSource.statements.filter((statement) =>
  (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((declaration) => ['ROLE_RANK', 'CLERK_ADMIN_ROLE_KEYS'].includes(declaration.name.getText(sharedSource))))
  || (ts.isFunctionDeclaration(statement) && statement.name?.text === 'isClerkOrgAdminRole'));
if (sharedDeclarations.length !== 3) throw new Error('Canonical role declarations are missing');
const canonicalRoles = load(sharedDeclarations.map((statement) => statement.getText(sharedSource)).join('\n'), {});
const sharedWall = load(readFileSync(resolve(root, 'packages/shared/src/client-memory-wall.ts'), 'utf8'), {});
const shared = { ...canonicalRoles, ...sharedWall, TENANT_HEADER: 'x-capiro-tenant', authDeniedEvent: () => ({}) };
const authority = load(source('auth/application-authority.ts'), {
  '@nestjs/common': nest, 'node:crypto': { createHash }, 'node:util': { types: nodeTypes },
});
const wall = load(source('memory/memory-wall.helpers.ts'), { '@capiro/shared': shared });
const roleMapping = load(source('auth/clerk-role.util.ts'), { '@capiro/shared': shared });
const tenantOwner = load(source('tenant/tenant-context.middleware.ts'), {
  '@nestjs/common': nest, '@capiro/shared': shared,
  '../auth/clerk.service.js': {}, '../prisma/prisma.service.js': {},
  '../auth/clerk-role.util.js': roleMapping, './tenant-context.store.js': {},
  '../auth/application-authority.js': authority,
});
const membershipContract = load(source('auth/application-membership.ts'), {
  '@nestjs/common': nest, '@capiro/shared': shared,
  'node:crypto': { createHash }, 'node:util': { types: nodeTypes, isDeepStrictEqual },
  './application-authority.js': authority,
});
const serviceOwner = load(source('auth/application-membership.service.ts'), {
  '@nestjs/common': nest, '@capiro/shared': shared,
  'node:crypto': { createHash, timingSafeEqual }, 'node:util': { types: nodeTypes, isDeepStrictEqual },
  '../prisma/prisma.service.js': {}, '../tenant/tenant-context.middleware.js': tenantOwner,
  '../memory/memory-wall.helpers.js': wall, './application-authority.js': authority,
  './application-membership.js': membershipContract,
});

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const actorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const membershipId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const firstClient = '11111111-1111-4111-8111-111111111111';
const secondClient = '22222222-2222-4222-8222-222222222222';
const thirdClient = '33333333-3333-4333-8333-333333333333';
const clerkActor = 'user_membership_test';
const clone = <T>(value: T): T => {
  const result = structuredClone(value);
  // Node's structuredClone creates Dates outside Jest's test realm. Prisma
  // supplies local Dates in production; retain that constructor and exact
  // timestamp (including NaN for the invalid-source negative) in this port.
  if (result && typeof result === 'object' && value && typeof value === 'object' &&
      'updatedAt' in value && value.updatedAt instanceof Date) {
    Object.assign(result, { updatedAt: new Date(value.updatedAt.getTime()) });
  }
  return result;
};
type RosterRow = { id: string; revision: string };

async function fixture(options: { role?: string; clients?: RosterRow[] } = {}) {
  const events: string[] = [];
  const writes: string[] = [];
  const tenant = { id: tenantId, slug: 'membership-test', status: 'active', clerkOrgId: 'org_membership_test' };
  const member = { id: membershipId, tenantId, userId: actorId, status: 'active',
    role: options.role ?? 'standard_user', updatedAt: new Date(2), lastSeenAt: new Date(3), tenant };
  const user = { id: actorId, clerkUserId: clerkActor };
  const originalJwtExpiry = Math.floor(Date.now() / 1000) * 1000 + 180_000;
  const session = { id: 'sess_membership_test', userId: clerkActor, status: 'active',
    createdAt: 1, expireAt: Date.now() + 150_000, abandonAt: Date.now() + 120_000, actor: null };
  const claims = { sub: clerkActor, sid: session.id, exp: originalJwtExpiry / 1000,
    capiro_tenant_id: tenantId, capiro_tenant_slug: tenant.slug, org_id: tenant.clerkOrgId };
  let clients = options.clients ?? [{ id: firstClient, revision: '1'.repeat(32) }, { id: secondClient, revision: '2'.repeat(32) }];
  let activeContext: any;
  let mode: 'authentication' | 'identity' | 'snapshot' = 'authentication';
  let snapshotReads = 0;
  let onlineReads = 0;
  let memberPresent = true;
  let userPresent = true;
  let afterAuthentication = false;
  let snapshotHook: ((index: number, point: 'before' | 'after') => void | Promise<void>) | undefined;
  let rosterHook: ((index: number) => void | Promise<void>) | undefined;
  let onlineHook: ((index: number) => void | Promise<void>) | undefined;
  let rowOverride: ((row: typeof member, mode: string) => unknown) | undefined;
  let cancelled: Error | undefined;
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const forbiddenWrite = (name: string) => async () => { writes.push(name); throw new Error(`Unexpected write: ${name}`); };
  const tx = {
    user: {
      findUnique: async () => userPresent ? clone(user) : null,
      findFirst: async () => userPresent ? clone(user) : null,
      update: async () => {
        if (afterAuthentication) return forbiddenWrite('user.update')();
        return clone(user);
      },
      create: forbiddenWrite('user.create'),
    },
    tenantMembership: {
      findMany: async () => memberPresent ? [clone(member)] : [],
      findFirst: async () => {
        events.push(mode === 'snapshot' ? 'snapshot-member' : 'current-identity-member');
        if (!memberPresent) return null;
        const row = clone(member);
        return rowOverride ? rowOverride(row, mode) : row;
      },
      update: forbiddenWrite('membership.update'), create: forbiddenWrite('membership.create'),
    },
    $queryRaw: async (parts: TemplateStringsArray, ...values: unknown[]) => {
      events.push('roster');
      queries.push({ sql: parts.join('?'), values });
      await rosterHook?.(snapshotReads);
      return clone(clients);
    },
    $executeRaw: forbiddenWrite('executeRaw'), $executeRawUnsafe: forbiddenWrite('executeRawUnsafe'),
  };
  const prisma = {
    withSystem: async (run: (value: typeof tx) => Promise<unknown>) => {
      const prior = mode; mode = afterAuthentication ? 'identity' : 'authentication';
      try { return await run(tx); } finally { mode = prior; }
    },
    withTenant: async (selectedTenant: string, run: (value: typeof tx) => Promise<unknown>) => {
      expect(selectedTenant).toBe(tenantId);
      const index = ++snapshotReads;
      events.push(`snapshot:${index}:before`);
      await snapshotHook?.(index, 'before');
      const prior = mode; mode = 'snapshot';
      try {
        const result = await run(tx);
        await snapshotHook?.(index, 'after');
        events.push(`snapshot:${index}:after`);
        return result;
      } finally { mode = prior; }
    },
  };
  const clerkSource = load(source('auth/clerk.service.ts'), {
    '@nestjs/common': nest, '@nestjs/config': {},
    '@clerk/backend': {
      createClerkClient: () => ({ sessions: { getSession: async (id: string) => {
        expect(id).toBe(session.id);
        const index = ++onlineReads; events.push(`online:${index}`);
        await onlineHook?.(index);
        return clone(session);
      } } }),
      verifyToken: async () => clone(claims),
    },
  });
  const clerk = new clerkSource.ClerkService({ get: (key: string) => key === 'CLERK_SECRET_KEY' ? 'synthetic-membership-secret' : undefined });
  const middleware = new tenantOwner.TenantContextMiddleware(clerk, prisma, {
    run: (ctx: unknown, run: () => unknown) => { activeContext = ctx; return run(); },
  });
  const headers: Record<string, string> = { authorization: 'Bearer synthetic-membership-token' };
  const req = { path: '/api/clio/application-authority/membership', originalUrl: '/api/clio/application-authority/membership',
    headers, header: (key: string) => headers[key], hostname: 'localhost' } as any;
  await middleware.use(req, { setHeader() {} }, () => {});
  afterAuthentication = true;
  events.length = 0;
  const service = new serviceOwner.ApplicationMembershipService(prisma, middleware);
  let controlCalls = 0;
  const control = { deadlineMs: Date.now() + 90_000, assertActive() {
    controlCalls++;
    if (cancelled) throw cancelled;
    if (Date.now() >= control.deadlineMs) throw new Error('Synthetic current-membership deadline');
  } };
  return {
    req, ctx: activeContext, service, control, member, user, tenant, session, originalJwtExpiry, events, writes, queries,
    get snapshotReads() { return snapshotReads; }, get onlineReads() { return onlineReads; },
    get controlCalls() { return controlCalls; },
    setClients(value: RosterRow[]) { clients = value; },
    setMemberPresent(value: boolean) { memberPresent = value; },
    setUserPresent(value: boolean) { userPresent = value; },
    onSnapshot(value: typeof snapshotHook) { snapshotHook = value; },
    onRoster(value: typeof rosterHook) { rosterHook = value; },
    onOnline(value: typeof onlineHook) { onlineHook = value; },
    overrideMember(value: typeof rowOverride) { rowOverride = value; },
    cancel(error = new Error('Synthetic current-membership cancellation')) { cancelled = error; return error; },
    read: (request = req, ctx = activeContext) => service.read(request, ctx, control),
  };
}

afterEach(() => { jest.restoreAllMocks(); });

describe('Current application membership through actual canonical owners', () => {
  it('returns only current active authority, canonical sorted clients and original expiry bounds', async () => {
    const h = await fixture();
    const startedAt = Date.now();
    const receipt = await h.read();
    expect(Object.keys(receipt).sort()).toEqual(['actorId', 'checkedAtMs', 'clientIds', 'expiresAtMs', 'membershipRevision', 'permissions', 'role', 'status', 'tenantId']);
    expect(receipt).toMatchObject({ tenantId, actorId, status: 'active', role: 'standard_user', permissions: [], clientIds: [firstClient, secondClient] });
    expect(receipt.membershipRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.checkedAtMs).toBeGreaterThanOrEqual(startedAt);
    expect(receipt.expiresAtMs).toBeGreaterThan(receipt.checkedAtMs);
    expect(receipt.expiresAtMs).toBeLessThanOrEqual(Math.min(h.originalJwtExpiry, h.session.expireAt, h.session.abandonAt));
  });

  it('rechecks online identity and three snapshots in sequence without writing after canonical authentication', async () => {
    const h = await fixture();
    await h.read();
    expect(h.onlineReads).toBe(2);
    expect(h.snapshotReads).toBe(3);
    expect(h.events.indexOf('online:1')).toBeLessThan(h.events.indexOf('snapshot:1:before'));
    expect(h.events.indexOf('snapshot:1:after')).toBeLessThan(h.events.indexOf('online:2'));
    expect(h.events.indexOf('online:2')).toBeLessThan(h.events.indexOf('snapshot:2:before'));
    expect(h.events.indexOf('snapshot:2:after')).toBeLessThan(h.events.lastIndexOf('current-identity-member'));
    expect(h.events.lastIndexOf('current-identity-member')).toBeLessThan(h.events.indexOf('snapshot:3:before'));
    expect(h.controlCalls).toBeGreaterThan(6);
    expect(h.writes).toEqual([]);
  });

  it('refuses a cloned request that lacks canonical request-local authentication provenance', async () => {
    const h = await fixture();
    await expect(h.read({ ...h.req })).rejects.toMatchObject({ status: 403 });
    expect(h.queries).toEqual([]);
  });

  it('refuses a forged context even when the proposed tenant and actor strings match', async () => {
    const h = await fixture();
    await expect(h.read(h.req, { ...h.ctx })).rejects.toMatchObject({ status: 403 });
    expect(h.queries).toEqual([]);
  });

  it('refuses revoked membership before reading client authority', async () => {
    const h = await fixture(); h.setMemberPresent(false);
    await expect(h.read()).rejects.toMatchObject({ status: 403 });
    expect(h.queries).toEqual([]);
  });

  it('refuses a revoked or foreign Clerk-to-local-user binding', async () => {
    const h = await fixture(); h.user.clerkUserId = 'user_rebound';
    await expect(h.read()).rejects.toMatchObject({ status: 403 });
    expect(h.queries).toEqual([]);
  });

  it('refuses an inactive current tenant without returning retained membership/client rows', async () => {
    const h = await fixture(); h.tenant.status = 'inactive';
    await expect(h.read()).rejects.toMatchObject({ status: 403 });
    expect(h.queries).toEqual([]);
  });

  it.each(['client_portal_user', 'constructor'])('refuses canonical below-floor or unknown role %s', async (role) => {
    const h = await fixture({ role });
    await expect(h.read()).rejects.toMatchObject({ status: 403 });
    expect(h.queries).toEqual([]);
  });

  it('refuses a different selected-tenant membership rather than fabricating an impersonated member', async () => {
    const h = await fixture({ role: 'capiro_admin' });
    h.overrideMember((row, mode) => mode === 'snapshot' ? { ...row, tenantId: thirdClient } : row);
    await expect(h.read()).rejects.toMatchObject({ status: 403 });
  });

  it('refuses membership version drift across the canonical roster await', async () => {
    const h = await fixture();
    h.onRoster(() => { h.member.updatedAt = new Date(h.member.updatedAt.getTime() + 1); });
    await expect(h.read()).rejects.toMatchObject({ status: 409 });
  });

  it('refuses a client permission loss while the fresh online session read is pending', async () => {
    const h = await fixture();
    h.onOnline((index) => { if (index === 2) h.setClients([{ id: firstClient, revision: '1'.repeat(32) }]); });
    await expect(h.read()).rejects.toMatchObject({ status: 409 });
  });

  it('refuses same-size client scope substitution rather than comparing only counts', async () => {
    const h = await fixture();
    h.onSnapshot((index, point) => { if (index === 2 && point === 'before') h.setClients([
      { id: firstClient, revision: '1'.repeat(32) }, { id: thirdClient, revision: '3'.repeat(32) },
    ]); });
    await expect(h.read()).rejects.toMatchObject({ status: 409 });
  });

  it('refuses changed canonical client revision even when every client ID is unchanged', async () => {
    const h = await fixture();
    h.onSnapshot((index, point) => { if (index === 3 && point === 'before') h.setClients([
      { id: firstClient, revision: 'f'.repeat(32) }, { id: secondClient, revision: '2'.repeat(32) },
    ]); });
    await expect(h.read()).rejects.toMatchObject({ status: 409 });
  });

  it('uses the real bounded canonical Clerk-actor roster query with tenant/wall membership predicates', async () => {
    const h = await fixture(); await h.read();
    expect(h.queries).toHaveLength(3);
    for (const query of h.queries) {
      expect(query.sql).toMatch(/tenant_memberships/);
      expect(query.sql).toMatch(/client_memory_access/);
      expect(query.sql).toMatch(/LIMIT/i);
      expect(query.values).toContain(tenantId);
      expect(query.values).toContain(clerkActor);
      expect(query.values).toContain(4097);
      expect(query.values).not.toContain(actorId);
    }
  });

  it('fails closed when the bounded roster signals 4097 rows instead of returning partial success', async () => {
    const clients = Array.from({ length: 4097 }, (_, index) => ({ id: `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`, revision: '1'.repeat(32) }));
    const h = await fixture({ clients });
    await expect(h.read()).rejects.toMatchObject({ status: 503 });
  });

  it.each([
    [[{ id: 'invalid', revision: '1'.repeat(32) }]],
    [[{ id: firstClient, revision: 'invalid' }]],
    [[{ id: firstClient, revision: '1'.repeat(32) }, { id: firstClient, revision: '2'.repeat(32) }]],
  ])('fails closed on malformed or duplicate canonical roster rows %#', async (clients) => {
    const h = await fixture({ clients });
    await expect(h.read()).rejects.toMatchObject({ status: 503 });
  });

  it('returns an empty authorized roster as active empty scope, without granting tenant-wide clients', async () => {
    const h = await fixture({ clients: [] });
    expect(await h.read()).toMatchObject({ status: 'active', clientIds: [], permissions: [] });
  });

  it('includes canonical role in membership revision while keeping the same actor and client IDs', async () => {
    const standard = await fixture(); const admin = await fixture({ role: 'user_admin' });
    const first = await standard.read(); const second = await admin.read();
    expect(first.clientIds).toEqual(second.clientIds);
    expect(first.membershipRevision).not.toBe(second.membershipRevision);
    expect(second.role).toBe('user_admin');
  });

  it('excludes session expiry/check time from the membership revision but retains actual member version', async () => {
    const h = await fixture();
    const first = await h.read();
    h.session.expireAt -= 1_000; h.session.abandonAt -= 1_000;
    const sameMembership = await h.read();
    expect(sameMembership.membershipRevision).toBe(first.membershipRevision);
    h.member.updatedAt = new Date(h.member.updatedAt.getTime() + 1);
    const changedMembership = await h.read();
    expect(changedMembership.membershipRevision).not.toBe(first.membershipRevision);
  });

  it('refuses expired original session bounds before publishing any receipt', async () => {
    const h = await fixture(); h.session.abandonAt = Date.now() - 1;
    await expect(h.read()).rejects.toMatchObject({ status: 401 });
    expect(h.queries).toEqual([]);
  });

  it('preserves cancellation after an awaited snapshot and stops subsequent authority reads', async () => {
    const h = await fixture(); const cancelled = new Error('Cancelled during snapshot');
    h.onSnapshot((index, point) => { if (index === 1 && point === 'after') h.cancel(cancelled); });
    await expect(h.read()).rejects.toBe(cancelled);
    expect(h.onlineReads).toBe(1);
    expect(h.snapshotReads).toBe(1);
  });

  it('checks the supplied deadline before starting any online session or snapshot work', async () => {
    const h = await fixture(); h.control.deadlineMs = Date.now() - 1;
    await expect(h.read()).rejects.toThrow('Synthetic current-membership deadline');
    expect(h.onlineReads).toBe(0);
    expect(h.snapshotReads).toBe(0);
  });

  it('refuses noncanonical uppercase client UUID output instead of publishing an alternate identity', async () => {
    const h = await fixture({ clients: [{ id: tenantId.toUpperCase(), revision: '1'.repeat(32) }] });
    await expect(h.read()).rejects.toMatchObject({ status: 503 });
  });

  it('refuses malformed member version facts as unavailable rather than hashing them into authority', async () => {
    const h = await fixture();
    h.overrideMember((row, mode) => mode === 'snapshot' ? { ...row, updatedAt: new Date(NaN) } : row);
    await expect(h.read()).rejects.toMatchObject({ status: 503 });
  });

  it('uses the actual closed empty-body contract and rejects case variants and proxies before reflection traps', () => {
    expect(() => authority.assertApplicationAuthorityIdentityBody({})).not.toThrow();
    expect(() => authority.assertApplicationAuthorityIdentityBody({ TenantId: tenantId })).toThrow();
    expect(() => authority.assertApplicationAuthorityIdentityBody({ clientIds: [] })).toThrow();
    let traps = 0;
    const proxy = new Proxy({}, { ownKeys() { traps++; throw new Error('Proxy trap'); } });
    expect(() => authority.assertApplicationAuthorityIdentityBody(proxy)).toThrow();
    expect(traps).toBe(0);
  });
});
