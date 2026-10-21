import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { ApplicationAuthorityModule } from './application-authority.module.js';
import { ApplicationAuthorityUnavailableException } from './application-authority-unavailable.js';
import { parseApplicationAuthorityCurrentBody } from './application-authority.js';
import { ClerkService } from './clerk.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantContextMiddleware } from '../tenant/tenant-context.middleware.js';
import { TenantContextStore } from '../tenant/tenant-context.store.js';
import { computeMeriProspectScopeVersion } from '../business-development/bizdev-meri-scope.service.js';

const tenantId = '00000000-0000-7000-8000-000000000001';
const actorId = '00000000-0000-0000-0000-000000000002';
const clientId = '00000000-0000-8000-8000-000000000003';
const conversationId = '00000000-0000-0000-0000-000000000004';
const prospectId = '00000000-0000-4000-8000-000000000005';
const otherClientId = '00000000-0000-8000-8000-000000000006';
const targetTenantId = '00000000-0000-4000-8000-000000000007';
const input = { conversationId, clientId };
type Observation = { tx: number; operation: string; args?: any; sql?: string };

/** Real Nest routes, guards, private middleware provenance and canonical DB
 * owners. Only Clerk and the Prisma driver's I/O are synthetic. The real
 * PrismaService transaction wrappers execute against a new driver tx per call. */
async function fixture() {
  const observations: Observation[] = [];
  const transactions: Array<{ id: number; options: unknown; scope: unknown }> = [];
  const sequence: string[] = [];
  const user = { id: actorId, clerkUserId: 'user_current_test' };
  const tenant = { id: tenantId, slug: 'tenant', status: 'active', clerkOrgId: 'org_current_test',
    settings: { clioFeatureFlags: { 'businessDevelopment.enabled': true, 'businessDevelopment.meriProspectTools.enabled': true } } };
  const targetTenant = { ...tenant, id: targetTenantId, slug: 'target', clerkOrgId: 'org_current_target' };
  const membership = { id: 'membership-current', tenantId, userId: actorId, status: 'active',
    role: 'standard_user', tenant, updatedAt: new Date(2), lastSeenAt: new Date(3) };
  const targetMembership = { ...membership, id: 'membership-target', tenantId: targetTenantId, tenant: targetTenant,
    role: 'capiro_admin' };
  const row: any = { id: conversationId, tenantId, userId: actorId, clientId, status: 'active', archivedAt: null, metadata: {} };
  const client = { id: clientId, tenantId, status: 'active', memoryWall: false,
    memoryAccessGrants: [{ id: 'grant-current', tenantId, clientId, userId: actorId, createdAt: new Date(4) }] };
  const prospect = { id: prospectId, tenantId, displayName: 'Synthetic prospect', canonicalEntityId: null as string | null,
    linkedClientId: clientId };
  const impersonation = { id: 'impersonation-current', actorUserId: actorId, tenantId: targetTenantId,
    startedAt: new Date(1), expiresAt: new Date(Date.now() + 30_000), endedAt: null as Date | null, tenant: targetTenant };
  let allowedClients = [{ id: otherClientId, revision: '2'.repeat(32) }, { id: clientId, revision: '1'.repeat(32) }];
  let visible = true;
  let wallAllowed = true;
  let control = false;
  let onlineError: unknown;
  let nextTx = 0;
  let authorityTenantId = tenantId;
  const session = { id: 'sess_current_test', userId: user.clerkUserId, status: 'active', createdAt: 1,
    expireAt: Date.now() + 600_000, abandonAt: Date.now() + 500_000, expiresAtMs: Date.now() + 300_000, actor: null };
  const nativeSession = jest.fn(async () => {
    sequence.push('session');
    if (onlineError) throw onlineError;
    return session;
  });
  const controlSession = jest.fn(async () => {
    sequence.push('control-session');
    if (onlineError) throw onlineError;
    return session;
  });
  const clerk = {
    verifySessionToken: async () => ({ sub: user.clerkUserId, iss: 'https://clerk.app.capiro.ai',
      exp: Math.floor(Date.now() / 1000) + 300,
      ...(control ? { meri_control_credential: true, jti: 'current_control_jti', iat: Math.floor(Date.now() / 1000) }
        : { sid: session.id }),
      capiro_tenant_id: tenantId, capiro_tenant_slug: 'tenant', org_id: tenant.clerkOrgId }),
    assertActiveApplicationAuthoritySession: nativeSession,
    assertActiveMeriControlCredentialSession: controlSession,
  };
  const prisma: any = {
    scopedClient(scope: unknown) {
      return { $transaction: async (fn: (tx: any) => Promise<unknown>, options?: unknown) => {
        const id = ++nextTx;
        sequence.push('transaction');
        transactions.push({ id, options, scope });
        const observe = (operation: string, args?: any) => observations.push({ tx: id, operation, args });
        const tx = {
          $executeRaw: async (parts: TemplateStringsArray, ...values: unknown[]) => {
            observations.push({ tx: id, operation: '$executeRaw', sql: parts.join('?').replace(/\s+/g, ' ').trim(), args: values });
            return 0;
          },
          $queryRaw: async (parts: TemplateStringsArray, ...values: unknown[]) => {
            const sql = parts.join('?').replace(/\s+/g, ' ').trim();
            observations.push({ tx: id, operation: 'accessibleClientRevisions', sql, args: values });
            expect(sql).toContain('FROM clients c');
            expect(sql).toContain('JOIN tenant_memberships m');
            expect(sql).toContain("m.status::text='active'");
            expect(sql).toContain("c.status::text<>'archived'");
            expect(sql).toContain('a.tenant_id=c.tenant_id');
            expect(sql).toContain('a.client_id=c.id');
            expect(sql).toContain('a.user_id=u.id');
            expect(values).toEqual([user.clerkUserId, authorityTenantId, 4097]);
            return allowedClients.map((entry) => ({ ...entry }));
          },
          user: {
            findUnique: async (args: any) => { observe('user.findUnique', args); return user; },
            findFirst: async (args: any) => { observe('user.findFirst', args); return user; },
            update: async (args: any) => { observe('user.update', args); return user; },
          },
          tenantMembership: {
            findMany: async (args: any) => { observe('tenantMembership.findMany', args); return [membership]; },
            findFirst: async (args: any) => {
              observe('tenantMembership.findFirst', args);
              return args.where.tenantId === targetTenantId ? targetMembership : membership;
            },
          },
          tenant: { findUnique: async (args: any) => {
            observe('tenant.findUnique', args);
            return args.where.id === targetTenantId ? targetTenant : tenant;
          } },
          impersonationSession: { findFirst: async (args: any) => { observe('impersonationSession.findFirst', args); return impersonation; } },
          clioConversation: { findFirst: async (args: any) => {
            observe('clioConversation.findFirst', args);
            return Object.entries(args.where).every(([key, value]) => row[key] === value) ? row : null;
          } },
          client: {
            findMany: async (args: any) => { observe('client.findMany', args); return wallAllowed ? [{ id: clientId }] : []; },
            findFirst: async (args: any) => {
              observe('client.findFirst', args);
              expect(args.where).toEqual({ id: clientId, tenantId: authorityTenantId, status: { not: 'archived' } });
              return visible ? client : null;
            },
          },
          businessDevelopmentProspect: { findFirst: async (args: any) => {
            observe('businessDevelopmentProspect.findFirst', args);
            expect(args.where).toEqual({ tenantId: authorityTenantId, id: prospectId });
            return prospect;
          } },
        };
        return fn(tx);
      } };
    },
    withSystem: PrismaService.prototype.withSystem,
    withTenant: PrismaService.prototype.withTenant,
  };
  const module = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), ApplicationAuthorityModule],
  }).overrideProvider(PrismaService).useValue(prisma).overrideProvider(ClerkService).useValue(clerk).compile();
  const app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  await app.init();
  const middleware = new TenantContextMiddleware(clerk as any, prisma, module.get(TenantContextStore));
  const router = app.getHttpAdapter().getInstance()._router;
  function clearObservations() {
    observations.length = 0; transactions.length = 0; sequence.length = 0;
    nativeSession.mockClear(); controlSession.mockClear();
  }
  async function request(path: string, body: unknown, options: {
    bearer?: boolean; headers?: Record<string, string>; method?: string; originalUrl?: string;
    afterAuthentication?: (req: any) => void; unboundRequest?: boolean;
  } = {}) {
    const url = `/api/clio/application-authority/${path}`;
    const headers: Record<string, string> = { ...(options.bearer === false ? {} : { authorization: 'Bearer synthetic' }), ...options.headers };
    const req: any = Object.assign(new EventEmitter(), { method: options.method ?? 'POST', path: url,
      originalUrl: options.originalUrl ?? url, url, headers, body, hostname: 'localhost',
      header: (name: string) => headers[name] });
    const response: any = Object.assign(new EventEmitter(), { statusCode: 200, headersSent: false,
      headers: {} as Record<string, string>, body: undefined as unknown, writableEnded: false, destroyed: false,
      setHeader(key: string, value: string) { this.headers[key.toLowerCase()] = value; return this; },
      set(key: string, value: string) { return this.setHeader(key, value); },
      getHeader(key: string) { return this.headers[key.toLowerCase()]; },
      status(code: number) { this.statusCode = code; return this; },
      send(value: unknown) { this.body = value; this.headersSent = true; this.writableEnded = true; return this; },
      json(value: unknown) { return this.send(value); },
      end() { this.headersSent = true; this.writableEnded = true; return this; },
    });
    req.res = response;
    clearObservations();
    try { await middleware.use(req, response, () => {}); }
    catch (error) { response.status((error as any).getStatus()).json((error as any).getResponse()); return response; }
    // Authentication retains its existing lastSeenAt write/transaction. The
    // combined authority handler's snapshot starts only after it has completed.
    clearObservations();
    options.afterAuthentication?.(req);
    const dispatchRequest = options.unboundRequest ? Object.assign(new EventEmitter(), req) : req;
    const layer = router.stack.find((entry: any) => entry.route?.path === req.path && entry.route.methods.post);
    expect(layer).toBeDefined();
    await layer.route.stack[0].handle(dispatchRequest, response, () => {});
    return response;
  }
  function prospectScope() {
    row.metadata = { bizdevProspectScope: {
      prospectId, prospectName: prospect.displayName, canonicalOrganizationId: prospect.canonicalEntityId,
      linkedClientId: prospect.linkedClientId,
      scopeVersion: computeMeriProspectScopeVersion({ prospectId, canonicalOrganizationId: prospect.canonicalEntityId,
        linkedClientId: prospect.linkedClientId }),
    } };
  }
  return { app, module, request, observations, transactions, sequence, nativeSession, controlSession,
    user, tenant, targetTenant, membership, targetMembership, row, client, prospect, session, impersonation, prospectScope,
    setControl() { control = true; }, setOnlineError(error: unknown) { onlineError = error; },
    hideClient() { visible = false; }, revokeWall() { wallAllowed = false; },
    setClients(rows: typeof allowedClients) { allowedClients = rows; },
    impersonate() {
      authorityTenantId = targetTenantId;
      membership.role = 'capiro_admin'; row.tenantId = targetTenantId; client.tenantId = targetTenantId;
      client.memoryAccessGrants[0]!.tenantId = targetTenantId;
    },
  };
}

describe('combined current authority registered HTTP boundary', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });
  afterEach(async () => { await f?.app.close(); });

  it('equals the three existing receipts for the same identity, membership, wall and prospect state', async () => {
    f.prospectScope();
    const identity = await f.request('identity', {});
    const membership = await f.request('membership', {});
    const context = await f.request('context', { ...input, identitySha256: 'a'.repeat(64) });
    expect([identity.statusCode, membership.statusCode, context.statusCode]).toEqual([200, 200, 200]);
    const response = await f.request('current', input);
    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual([
      'checkedAtMs', 'clientIds', 'contextRevision', 'conversationId', 'expiresAtMs', 'identityRevision',
      'membershipRevision', 'permissions', 'principal', 'role', 'selectedClientId',
    ]);
    expect(response.body).toMatchObject({ principal: identity.body.principal,
      identityRevision: identity.body.identityRevision, membershipRevision: membership.body.membershipRevision,
      role: membership.body.role, permissions: membership.body.permissions, clientIds: membership.body.clientIds,
      contextRevision: context.body.contextRevision, conversationId, selectedClientId: clientId });
    expect(response.body.clientIds).toEqual([clientId, otherClientId]);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.body.expiresAtMs).toBe(response.body.checkedAtMs + 120_000);
  });

  it('makes one online read before one repeatable-read transaction whose first SQL is READ ONLY', async () => {
    f.prospectScope();
    const response = await f.request('current', input);
    expect(response.statusCode).toBe(200);
    expect(f.nativeSession).toHaveBeenCalledTimes(1);
    expect(f.controlSession).not.toHaveBeenCalled();
    expect(f.sequence).toEqual(['session', 'transaction']);
    expect(f.transactions).toHaveLength(1);
    expect(f.transactions[0]).toMatchObject({ scope: { bypass: true }, options: { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead } });
    expect(f.observations[0]).toMatchObject({ operation: '$executeRaw', sql: 'SET TRANSACTION READ ONLY' });
    expect(f.observations[1]).toMatchObject({ operation: '$executeRaw', sql: "SELECT set_config('app.bypass_rls', 'on', true)" });
    expect(new Set(f.observations.map(({ tx }) => tx))).toEqual(new Set([f.transactions[0]!.id]));
    for (const operation of ['user.findFirst', 'tenantMembership.findFirst', 'accessibleClientRevisions',
      'clioConversation.findFirst', 'tenant.findUnique', 'businessDevelopmentProspect.findFirst', 'client.findFirst', 'client.findMany']) {
      expect(f.observations.some((read) => read.operation === operation)).toBe(true);
    }
    expect(f.observations.filter(({ operation }) => operation === 'accessibleClientRevisions')).toHaveLength(1);
    expect(f.observations.filter(({ operation }) => operation === 'clioConversation.findFirst')).toHaveLength(1);
    expect(f.observations.filter(({ operation }) => operation === 'businessDevelopmentProspect.findFirst')).toHaveLength(1);
    expect(f.observations.some(({ operation }) => /\.(?:update|create|delete|upsert)/.test(operation))).toBe(false);
    expect(f.observations.find(({ operation }) => operation === 'user.findFirst')!.args.where)
      .toEqual({ id: actorId, clerkUserId: f.user.clerkUserId });
    for (const read of f.observations.filter(({ operation }) => operation === 'tenantMembership.findFirst')) {
      expect(read.args.where).toMatchObject({ tenantId, userId: actorId, status: 'active' });
    }
    expect(f.observations.find(({ operation }) => operation === 'clioConversation.findFirst')!.args.where)
      .toEqual({ id: conversationId, tenantId, userId: actorId, archivedAt: null });
  });

  it('accepts a matching empty or partial expectation and returns the exact conflict body for any mismatch', async () => {
    const original = await f.request('current', input);
    expect(original.statusCode).toBe(200);
    for (const expectValue of [{}, { membershipRevision: original.body.membershipRevision }, {
      identityRevision: original.body.identityRevision, contextRevision: original.body.contextRevision,
    }]) expect((await f.request('current', { ...input, expect: expectValue })).statusCode).toBe(200);
    for (const revision of ['identityRevision', 'membershipRevision', 'contextRevision']) {
      const response = await f.request('current', { ...input, expect: { [revision]: 'f'.repeat(64) } });
      expect(response.statusCode).toBe(409);
      expect(response.body).toEqual({ error: 'CHANGED' });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(f.observations.some(({ operation }) => /\.(?:update|create|delete|upsert)/.test(operation))).toBe(false);
    }
  });

  it('preserves an unanswered Clerk result as503 without opening a snapshot', async () => {
    f.setOnlineError(new ApplicationAuthorityUnavailableException());
    const response = await f.request('current', input);
    expect(response.statusCode).toBe(503);
    expect(response.body.message).toBe('Application authority unavailable');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(f.transactions).toEqual([]);
  });

  it('preserves answered authentication refusal as401 and missing bearer as401 with no-store', async () => {
    f.setOnlineError(new UnauthorizedException('Application authority unavailable'));
    expect((await f.request('current', input)).statusCode).toBe(401);
    expect(f.transactions).toEqual([]);
    const missing = await f.request('current', input, { bearer: false });
    expect(missing.statusCode).toBe(401);
    expect(missing.headers['cache-control']).toBe('no-store');
  });

  it.each(['archivedAt', 'status', 'userId', 'tenantId', 'clientId'])(
    'refuses conversation %s changes as403', async (field) => {
      const response = await f.request('current', input, { afterAuthentication() {
        f.row[field] = field === 'archivedAt' ? new Date(1) : field === 'status' ? 'closed' : otherClientId;
      } });
      expect(response.statusCode).toBe(403);
      expect(response.body.message).toBe('Application authority unavailable');
    },
  );

  it.each(['membership', 'tenant', 'role', 'client', 'wall', 'prospect'])(
    'refuses current %s revocation as403 and never trusts previous checks', async (kind) => {
      f.prospectScope();
      const response = await f.request('current', input, { afterAuthentication() {
        if (kind === 'membership') f.membership.status = 'inactive';
        if (kind === 'tenant') f.tenant.status = 'inactive';
        if (kind === 'role') f.membership.role = 'unknown';
        if (kind === 'client') f.hideClient();
        if (kind === 'wall') f.revokeWall();
        if (kind === 'prospect') f.prospect.linkedClientId = otherClientId;
      } });
      expect(response.statusCode).toBe(403);
      expect(response.body.message).toBe('Application authority unavailable');
    },
  );

  it('requires genuine middleware request provenance and the exact context object', async () => {
    expect((await f.request('current', input, { unboundRequest: true })).statusCode).toBe(403);
    expect(f.transactions).toEqual([]);
    expect((await f.request('current', input, { afterAuthentication(req) {
      req.tenantContext = { ...req.tenantContext };
    } })).statusCode).toBe(403);
    expect(f.nativeSession).not.toHaveBeenCalled();
    expect(f.transactions).toEqual([]);
  });

  it('preserves original impersonation identity on the same system tx and clips its expiry', async () => {
    f.impersonate();
    const options = { headers: { 'x-capiro-impersonate-tenant': 'target' } };
    const response = await f.request('current', input, options);
    expect(response.statusCode).toBe(200);
    expect(response.body.principal).toEqual({ tenantId: targetTenantId, actorId });
    expect(response.body.expiresAtMs).toBe(f.impersonation.expiresAt.getTime());
    const reads = f.observations.filter(({ operation }) => operation === 'tenantMembership.findFirst');
    expect(reads[0]!.args.where).toEqual({ id: f.membership.id, tenantId, userId: actorId, status: 'active' });
    expect(reads.some(({ args }) => args.where.tenantId === targetTenantId)).toBe(true);
    expect(new Set(f.observations.map(({ tx }) => tx)).size).toBe(1);
    const expired = await f.request('current', input, { ...options, afterAuthentication() {
      f.impersonation.expiresAt = new Date(Date.now() - 1);
    } });
    expect(expired.statusCode).toBe(403);
    expect(expired.body.message).toBe('Application authority unavailable');
  });

  it('caps the receipt at the original session expiry when it is sooner than two minutes', async () => {
    f.session.expiresAtMs = Date.now() + 20_000;
    const response = await f.request('current', input);
    expect(response.statusCode).toBe(200);
    expect(response.body.expiresAtMs).toBe(f.session.expiresAtMs);
  });

  it.each([
    ['unknown key', { ...input, unknown: true }], ['bad UUID', { ...input, conversationId: 'not-a-uuid' }],
    ['bad hash', { ...input, expect: { identityRevision: 'A'.repeat(64) } }],
    ['unknown expectation', { ...input, expect: { unknown: 'a'.repeat(64) } }],
    ['null expectation', { ...input, expect: null }], ['array expectation', { ...input, expect: [] }],
    ['oversize value', { ...input, clientId: 'x'.repeat(4097) }],
  ])('rejects %s as400 before session or snapshot reads', async (_name, body) => {
    const response = await f.request('current', body);
    expect(response.statusCode).toBe(400);
    expect(f.nativeSession).not.toHaveBeenCalled();
    expect(f.transactions).toEqual([]);
  });

  it('refuses an oversized declared request body before the authority session and snapshot', async () => {
    const response = await f.request('current', input, { headers: { 'content-length': '4097' } });
    expect(response.statusCode).toBe(400);
    expect(f.nativeSession).not.toHaveBeenCalled();
    expect(f.transactions).toEqual([]);
  });

  it('admits the marked control credential on current through the exact middleware allowlist', async () => {
    f.setControl();
    const response = await f.request('current', input);
    expect(response.statusCode).toBe(200);
    expect(f.nativeSession).not.toHaveBeenCalled();
    expect(f.controlSession).toHaveBeenCalledTimes(1);
    expect(f.controlSession).toHaveBeenCalledWith(expect.objectContaining({ meri_control_credential: true, sub: f.user.clerkUserId }));
  });

  it.each([
    ['artifact', 'POST'], ['current/', 'POST'], ['CURRENT', 'POST'], ['current-extra', 'POST'],
    ['%63urrent', 'POST'], ['current', 'GET'], ['current', 'HEAD'],
  ])('keeps control credentials refused before DB access on %s %s', async (path, method) => {
    f.setControl();
    const response = await f.request(path, input, { method });
    expect(response.statusCode).toBe(401);
    expect(f.transactions).toEqual([]);
    expect(f.controlSession).not.toHaveBeenCalled();
  });

  it('refuses rewritten and absolute-form control targets', async () => {
    f.setControl();
    for (const originalUrl of ['/api/clio/application-authority/artifact', 'https://app.capiro.ai/api/clio/application-authority/current']) {
      expect((await f.request('current', input, { originalUrl })).statusCode).toBe(401);
      expect(f.transactions).toEqual([]);
    }
  });
});

describe('tenant read-only snapshot transaction option', () => {
  it('forwards isolation and timeout and sets READ ONLY before the tenant GUC on the same tx', async () => {
    const sql: Array<{ statement: string; values: unknown[] }> = [];
    const tx = { $executeRaw: async (parts: TemplateStringsArray, ...values: unknown[]) => {
      sql.push({ statement: parts.join('?'), values });
      return 0;
    } };
    const transaction = jest.fn(async (fn: (value: typeof tx) => Promise<unknown>, _options: unknown) => fn(tx));
    const scopedClient = jest.fn(() => ({ $transaction: transaction }));
    const read = jest.fn(async (value: unknown) => {
      expect(value).toBe(tx);
      expect(sql).toEqual([
        { statement: 'SET TRANSACTION READ ONLY', values: [] },
        { statement: "SELECT set_config('app.current_tenant', ?, true)", values: [tenantId] },
      ]);
      return 'snapshot-result';
    });
    const result = await PrismaService.prototype.withTenant.call({ scopedClient }, tenantId, read, {
      readOnly: true, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeoutMs: 3210,
    });
    expect(result).toBe('snapshot-result');
    expect(scopedClient).toHaveBeenCalledWith({ tenantId });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0]![1]).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 3210 });
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('closed current body descriptors', () => {
  it('does not execute accessors, proxies or inherited serialization hooks', () => {
    const accessor = jest.fn(() => conversationId);
    const trap = jest.fn(() => { throw new Error('proxy must not be inspected'); });
    const toJSON = jest.fn(() => input);
    for (const body of [
      Object.defineProperty({ clientId }, 'conversationId', { enumerable: true, get: accessor }),
      new Proxy(input, { ownKeys: trap }),
      { ...input, expect: new Proxy({}, { ownKeys: trap }) },
      Object.assign(Object.create({ toJSON }), input),
      { ...input, [Symbol('hidden')]: true },
    ]) expect(() => parseApplicationAuthorityCurrentBody(body)).toThrow();
    expect(accessor).not.toHaveBeenCalled();
    expect(trap).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
  });

  it('accepts null-prototype records and every optional revision subset', () => {
    expect(parseApplicationAuthorityCurrentBody(Object.assign(Object.create(null), input))).toEqual(input);
    for (const revision of ['identityRevision', 'membershipRevision', 'contextRevision']) {
      const body = { ...input, expect: Object.assign(Object.create(null), { [revision]: 'a'.repeat(64) }) };
      expect(parseApplicationAuthorityCurrentBody(body)).toEqual(body);
    }
  });
});
