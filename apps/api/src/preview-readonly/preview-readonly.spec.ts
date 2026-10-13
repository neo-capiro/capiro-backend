import 'reflect-metadata';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type CallHandler, type ExecutionContext, type INestApplication } from '@nestjs/common';
import { of, lastValueFrom, defer } from 'rxjs';
import request from 'supertest';
import { PrismaService } from '../prisma/prisma.service.js';
import { ClerkService, type ClerkSessionClaims } from '../auth/clerk.service.js';
import { TenantContextStore } from '../tenant/tenant-context.store.js';
import { PreviewReadOnlyInterceptor } from './preview.interceptor.js';
import { previewConfig } from './preview.config.js';
import { previewRoutePolicy } from './preview.route-policy.js';
import { readClients } from '../clients/clients.read.js';
import { PreviewReadOnlyModule } from './preview.module.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const clientId = '22222222-2222-4222-8222-222222222222';
const otherTenant = '33333333-3333-4333-8333-333333333333';
const config = previewConfig({
  CAPIRO_PREVIEW_READONLY: 'true', PREVIEW_READONLY_DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1/synthetic',
  PREVIEW_TENANT_ID: tenantId, PREVIEW_CLERK_ORG_ID: 'org_synthetic',
  CLERK_SECRET_KEY: 'synthetic-test-input', CLERK_JWT_ISSUER: 'https://synthetic.invalid', NODE_ENV: 'test',
});
const baseClaims: ClerkSessionClaims = {
  sub: 'user_synthetic', sid: 'sess_synthetic', iss: config.preview.CLERK_JWT_ISSUER, exp: Math.floor(Date.now() / 1000) + 600,
  org_id: 'org_synthetic', org_slug: 'capiro-internal', org_role: 'org:member',
};
function harness() {
  let claims: ClerkSessionClaims = { ...baseClaims };
  let user: any = { id: 'local-user', clerkUserId: claims.sub, email: 'synthetic@example.invalid' };
  let membership: any = {
    id: 'membership', userId: user.id, tenantId, status: 'active', role: 'standard_user', billingAdmin: false,
    updatedAt: new Date(1000), tenant: { id: tenantId, slug: 'capiro-internal', status: 'active', clerkOrgId: 'org_synthetic' },
  };
  const calls: Array<{ model: string; operation: string; args: any }> = [];
  const statements: string[] = [];
  let safe = true;
  let commitFailure = false;
  let committed = false;
  const read = (model: string, operation: string, value: () => unknown) => jest.fn(async (args: any) => {
    calls.push({ model, operation, args }); return value();
  });
  const clients = [
    { id: clientId, tenantId, name: 'Synthetic client', logoS3Key: 'unresolved/test/key', status: 'active', createdAt: new Date(1) },
    { id: 'foreign-client', tenantId: otherTenant, name: 'Foreign', logoS3Key: null, status: 'active', createdAt: new Date(2) },
  ];
  const tx: any = {
    $executeRaw: jest.fn(async (parts: TemplateStringsArray) => { statements.push(parts.join('?')); return 0; }),
    $queryRaw: jest.fn(async () => [{ safe }]),
    user: { findUnique: read('user', 'findUnique', () => user) },
    tenantMembership: { findUnique: read('tenantMembership', 'findUnique', () => membership) },
    tenant: { findUnique: read('tenant', 'findUnique', () => ({ name: 'Synthetic internal', settings: {}, planTier: 'starter' })) },
    client: {
      findMany: jest.fn(async (args: any) => {
        calls.push({ model: 'client', operation: 'findMany', args });
        return clients.filter((row) => row.tenantId === args.where.tenantId);
      }),
      findFirst: jest.fn(async (args: any) => {
        calls.push({ model: 'client', operation: 'findFirst', args });
        return clients.find((row) => row.tenantId === args.where.tenantId && row.id === args.where.id) ?? null;
      }),
    },
  };
  // Every unreviewed delegate/write is absent, so invoking one fails the test.
  const prisma = Object.create(PrismaService.prototype) as PrismaService;
  Object.assign(prisma, {
    logger: { log: jest.fn() }, previewTransaction: new AsyncLocalStorage(), tenantScopedModels: new Set(['Client', 'TenantMembership']),
    $connect: jest.fn(async () => undefined), $disconnect: jest.fn(async () => undefined),
    $extends: jest.fn(() => ({ $transaction: jest.fn(async (fn: (value: any) => Promise<any>) => {
      committed = false; const result = await fn(tx);
      if (commitFailure) throw new Error('Synthetic commit refusal');
      committed = true; return result;
    }) })),
  });
  const clerk = {
    verifySessionToken: jest.fn(async () => ({ ...claims })),
    assertActiveApplicationAuthoritySession: jest.fn(async () => ({
      id: claims.sid, userId: claims.sub, actor: null, expiresAtMs: claims.exp! * 1000,
    })),
  } as unknown as ClerkService;
  const store = new TenantContextStore();
  const interceptor = new PreviewReadOnlyInterceptor(clerk, prisma, store, config);
  const req: any = { headers: { authorization: 'Bearer synthetic-token' } };
  const execute = (handler: () => unknown = () => of(req.tenantContext)) => lastValueFrom(interceptor.intercept(
    { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext,
    { handle: handler } as CallHandler,
  ));
  return {
    prisma, clerk, tx, calls, statements, store, req, execute,
    get claims() { return claims; }, set claims(value: ClerkSessionClaims) { claims = value; },
    get user() { return user; }, set user(value: any) { user = value; },
    get membership() { return membership; }, set membership(value: any) { membership = value; },
    set safe(value: boolean) { safe = value; }, set commitFailure(value: boolean) { commitFailure = value; },
    get committed() { return committed; },
  };
}

describe('preview existing authority and database boundary', () => {
  it('resolves ordinary member without identity, membership, lastSeen or audit writes', async () => {
    const h = harness(); expect(await h.execute()).toMatchObject({ tenantId, userId: 'local-user', role: 'standard_user' });
    expect(h.statements[0]).toBe('SET TRANSACTION READ ONLY');
    expect(h.statements[1]).toContain("set_config('app.bypass_rls', 'off'");
    expect(h.statements[2]).toContain("set_config('app.current_tenant'");
    expect(h.calls.every((call) => call.operation.startsWith('find'))).toBe(true);
    expect(h.tx.user.findUnique.mock.calls.every(([args]: any[]) => args.where.clerkUserId === baseClaims.sub)).toBe(true);
    expect(h.committed).toBe(true); expect(h.store.get()).toBeUndefined();
  });
  it.each(['org:admin', 'org:administrator', 'admin', 'administrator'])('preserves exact internal admin key %s', async (role) => {
    const h = harness(); h.claims.org_role = role; h.membership.role = 'capiro_admin';
    expect(await h.execute()).toMatchObject({ role: 'capiro_admin', tenantId });
  });
  it.each(['org:admin_readonly', 'org:not-admin', 'org:billing-admin', 'capiro_admin', 'user_admin'])('keeps custom key %s ordinary', async (role) => {
    const h = harness(); h.claims.org_role = role;
    expect(await h.execute()).toMatchObject({ role: 'standard_user' });
    h.membership.role = 'capiro_admin'; await expect(h.execute()).rejects.toThrow('Preview authority unavailable');
  });
  const denials: Array<[string, (h: ReturnType<typeof harness>) => void]> = [
    ['absent user', (h) => { h.user = null; }],
    ['mismatched Clerk identity', (h) => { h.user.clerkUserId = 'different'; }],
    ['missing membership', (h) => { h.membership = null; }],
    ['invited membership', (h) => { h.membership.status = 'invited'; }],
    ['removed membership', (h) => { h.membership.status = 'removed'; }],
    ['wrong membership user', (h) => { h.membership.userId = 'foreign'; }],
    ['wrong membership tenant', (h) => { h.membership.tenantId = otherTenant; }],
    ['inactive tenant', (h) => { h.membership.tenant.status = 'suspended'; }],
    ['wrong tenant id', (h) => { h.membership.tenant.id = otherTenant; }],
    ['wrong tenant org', (h) => { h.membership.tenant.clerkOrgId = 'org_foreign'; }],
    ['wrong tenant slug', (h) => { h.membership.tenant.slug = 'foreign'; }],
    ['stale elevated local role', (h) => { h.membership.role = 'capiro_admin'; }],
    ['unmapped local role', (h) => { h.membership.role = 'unknown'; }],
    ['missing org role', (h) => { delete h.claims.org_role; }],
    ['conflicting role claims', (h) => { h.claims.capiro_org_role = 'org:admin'; }],
    ['missing org', (h) => { delete h.claims.org_id; }],
    ['foreign org', (h) => { h.claims.org_id = 'org_foreign'; }],
    ['foreign tenant claim', (h) => { h.claims.capiro_tenant_id = otherTenant; }],
    ['foreign custom slug', (h) => { h.claims.capiro_tenant_slug = 'foreign'; }],
    ['foreign org slug', (h) => { h.claims.org_slug = 'foreign'; }],
    ['foreign issuer', (h) => { h.claims.iss = 'https://foreign.invalid'; }],
    ['expired replay', (h) => { h.claims.exp = 1; }],
    ['missing expiry', (h) => { delete h.claims.exp; }],
    ['tenant header pivot', (h) => { h.req.headers['x-capiro-tenant'] = 'foreign'; }],
    ['impersonation header', (h) => { h.req.headers['x-capiro-impersonate-tenant'] = 'foreign'; }],
    ['empty impersonation header', (h) => { h.req.headers['x-capiro-impersonate-tenant'] = ''; }],
    ['actor JWT', (h) => { (h.claims as any).act = { sub: 'actor' }; }],
    ['actor alias JWT', (h) => { (h.claims as any).actor = {}; }],
    ['missing bearer', (h) => { delete h.req.headers.authorization; }],
    ['blank bearer', (h) => { h.req.headers.authorization = 'Bearer '; }],
  ];
  it.each(denials)('fails closed: %s', async (_name, change) => {
    const h = harness(); change(h); const handler = jest.fn(() => of('must not be read'));
    await expect(h.execute(handler)).rejects.toThrow(); expect(handler).not.toHaveBeenCalled();
    expect(h.calls.every((call) => call.operation.startsWith('find'))).toBe(true);
    expect(h.store.get()).toBeUndefined();
  });
  it('does not adopt an email collision when the Clerk identity is absent', async () => {
    const h = harness(); h.user = null; h.claims.email = 'existing@example.invalid';
    await expect(h.execute()).rejects.toThrow();
    expect(h.calls).toHaveLength(1); expect(h.calls[0]!.args.where).toEqual({ clerkUserId: baseClaims.sub });
  });
  it('refuses a writable/owner database role before identity or handler reads', async () => {
    const h = harness(); h.safe = false; await expect(h.execute()).rejects.toThrow('Preview read unavailable');
    expect(h.calls).toHaveLength(0); expect(h.statements).toEqual(['SET TRANSACTION READ ONLY']);
  });
  it('returns no buffered response if database commit fails', async () => {
    const h = harness(); h.commitFailure = true; await expect(h.execute()).rejects.toThrow('Preview read unavailable');
    expect(h.committed).toBe(false);
  });
  it('rejects membership changes/revocation during the handler', async () => {
    const h = harness(); await expect(h.execute(() => {
      h.membership = { ...h.membership, updatedAt: new Date(2000) }; return of('data');
    })).rejects.toThrow('Preview authority changed');
    h.membership.status = 'removed'; await expect(h.execute()).rejects.toThrow('Preview authority unavailable');
  });
  it('accepts equivalent exact role aliases but rejects an elevated/local mismatch', async () => {
    const h = harness(); h.claims.org_role = 'org:admin'; h.claims.capiro_org_role = 'admin'; h.membership.role = 'capiro_admin';
    expect(await h.execute()).toMatchObject({ role: 'capiro_admin' });
  });
  it('rejects revoked online sessions before reading and during response buffering', async () => {
    const h = harness();
    const session = h.clerk.assertActiveApplicationAuthoritySession as jest.Mock;
    session.mockRejectedValueOnce(new Error('revoked'));
    await expect(h.execute()).rejects.toThrow('Preview read unavailable'); expect(h.calls).toHaveLength(0);
    await expect(h.execute(() => { session.mockRejectedValueOnce(new Error('revoked during read')); return of('data'); })).rejects.toThrow('Preview read unavailable');
  });
  it('rejects an online session actor even when token actor claims are absent', async () => {
    const h = harness(); (h.clerk.assertActiveApplicationAuthoritySession as jest.Mock).mockResolvedValueOnce({ actor: { sub: 'actor' } });
    await expect(h.execute()).rejects.toThrow('Impersonation unavailable'); expect(h.calls).toHaveLength(0);
  });
  it('rechecks expiry after the handler', async () => {
    const h = harness(); const clock = jest.spyOn(Date, 'now');
    try {
      await expect(h.execute(() => { clock.mockReturnValue(h.claims.exp! * 1000 + 1); return of('data'); })).rejects.toThrow();
    } finally { clock.mockRestore(); }
  });
  it('uses one scoped read-only transaction and rejects tenant/system escape', async () => {
    const h = harness(); await h.execute(() => defer(async () => {
      expect(h.store.require().tenantId).toBe(tenantId);
      expect(await h.prisma.withTenant(tenantId, async (tx) => tx)).toBe(h.tx);
      await expect(h.prisma.withTenant(otherTenant, async () => 'leak')).rejects.toThrow('tenant mismatch');
      await expect(h.prisma.withSystem(async () => 'leak')).rejects.toThrow('cannot open');
      await expect(h.prisma.withTenantUser(tenantId, 'user', async () => 'leak')).rejects.toThrow('cannot open');
      return 'safe';
    }));
    expect(h.statements).toHaveLength(3);
  });
  it('preserves ordinary withTenant behavior outside the preview context', async () => {
    const h = harness(); await h.prisma.withTenant(tenantId, async () => 'ordinary');
    expect(h.tx.$queryRaw).not.toHaveBeenCalled();
    expect(h.statements).toEqual(["SELECT set_config('app.current_tenant', ?, true)"]);
  });
  it('preserves canonical client filters, ordering and explicit archive opt-in', async () => {
    const h = harness(); const ctx: any = { tenantId };
    await readClients(h.prisma, ctx, { profileStatus: 'complete', sectorTag: 'energy' }, async (client) => ({ ...client, logoUrl: 'synthetic-logo' }));
    expect(h.tx.client.findMany).toHaveBeenLastCalledWith({ where: { tenantId, profileStatus: 'complete', sectorTag: 'energy', status: { not: 'archived' } }, orderBy: { createdAt: 'desc' } });
    await readClients(h.prisma, ctx, { includeArchived: true }, async (client) => ({ ...client, logoUrl: null }));
    expect(h.tx.client.findMany).toHaveBeenLastCalledWith({ where: { tenantId }, orderBy: { createdAt: 'desc' } });
  });
  it('isolates overlapping requests and clears context after completion', async () => {
    const h = harness(); const observations: string[] = [];
    await Promise.all(['first', 'second'].map((label) => h.prisma.withPreviewReadOnly(tenantId, async (tx) => {
      await Promise.resolve(); expect(await h.prisma.withTenant(tenantId, async (inner) => inner)).toBe(tx);
      observations.push(label);
    })));
    expect(observations.sort()).toEqual(['first', 'second']);
    expect(h.store.get()).toBeUndefined();
  });
});

describe('bounded preview actual HTTP handlers with synthetic authority', () => {
  let app: INestApplication;
  let h: ReturnType<typeof harness>;
  beforeEach(async () => {
    h = harness(); const module = await Test.createTestingModule({ imports: [PreviewReadOnlyModule.register(config)] })
      .overrideProvider(PrismaService).useValue(h.prisma).overrideProvider(ClerkService).useValue(h.clerk).compile();
    app = module.createNestApplication(); app.use(previewRoutePolicy); app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  });
  afterEach(async () => { await app.close(); });
  it('reads canonical /me, list and same-tenant detail with no writes/providers', async () => {
    const me = await request(app.getHttpServer()).get('/api/me').set('Authorization', 'Bearer synthetic').expect(200);
    expect(me.body.role).toBe('standard_user'); expect(me.body.user.id).toBe('local-user');
    const list = await request(app.getHttpServer()).get('/api/clients').set('Authorization', 'Bearer synthetic').expect(200);
    expect(list.body).toHaveLength(1); expect(list.body[0].logoUrl).toBeNull();
    const detail = await request(app.getHttpServer()).get(`/api/clients/${clientId}`).set('Authorization', 'Bearer synthetic').expect(200);
    expect(detail.body.tenantId).toBe(tenantId); expect(detail.headers['cache-control']).toBe('no-store');
    expect(h.calls.filter((call) => call.model === 'client').every((call) => call.args.where.tenantId === tenantId)).toBe(true);
    expect(h.calls.every((call) => call.operation.startsWith('find'))).toBe(true);
  });
  it('denies cross-tenant detail despite a real foreign client fixture', async () => {
    const id = '44444444-4444-4444-8444-444444444444';
    await request(app.getHttpServer()).get(`/api/clients/${id}`).set('Authorization', 'Bearer synthetic').expect(404);
    expect(h.tx.client.findFirst).toHaveBeenCalledWith({ where: { id, tenantId } });
  });
  it.each(['post', 'put', 'patch', 'delete', 'head', 'options'] as const)('rejects %s before auth/database/controller dispatch', async (method) => {
    await request(app.getHttpServer())[method]('/api/me').expect(403);
    expect(h.clerk.verifySessionToken).not.toHaveBeenCalled(); expect(h.calls).toHaveLength(0);
  });
  it.each(['/api/health', '/api/health/pe', '/api/clients/bulk-import', `/api/clients/${clientId}/memory-access`, '/api/internal', '/api/webhooks/clerk', '/api/engagement/integrations/microsoft/callback', '/api/me/', '/api/%6de', '/api/clients?tenantId=foreign'])('denies nonallowlisted/malformed route or query %s', async (url) => {
    await request(app.getHttpServer()).get(url).set('Authorization', 'Bearer synthetic').expect(url.includes('?') ? 400 : 403);
    expect(h.calls.filter((call) => call.model === 'client')).toHaveLength(0);
  });
  it.each(['x-http-method-override', 'x-method-override', 'x-http-method'])('rejects method override header %s before auth', async (header) => {
    await request(app.getHttpServer()).get('/api/me').set(header, 'POST').expect(403);
    expect(h.clerk.verifySessionToken).not.toHaveBeenCalled();
  });
  it('rejects a method override query before auth', async () => {
    await request(app.getHttpServer()).get('/api/me?_method=POST').expect(403);
    expect(h.clerk.verifySessionToken).not.toHaveBeenCalled();
  });
  it('rejects a removed membership on token replay without auth cache', async () => {
    await request(app.getHttpServer()).get('/api/me').set('Authorization', 'Bearer synthetic').expect(200);
    h.membership.status = 'removed';
    await request(app.getHttpServer()).get('/api/me').set('Authorization', 'Bearer synthetic').expect(403);
  });
});

describe('preview bootstrap configuration', () => {
  it.each(['CAPIRO_PREVIEW_READONLY', 'PREVIEW_READONLY_DATABASE_URL', 'PREVIEW_TENANT_ID', 'PREVIEW_CLERK_ORG_ID', 'CLERK_JWT_ISSUER'])('requires explicit %s with no production fallback', (key) => {
    const raw: any = { ...config.preview, CLERK_SECRET_KEY: 'synthetic' }; delete raw[key];
    expect(() => previewConfig(raw)).toThrow();
  });
  it('refuses a non-PostgreSQL DB URL and an unpinned/insecure issuer', () => {
    expect(() => previewConfig({ ...config.preview, CLERK_SECRET_KEY: 'synthetic', PREVIEW_READONLY_DATABASE_URL: 'https://synthetic.invalid' })).toThrow();
    expect(() => previewConfig({ ...config.preview, CLERK_SECRET_KEY: 'synthetic', CLERK_JWT_ISSUER: 'http://synthetic.invalid' })).toThrow();
  });
});
