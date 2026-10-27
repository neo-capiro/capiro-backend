import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import { ApplicationAuthorityModule } from '../auth/application-authority.module.js';
import { ApplicationCurrentService } from '../auth/application-current.service.js';
import { ClerkService } from '../auth/clerk.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantContextMiddleware } from '../tenant/tenant-context.middleware.js';
import { TenantContextStore } from '../tenant/tenant-context.store.js';
import { ToolServiceSecretGuard } from './tool-service-secret.guard.js';
import { LegiwatchReviewController } from './legiwatch-review.controller.js';
import { LegiwatchReviewService } from './legiwatch-review.service.js';

const id = (digit: string) => `20000000-0000-4000-8000-${digit.padStart(12, '0')}`;
const tenantId = id('1'),
  actorId = id('2'),
  clientId = id('3'),
  conversationId = id('4'),
  otherClient = id('5');
const secret = 'synthetic-strategy-read-service';
const query = {
  view: 'suggestions',
  clientId,
  folderId: id('11'),
  jurisdiction: 'US',
  sessionKey: '119',
};
function ownerPage() {
  return {
    rows: [
      {
        id: id('20'),
        tenant_id: tenantId,
        owner_clerk_id: 'user_private_query',
        rule_id: id('21'),
        rule_version: 2,
        run_id: id('22'),
        folder_id: query.folderId,
        bill_id: 'hr-1-119',
        fingerprint: 'source-fingerprint',
        version: 3,
        state: 'pending',
        decision_id: null,
        payload: {
          bill: { id: 'hr-1-119', title: 'Complete source — 界', optional: null },
          sourceFingerprint: 'source-fingerprint',
          folderVersion: 2,
          stateVersion: 0,
          coverage: { complete: false, inspectedDocuments: 1, missing: ['bill_text'] },
          matches: [
            {
              document: {
                id: 'title:hr-1-119',
                kind: 'title',
                revision: 'r1',
                observationId: 'o1',
                sourceUrl: 'https://congress.gov/bill/119/house-bill/1',
              },
              evaluation: { outcome: 'match', results: [] },
            },
          ],
          sourceScope: { jurisdiction: 'US', sessionKey: '119', fields: ['title'] },
          origin: 'deterministic',
        },
      },
    ],
    next: null,
  };
}

/** Actual middleware/current owner and route guards, synthetic Clerk/DB and downstream HTTP only. */
async function fixture() {
  const user = { id: actorId, clerkUserId: 'user_private_query' };
  const tenant = {
    id: tenantId,
    slug: 'fixture',
    status: 'active',
    clerkOrgId: 'org_private_query',
    settings: {},
  };
  const membership = {
    id: 'membership-private',
    tenantId,
    userId: actorId,
    status: 'active',
    role: 'standard_user',
    tenant,
    updatedAt: new Date(2),
    lastSeenAt: new Date(3),
  };
  const row: any = {
    id: conversationId,
    tenantId,
    userId: actorId,
    clientId: null,
    status: 'active',
    archivedAt: null,
    metadata: {},
  };
  const client = {
    id: clientId,
    tenantId,
    status: 'active',
    memoryWall: false,
    memoryAccessGrants: [],
  };
  const state = {
    roster: [
      { id: clientId, revision: '1'.repeat(32) },
      { id: otherClient, revision: '2'.repeat(32) },
    ],
    general: true,
    generalRevision: id('9'),
    control: false,
    session: true,
  };
  const session = {
    id: 'sess_private_query',
    userId: user.clerkUserId,
    status: 'active',
    createdAt: 1,
    expireAt: Date.now() + 600_000,
    abandonAt: Date.now() + 500_000,
    expiresAtMs: Date.now() + 300_000,
    actor: null,
  };
  const clerk = {
    verifySessionToken: async () => ({
      sub: user.clerkUserId,
      iss: 'https://clerk.app.capiro.ai',
      exp: Math.floor(Date.now() / 1000) + 300,
      ...(state.control
        ? {
            meri_control_credential: true,
            jti: 'private_control',
            iat: Math.floor(Date.now() / 1000),
          }
        : { sid: session.id }),
      capiro_tenant_id: tenantId,
      capiro_tenant_slug: 'fixture',
      org_id: tenant.clerkOrgId,
    }),
    assertActiveApplicationAuthoritySession: async () => (state.session ? session : null),
    assertActiveMeriControlCredentialSession: async () => session,
  };

  const prisma: any = {
    scopedClient: () => ({
      $transaction: async (fn: any) =>
        fn({
          $executeRaw: async () => 0,
          $queryRaw: async () => state.roster.map((r) => ({ ...r })),
          user: {
            findUnique: async () => user,
            findFirst: async () => user,
            update: async () => user,
          },
          tenant: { findUnique: async () => tenant },
          tenantMembership: {
            findMany: async () => [membership],
            findFirst: async () => membership,
          },
          clioConversation: {
            findFirst: async ({ where }: any) =>
              Object.entries(where).every(([key, value]) => row[key] === value) ? { ...row } : null,
          },
          clioConversationBootstrapReceipt: {
            findFirst: async () => (state.general ? { requestId: state.generalRevision } : null),
          },
          client: {
            findMany: async ({ where }: any) =>
              state.roster
                .filter((r) => !where.id?.in || where.id.in.includes(r.id))
                .map((r) => ({ id: r.id })),
            findFirst: async ({ where }: any) =>
              state.roster.some((r) => r.id === where.id) ? { ...client, id: where.id } : null,
          },
        }),
    }),
    withSystem: PrismaService.prototype.withSystem,
    withTenant: PrismaService.prototype.withTenant,
  };
  let during = async (_init?: RequestInit) => {};
  let page: unknown = ownerPage();
  let output: Response | null = null;
  const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(String(url)).toBe('http://intel.synthetic/intel-api/internal/legiwatch/meri/read');
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        'x-internal-service-secret': secret,
        accept: 'application/json',
        'content-type': 'application/json',
      },
    });
    expect(Object.keys(init!.headers!).sort()).toEqual([
      'accept',
      'content-type',
      'x-internal-service-secret',
    ]);
    expect(JSON.parse(init!.body as string)).toMatchObject({
      tenantId,
      actor: 'user_private_query',
      tool: 'get_legiwatch_review',
    });
    await during(init);
    return (
      output ??
      new Response(JSON.stringify(page), { headers: { 'content-type': 'application/json' } })
    );
  });
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [
          () => ({
            INTERNAL_SERVICE_SECRET: secret,
            MERI_TOOLS_REQUIRE_SERVICE_SECRET: true,
            TRACKER_APP_BASE_URL: 'http://intel.synthetic',
          }),
        ],
      }),
      ApplicationAuthorityModule,
    ],
    controllers: [LegiwatchReviewController],
    providers: [LegiwatchReviewService, ToolServiceSecretGuard],
  })
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .overrideProvider(ClerkService)
    .useValue(clerk)
    .compile();
  const app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  await app.init();
  const middleware = new TenantContextMiddleware(
    clerk as any,
    prisma,
    module.get(TenantContextStore),
  );
  const current = module.get(ApplicationCurrentService),
    router = app.getHttpAdapter().getInstance()._router;
  const selections: any[] = [];
  const actual = current.read.bind(current);
  jest.spyOn(current, 'read').mockImplementation(async (ctx, req, selection) => {
    selections.push(selection);
    return actual(ctx, req, selection);
  });
  async function send(
    body: any = query,
    options: {
      operation?: string;
      secret?: string;
      scheme?: string;
      missingCorrelation?: boolean;
      unbound?: boolean;
      afterAuth?: (req: any, correlation: any) => void;
    } = {},
  ) {
    const operation = options.operation ?? 'get_legiwatch_review',
      url = `/api/clio/tools/${operation}`;
    const headers: any = {
      authorization: `${options.scheme ?? 'Bearer'} synthetic`,
      'x-internal-service-secret': options.secret ?? secret,
      'x-meri-deadline-at': String(Date.now() + 20_000),
    };
    const req: any = Object.assign(new EventEmitter(), {
      method: 'POST',
      path: url,
      originalUrl: url,
      url,
      headers,
      body,
      hostname: 'localhost',
      params: { name: operation },
      query: {},
      header: (name: string) => headers[name],
    });
    const response: any = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headersSent: false,
      headers: {} as Record<string, string>,
      body: undefined as unknown,
      writableEnded: false,
      destroyed: false,
      setHeader(key: string, value: string) {
        this.headers[key.toLowerCase()] = value;
        return this;
      },
      set(key: string, value: string) {
        return this.setHeader(key, value);
      },
      getHeader(key: string) {
        return this.headers[key.toLowerCase()];
      },
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      send(value: unknown) {
        this.body = value;
        this.headersSent = true;
        this.writableEnded = true;
        return this;
      },
      json(value: unknown) {
        return this.send(value);
      },
      end() {
        this.headersSent = true;
        this.writableEnded = true;
        return this;
      },
    });
    req.res = response;
    try {
      await middleware.use(req, response, () => {});
      {
        const receipt = await current.read(req.tenantContext, req, {
          conversationId,
          clientId: row.clientId,
        });
        const correlation = {
          binding: {
            tenantId,
            actorId,
            conversationId,
            runId: id('6'),
            attemptId: id('7'),
            workerId: id('8'),
            writerFence: 1,
          },
          subject: {
            kind: row.clientId ? 'client' : 'personal',
            entityType: row.clientId ? 'client' : 'user',
            entityIds: [row.clientId ?? actorId],
            tenantId,
            actorId,
            policyRevision: 'policy',
            scopes: [
              {
                tenantId,
                kind: row.clientId ? 'client' : 'private-user',
                resourceId: row.clientId ?? actorId,
                policyRevision: 'policy',
              },
            ],
            rosterVersionId: null,
          },
          policyRevision: 'policy',
          normalizationContext: {
            legiwatchReviewScope: {
              clientId: body.clientId ?? row.clientId,
              identityRevision: receipt.identityRevision,
              membershipRevision: receipt.membershipRevision,
            },
          },
        };
        options.afterAuth?.(req, correlation);
        if (!options.missingCorrelation)
          headers['x-meri-read-correlation'] = Buffer.from(
            canonicalizeCoreRetainedJson(correlation),
          ).toString('base64url');
      }
      const dispatch = options.unbound ? Object.assign(new EventEmitter(), req) : req;
      const layer = router.stack.find(
        (entry: any) => entry.route?.path === '/api/clio/tools/get_legiwatch_review',
      );
      expect(layer).toBeDefined();
      await layer.route.stack[0].handle(dispatch, response, () => {});
    } catch (error: any) {
      response
        .status(error.getStatus?.() ?? 500)
        .json(error.getResponse?.() ?? { message: error.message });
    }
    return response;
  }
  return {
    app,
    send,
    row,
    membership,
    state,
    selections,
    fetchSpy,
    setDuring(fn: typeof during) {
      during = fn;
    },
    setPage(value: unknown) {
      page = value;
    },
    setOutput(value: Response) {
      output = value;
    },
  };
}

describe('current-bound LegiWatch review', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    f = await fixture();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await f?.app.close();
  });
  it('reads exact suggestion evidence/versions through actual General authority and fixed Intel read only', async () => {
    const r = await f.send();
    expect(r.statusCode).toBe(200);
    expect(r.body.selection).toEqual(query);
    expect(r.body.data.rows[0]).toMatchObject({
      id: id('20'),
      version: 3,
      payload: ownerPage().rows[0]!.payload,
    });
    expect(r.body.data.rows[0]).not.toHaveProperty('tenant_id');
    expect(r.body.data.rows[0]).not.toHaveProperty('owner_clerk_id');
    expect(r.body.coverage.sourceUniverseComplete).toBe(false);
    expect(r.body.effects).toEqual([]);
    expect(f.selections.every((s) => s.clientId === null)).toBe(true);
    expect(Object.keys(f.selections.at(-1).expect).sort()).toEqual([
      'contextRevision',
      'identityRevision',
      'membershipRevision',
    ]);
    expect(f.fetchSpy).toHaveBeenCalledTimes(1);
  });
  it('admits selected client and refuses foreign client before transport', async () => {
    f.row.clientId = clientId;
    expect((await f.send()).statusCode).toBe(200);
    f.fetchSpy.mockClear();
    expect((await f.send({ ...query, clientId: otherClient })).statusCode).toBe(403);
    expect(f.fetchSpy).not.toHaveBeenCalled();
  });
  it.each(['membership', 'context', 'identity'])('withholds after changed %s', async (reason) => {
    f.setDuring(async () => {
      if (reason === 'membership') f.state.roster[0]!.revision = '9'.repeat(32);
      if (reason === 'context') f.state.generalRevision = id('90');
      if (reason === 'identity') f.membership.role = 'user_admin';
    });
    const r = await f.send();
    expect(r.statusCode).toBe(reason === 'identity' ? 403 : 409);
    expect(r.body).not.toHaveProperty('data');
    expect(f.fetchSpy).toHaveBeenCalledTimes(1);
  });
  it.each([
    'missing-correlation',
    'service',
    'saved-job',
    'impersonation',
    'expired',
    'scope-revision',
  ])('refuses %s before transport', async (reason) => {
    const r = await f.send(query, {
      missingCorrelation: reason === 'missing-correlation',
      secret: reason === 'service' ? 'wrong' : secret,
      afterAuth: (req, c) => {
        if (reason === 'saved-job') c.binding.conversationId = id('99');
        if (reason === 'impersonation') req.headers['x-capiro-impersonate-tenant'] = 'other';
        if (reason === 'expired') req.headers['x-meri-deadline-at'] = String(Date.now() - 1);
        if (reason === 'scope-revision')
          c.normalizationContext.legiwatchReviewScope.identityRevision = '0'.repeat(64);
      },
    });
    expect(r.statusCode).toBe(reason === 'expired' ? 500 : 403);
    expect(r.body).not.toHaveProperty('data');
    expect(f.fetchSpy).not.toHaveBeenCalled();
  });
  it.each(['tenant', 'actor', 'folder', 'session', 'cursor'])(
    'refuses mismatched owner %s',
    async (reason) => {
      const p: any = ownerPage();
      if (reason === 'tenant') p.rows[0].tenant_id = otherClient;
      if (reason === 'actor') p.rows[0].owner_clerk_id = 'foreign';
      if (reason === 'folder') p.rows[0].folder_id = id('99');
      if (reason === 'session') p.rows[0].payload.sourceScope.sessionKey = '118';
      if (reason === 'cursor') p.next = 'unbound';
      f.setPage(p);
      expect((await f.send()).statusCode).toBe(503);
    },
  );
  it('rejects UTF8 response oversize before JSON even with a false content-length', async () => {
    f.setOutput(
      new Response(JSON.stringify({ body: '界'.repeat(90000) }), {
        headers: { 'content-type': 'application/json', 'content-length': '2' },
      }),
    );
    expect((await f.send()).statusCode).toBe(413);
  });
  it('cancels without release or retry', async () => {
    const r = await f.send(query, {
      afterAuth: (req) =>
        f.setDuring(async (init) => {
          req.emit('aborted');
          expect(init!.signal!.aborted).toBe(true);
        }),
    });
    expect(r.statusCode).not.toBe(200);
    expect(r.body).not.toHaveProperty('data');
    expect(f.fetchSpy).toHaveBeenCalledTimes(1);
  });
  it('keeps denial distinct from empty results, without leaking owner errors', async () => {
    f.setOutput(new Response('private details', { status: 403 }));
    const r = await f.send();
    expect(r.statusCode).toBe(403);
    expect(JSON.stringify(r.body)).not.toContain('private details');
    expect(f.fetchSpy).toHaveBeenCalledTimes(1);
  });
  it('rejects authority/destination injection before transport', async () => {
    expect((await f.send({ ...query, url: 'http://other.synthetic', tenantId })).statusCode).toBe(
      400,
    );
    expect(f.fetchSpy).not.toHaveBeenCalled();
  });
});
