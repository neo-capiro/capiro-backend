import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ClientsController } from './clients.controller.js';
import { ClientsService } from './clients.service.js';
import { PreviewNativeReadService } from '../auth/preview-native-read.service.js';
import { TenantContextMiddleware } from '../tenant/tenant-context.middleware.js';
import { TenantContextStore } from '../tenant/tenant-context.store.js';

// Every external transport is inert before any product import runs: no DB, no
// Clerk network call and no S3 presign. The DB and Clerk ports below are
// synthetic; the middleware, the route predicates, the controller, the
// RolesGuard and the CurrentTenant decorator are the real owners.
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));

const PREVIEW_HOST = 'first-chat-preview.app-dev.capiro.ai';
const ROSTER_HOST = 'core-roster-preview.capiro.ai';
const T = '11111111-1111-4111-8111-111111111111';
const U = '22222222-2222-4222-8222-222222222222';
const OTHER_TENANT = '33333333-3333-4333-8333-333333333333';
const CLIENT = '44444444-4444-4444-8444-444444444444';
const ROUTE = '/api/clients/metrics';

type Claims = Record<string, unknown>;

type Invoke = {
  host?: string;
  rawHosts?: string[];
  enabled?: boolean | 'unset';
  rosterEnabled?: boolean;
  method?: string;
  target?: string;
  authorization?: string | null;
  sessionInvalid?: boolean;
  claims?: Claims;
  role?: string;
  userPresent?: boolean;
  memberships?: unknown[];
};

/** Actual ClientsController + native tenant middleware + real route predicates.
 * Only the DB and Clerk IO ports are inert; nothing reimplements the product chain. */
async function fixture() {
  const tenant = { id: T, slug: 'tenant', status: 'active', clerkOrgId: 'org_native' };
  const user = { id: U, clerkUserId: 'user_native' };
  const membership = (role: string) => ({
    id: 'native_membership', tenantId: T, userId: U, status: 'active', role, tenant, updatedAt: new Date(2),
  });
  const session = {
    id: 'native_session', userId: user.clerkUserId, status: 'active', createdAt: 1,
    expireAt: Date.now() + 100_000, abandonAt: Date.now() + 90_000, expiresAtMs: Date.now() + 60_000, actor: null,
  };
  const metrics = jest.fn(async (ctx: { tenantId: string }) => ({ ok: true, tenantId: ctx.tenantId }));
  const service = {
    metrics, list: jest.fn(async () => []), get: jest.fn(async () => ({ id: CLIENT })),
    listPreviewVisible: jest.fn(async () => []), getPreviewVisible: jest.fn(async () => ({ id: CLIENT })),
  };
  const preview = {
    mode: jest.fn(() => true),
    run: jest.fn(async (_req: unknown, _res: unknown, _ctx: unknown,
      operation: (ids: readonly string[]) => Promise<unknown>) => operation([CLIENT])),
  };
  const module = await Test.createTestingModule({
    controllers: [ClientsController],
    providers: [
      { provide: ClientsService, useValue: service },
      { provide: PreviewNativeReadService, useValue: preview },
    ],
  }).compile();
  const app: INestApplication = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  await app.init();

  async function invoke(options: Invoke = {}) {
    const target = options.target ?? ROUTE;
    const path = target.split('?')[0]!;
    const method = options.method ?? 'GET';
    const host = options.host ?? PREVIEW_HOST;
    const rawHosts = options.rawHosts ?? [host];
    const stored: Record<string, string> = { host };
    if (options.authorization !== null) stored.authorization = options.authorization ?? 'Bearer synthetic-session';
    const req: any = {
      method, path, originalUrl: target, url: target, baseUrl: '',
      headers: stored, rawHeaders: rawHosts.flatMap((value) => ['Host', value]),
      hostname: host, params: { id: path.split('/')[3] ?? CLIENT },
      header: (key: string) => stored[key.toLowerCase()],
    };
    const res: any = {
      statusCode: 200, headersSent: false, headers: {} as Record<string, string>, body: undefined,
      setHeader(key: string, value: string) { this.headers[key.toLowerCase()] = value; return this; },
      set(key: string, value: string) { return this.setHeader(key, value); },
      getHeader(key: string) { return this.headers[key.toLowerCase()]; },
      status(code: number) { this.statusCode = code; return this; },
      json(value: unknown) { return this.send(value); },
      send(value: unknown) { this.body = value; this.headersSent = true; return this; },
      end() { this.headersSent = true; return this; },
    };
    const clerk = {
      verifySessionToken: async () => {
        if (options.sessionInvalid) throw new Error('SYNTHETIC_SESSION_INVALID');
        return {
          sub: user.clerkUserId, sid: session.id, iss: 'synthetic-issuer', exp: Math.floor(Date.now() / 1000) + 100,
          capiro_tenant_id: tenant.id, capiro_tenant_slug: tenant.slug, org_id: tenant.clerkOrgId,
          ...options.claims,
        } as Claims;
      },
      assertActiveApplicationAuthoritySession: async () => session,
    };
    const authTx = {
      user: { findUnique: async () => options.userPresent === false ? null : user },
      tenantMembership: {
        findMany: async () => options.memberships ?? [membership(options.role ?? 'standard_user')],
      },
    };
    const prisma = { withSystem: async (run: (tx: unknown) => Promise<unknown>) => run(authTx) };
    const middleware = new TenantContextMiddleware(clerk as never, prisma as never, new TenantContextStore());

    const previous = process.env.PREVIEW_NATIVE_GETS_ENABLED;
    const previousRoster = process.env.CORE_ROSTER_PREVIEW_ENABLED;
    if (options.enabled === 'unset') delete process.env.PREVIEW_NATIVE_GETS_ENABLED;
    else process.env.PREVIEW_NATIVE_GETS_ENABLED = options.enabled === false ? 'false' : 'true';
    process.env.CORE_ROSTER_PREVIEW_ENABLED = options.rosterEnabled === true ? 'true' : 'false';
    try {
      try {
        await middleware.use(req, res, () => {});
      } catch (error) {
        const status = typeof (error as any).getStatus === 'function' ? (error as any).getStatus() : 500;
        return res.status(status).json(typeof (error as any).getResponse === 'function' ? (error as any).getResponse() : {});
      }
      const layer = app.getHttpAdapter().getInstance()._router.stack.find(
        (entry: any) => entry.route?.methods[method.toLowerCase()] === true &&
          new RegExp(`^${entry.route.path.replace(/:[^/]+/g, '[^/]+')}/?$`).test(path),
      );
      expect(layer).toBeDefined();
      await layer.route.stack[0].handle(req, res, () => {});
      return res;
    } finally {
      if (previous === undefined) delete process.env.PREVIEW_NATIVE_GETS_ENABLED;
      else process.env.PREVIEW_NATIVE_GETS_ENABLED = previous;
      if (previousRoster === undefined) delete process.env.CORE_ROSTER_PREVIEW_ENABLED;
      else process.env.CORE_ROSTER_PREVIEW_ENABLED = previousRoster;
    }
  }

  return { app, invoke, service, preview, metrics, tenant, user };
}

describe('first-chat metrics read through the native current-session admission', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); jest.clearAllMocks(); });
  afterEach(async () => { await f.app.close(); });

  it('admits GET /api/clients/metrics on the exact preview Host and propagates current tenant/member data', async () => {
    const res = await f.invoke();
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(f.metrics).toHaveBeenCalledTimes(1);
    expect(f.metrics).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: T, userId: U, tenantSlug: 'tenant', clerkUserId: 'user_native', role: 'standard_user',
    }));
    expect(f.service.list).not.toHaveBeenCalled();
    expect(f.service.get).not.toHaveBeenCalled();
    expect(f.service.getPreviewVisible).not.toHaveBeenCalled();
  });

  it('keeps the client-detail route on its own preview branch: metrics admission never bleeds into :id', async () => {
    const res = await f.invoke({ target: `/api/clients/${CLIENT}` });
    expect(res.statusCode).toBe(200);
    expect(f.metrics).not.toHaveBeenCalled();
    expect(f.service.get).toHaveBeenCalledWith(expect.objectContaining({ tenantId: T, userId: U }), CLIENT);
  });

  it.each(['unset', false] as const)(
    'refuses the metrics read while PREVIEW_NATIVE_GETS_ENABLED is %s',
    async (enabled) => {
      const res = await f.invoke({ enabled });
      expect(res.statusCode).toBe(503);
      expect(f.metrics).not.toHaveBeenCalled();
    },
  );

  it('refuses a missing or non-bearer authorization before any local read', async () => {
    const missing = await f.invoke({ authorization: null });
    expect(missing.statusCode).toBe(401);
    expect(f.metrics).not.toHaveBeenCalled();
  });

  it('refuses an invalid session token', async () => {
    const res = await f.invoke({ sessionInvalid: true });
    expect(res.statusCode).toBe(401);
    expect(f.metrics).not.toHaveBeenCalled();
  });

  it('refuses a session whose current session evidence is expired', async () => {
    const res = await f.invoke({ claims: { exp: Math.floor(Date.now() / 1000) - 60 } });
    expect(res.statusCode).toBe(401);
    expect(f.metrics).not.toHaveBeenCalled();
  });

  it('refuses a missing local user or missing membership', async () => {
    expect((await f.invoke({ userPresent: false })).statusCode).toBe(403);
    expect((await f.invoke({ memberships: [] })).statusCode).toBe(403);
    expect(f.metrics).not.toHaveBeenCalled();
  });

  it('refuses a revoked membership row and a role below the client read minimum', async () => {
    expect((await f.invoke({
      memberships: [{ id: 'm', tenantId: T, userId: U, status: 'revoked', role: 'standard_user',
        tenant: { id: T, slug: 'tenant', status: 'active', clerkOrgId: 'org_native' } }],
    })).statusCode).toBe(403);
    expect((await f.invoke({ role: 'client_portal_user' })).statusCode).toBe(403);
    expect(f.metrics).not.toHaveBeenCalled();
  });

  it('refuses a claimed tenant that is not the current membership tenant', async () => {
    const res = await f.invoke({ claims: { capiro_tenant_id: OTHER_TENANT } });
    expect(res.statusCode).toBe(403);
    expect(f.metrics).not.toHaveBeenCalled();
  });

  it.each([
    ['duplicate Host raw header', { rawHosts: [PREVIEW_HOST, 'ordinary.example'] }],
    ['a second Host spelling the roster origin', { rawHosts: [PREVIEW_HOST, ROSTER_HOST] }],
    ['an uppercase Host spelling', { host: PREVIEW_HOST.toUpperCase(), rawHosts: [PREVIEW_HOST.toUpperCase()] }],
    ['a Host with a port', { host: `${PREVIEW_HOST}:443`, rawHosts: [`${PREVIEW_HOST}:443`] }],
  ])('refuses %s on the reserved metrics read', async (_label, overrides) => {
    const res = await f.invoke(overrides);
    expect(res.statusCode).toBe(404);
    expect(f.metrics).not.toHaveBeenCalled();
  });

  it('refuses an ordinary Host while the preview flag is enabled (existing task contract)', async () => {
    const res = await f.invoke({ host: 'app.capiro.ai', rawHosts: ['app.capiro.ai'] });
    expect(res.statusCode).toBe(503);
    expect(f.metrics).not.toHaveBeenCalled();
  });

  it.each([
    ['a trailing slash', '/api/clients/metrics/'],
    ['uppercase spelling', '/api/clients/METRICS'],
    ['an extension near miss', '/api/clients/metrics-extra'],
    ['a nested continuation', '/api/clients/metrics/account-owners'],
    ['a percent-encoded spelling', '/api/clients/%6detRICS'],
    ['a dot-segment target', '/api/clients/metrics/../metrics'],
    ['a bounded query', '/api/clients/metrics?limit=1'],
    ['an unknown query', '/api/clients/metrics?includeArchived=true'],
  ])('holds the malformed metrics spelling and refuses %s', async (_label, target) => {
    const res = await f.invoke({ target });
    expect(res.statusCode).toBe(404);
    expect(f.metrics).not.toHaveBeenCalled();
  });

  it.each([['PUT'], ['DELETE']])('refuses the alternate %s method on the metrics target', async (method) => {
    const res = await f.invoke({ method });
    expect(res.statusCode).toBe(404);
    expect(f.metrics).not.toHaveBeenCalled();
  });
});
