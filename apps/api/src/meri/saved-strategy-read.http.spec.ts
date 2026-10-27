import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
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
import { SavedStrategyReadController } from './saved-strategy-read.controller.js';
import { SavedStrategyReadService } from './saved-strategy-read.service.js';

const id = (digit: string) => `20000000-0000-4000-8000-${digit.padStart(12, '0')}`;
const tenantId = id('1'),
  actorId = id('2'),
  clientId = id('3'),
  conversationId = id('4'),
  otherClient = id('5'),
  strategyId = id('10');
const secret = 'synthetic-strategy-read-service';
const query = { kind: 'strategy_versions', clientId, strategyId };
function ownerPage() {
  const record = {
    id: id('20'),
    strategyId,
    snapshot: { nodes: [{ body: 'å®Œæ•´ saved Strategy', value: null }] },
    authorKind: 'person',
    authorUserId: actorId,
    note: null,
    restoredFromVersionId: null,
    coalescible: false,
    createdAt: '2026-10-27T00:00:00.000Z',
  };
  return {
    version: '0.1.0',
    kind: 'strategy_versions',
    clientId,
    observedAt: '2026-10-27T00:00:00.000Z',
    items: [
      {
        source: {
          relation: 'sp_version',
          id: record.id,
          contentSha256: createHash('sha256').update(JSON.stringify(record)).digest('hex'),
        },
        record,
      },
    ],
    nextCursor: null,
    coverage: {
      scope: 'selected_client',
      sourceUniverseComplete: false,
      representation: 'owner_records',
      rowLimit: 100,
      maxOutputBytes: 262144,
      byteTruncated: false,
      limitations: [
        'Pages are current reads, not a frozen cross-page snapshot.',
        'Coalescible versions may change; source identity includes the returned content hash.',
      ],
    },
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
    expect(String(url)).toBe('http://strategy.synthetic/strategy-api/saved-reads');
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: 'Bearer synthetic',
        accept: 'application/json',
        'content-type': 'application/json',
      },
    });
    expect(Object.keys(init!.headers!)).toEqual(['authorization', 'accept', 'content-type']);
    expect(JSON.parse(init!.body as string).clientId).toBe(clientId);
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
            STRATEGY_API_BASE_URL: 'http://strategy.synthetic',
          }),
        ],
      }),
      ApplicationAuthorityModule,
    ],
    controllers: [SavedStrategyReadController],
    providers: [SavedStrategyReadService, ToolServiceSecretGuard],
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
    const operation = options.operation ?? 'read_saved_strategy_records',
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
            strategySavedScope: {
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
        (entry: any) => entry.route?.path === '/api/clio/tools/read_saved_strategy_records',
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

describe('saved Strategy native Core bridge', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    f = await fixture();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await f?.app.close();
  });
  it('keeps actual General conversation scope null while narrowing and preserving exact full saved content', async () => {
    const response = await f.send();
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual(ownerPage());
    expect(f.selections.every((s) => s.clientId === null)).toBe(true);
    const last = f.selections.at(-1);
    expect(Object.keys(last.expect).sort()).toEqual([
      'contextRevision',
      'identityRevision',
      'membershipRevision',
    ]);
    expect(f.fetchSpy).toHaveBeenCalledTimes(1);
  });
  it('admits the selected client but refuses another client before transport', async () => {
    f.row.clientId = clientId;
    expect((await f.send()).statusCode).toBe(200);
    f.fetchSpy.mockClear();
    expect((await f.send({ ...query, clientId: otherClient })).statusCode).toBe(403);
    expect(f.fetchSpy).not.toHaveBeenCalled();
  });
  it.each(['membership', 'context', 'identity'])(
    'refuses changed %s after the owner response',
    async (reason) => {
      f.setDuring(async () => {
        if (reason === 'membership') f.state.roster[0]!.revision = '9'.repeat(32);
        if (reason === 'context') f.state.generalRevision = id('90');
        if (reason === 'identity') f.membership.role = 'user_admin';
      });
      const response = await f.send();
      expect(response.statusCode).toBe(reason === 'identity' ? 403 : 409);
      expect(response.body).not.toHaveProperty('items');
      expect(f.fetchSpy).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    'missing-correlation',
    'service',
    'saved-job',
    'impersonation',
    'expired',
    'scope-revision',
  ])('refuses %s before transport', async (reason) => {
    const response = await f.send(query, {
      missingCorrelation: reason === 'missing-correlation',
      secret: reason === 'service' ? 'wrong' : secret,
      afterAuth: (req, c) => {
        if (reason === 'saved-job') c.binding.conversationId = id('99');
        if (reason === 'impersonation') req.headers['x-capiro-impersonate-tenant'] = 'other-org';
        if (reason === 'expired') req.headers['x-meri-deadline-at'] = String(Date.now() - 1);
        if (reason === 'scope-revision')
          c.normalizationContext.strategySavedScope.identityRevision = '0'.repeat(64);
      },
    });
    expect(response.statusCode).toBe(reason === 'expired' ? 500 : 403);
    expect(response.body).not.toHaveProperty('items');
    expect(f.fetchSpy).not.toHaveBeenCalled();
  });
  it.each(['client', 'parent', 'digest', 'relation', 'cursor'])(
    'refuses mismatched %s in saved owner response',
    async (reason) => {
      const page: any = ownerPage();
      if (reason === 'client') page.clientId = otherClient;
      if (reason === 'parent') {
        page.items[0].record.strategyId = id('99');
        page.items[0].source.contentSha256 = createHash('sha256')
          .update(JSON.stringify(page.items[0].record))
          .digest('hex');
      }
      if (reason === 'digest') page.items[0].record.snapshot.nodes[0].body = 'changed';
      if (reason === 'relation') page.items[0].source.relation = 'client_objective_revisions';
      if (reason === 'cursor') page.nextCursor = 'unbound';
      f.setPage(page);
      const response = await f.send();
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toHaveProperty('items');
    },
  );
  it('bounds multibyte response bytes even when declared length is small', async () => {
    f.setOutput(
      new Response(JSON.stringify({ body: 'ç•Œ'.repeat(90000) }), {
        headers: { 'content-type': 'application/json', 'content-length': '2' },
      }),
    );
    expect((await f.send()).statusCode).toBe(413);
    expect(f.fetchSpy).toHaveBeenCalledTimes(1);
  });
  it('preserves a bound continuation and does not replace full saved snapshot with a summary', async () => {
    const page: any = ownerPage();
    page.nextCursor = Buffer.from(
      JSON.stringify({
        binding: ['strategy_versions', clientId, null, null, strategyId, null, null, false],
        after: page.items[0].source.id,
      }),
    ).toString('base64url');
    page.coverage.byteTruncated = true;
    f.setPage(page);
    expect((await f.send()).body).toEqual(page);
  });
  it('propagates cancellation without returning saved content or retrying the owner', async () => {
    f.setDuring(async (init) => {
      expect(init!.signal).toBeDefined();
    });
    const response = await f.send(query, {
      afterAuth: (req) => {
        f.setDuring(async (init) => {
          req.emit('aborted');
          expect(init!.signal!.aborted).toBe(true);
        });
      },
    });
    expect(response.statusCode).not.toBe(200);
    expect(response.body).not.toHaveProperty('items');
    expect(f.fetchSpy).toHaveBeenCalledTimes(1);
  });
  it('retains owner denial without leaking response body or retrying', async () => {
    f.setOutput(new Response('private owner details', { status: 403 }));
    const response = await f.send();
    expect(response.statusCode).toBe(403);
    expect(JSON.stringify(response.body)).not.toContain('private owner details');
    expect(f.fetchSpy).toHaveBeenCalledTimes(1);
  });
  it('rejects model supplied destination or authority fields before transport', async () => {
    expect((await f.send({ ...query, url: 'http://other.synthetic', tenantId })).statusCode).toBe(
      400,
    );
    expect(f.fetchSpy).not.toHaveBeenCalled();
  });
});
