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
import { ClientKbService } from '../embeddings/client-kb.service.js';
import { MeriController } from './meri.controller.js';
import { MeriPrivateSqlService } from './meri-private-sql.service.js';
import {
  PrivateSqlDbService,
  type PrivateSqlExecutionContext,
} from './analytics/private-sql-db.service.js';
import { MeriToolsService } from './meri-tools.service.js';
import { MeriService } from './meri.service.js';
import { MeriResearchService } from './meri-research.service.js';
import { MeriMcpService } from './meri-mcp.service.js';
import { MeriMcpOAuthService } from './meri-mcp-oauth.service.js';
import { MeriFirmSkillsService } from './meri-firm-skills.service.js';
import { MeriProcedureRuntimeValidationService } from './meri-procedure-runtime-validation.service.js';
import { MeriApprovalService } from './meri-approval.service.js';
import { MeriComplianceAuditService } from './meri-compliance-audit.service.js';
import { MeriClaimWriterService } from './meri-claim-writer.js';
import { ToolServiceSecretGuard } from './tool-service-secret.guard.js';

const id = (digit: string) => `20000000-0000-4000-8000-${digit.padStart(12, '0')}`;
const tenantId = id('1'),
  actorId = id('2'),
  clientId = id('3'),
  conversationId = id('4'),
  otherClient = id('5');
const secret = 'synthetic-private-query-service';
const query = {
  source: 'client_records',
  sql: 'SELECT COUNT(*) AS total FROM client_objectives',
  parameters: [],
};

/** Real controller, guards, middleware provenance and combined current owner. Only Clerk/driver I/O is synthetic.
 * Private SQL execution itself reuses the separate A/B native PostgreSQL acceptance. */
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
  const audit = jest.fn(async (_data: unknown) => ({}));
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
            findFirst: async () => (state.general ? { requestId: id('9') } : null),
          },
          client: {
            findMany: async ({ where }: any) =>
              state.roster
                .filter((r) => !where.id?.in || where.id.in.includes(r.id))
                .map((r) => ({ id: r.id })),
            findFirst: async ({ where }: any) =>
              state.roster.some((r) => r.id === where.id) ? { ...client, id: where.id } : null,
          },
          meriAnalyticsQueryLog: { create: audit },
        }),
    }),
    withSystem: PrismaService.prototype.withSystem,
    withTenant: PrismaService.prototype.withTenant,
  };
  let during = async () => {};
  const count = (total: string) => ({ columns: [{ name: 'total', type: 'integer' as const, pgType: 'int8', nullable: true }], rows: [{ total }], surface: [] });
  const db = {
    runPrivateSql: jest.fn(async (_gated: unknown, c: PrivateSqlExecutionContext) => {
      await c.assertCurrent();
      await during();
      await c.assertCurrent();
      return count('2');
    }),
    describe: jest.fn(async (c: PrivateSqlExecutionContext) => {
      await c.assertCurrent();
      await during();
      await c.assertCurrent();
      return [];
    }),
  };
  const publicDb = { runPublicSql: jest.fn(async () => count('3')) };
  const tools = Object.assign(Object.create(MeriToolsService.prototype), {
    prisma,
    analyticsDb: publicDb,
  });
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [
          () => ({ INTERNAL_SERVICE_SECRET: secret, MERI_TOOLS_REQUIRE_SERVICE_SECRET: true }),
        ],
      }),
      ApplicationAuthorityModule,
    ],
    controllers: [MeriController],
    providers: [
      MeriPrivateSqlService,
      ToolServiceSecretGuard,
      { provide: PrivateSqlDbService, useValue: db },
      { provide: MeriToolsService, useValue: tools },
      ...[
        MeriService,
        MeriResearchService,
        ClientKbService,
        MeriMcpService,
        MeriMcpOAuthService,
        MeriFirmSkillsService,
        MeriProcedureRuntimeValidationService,
        MeriApprovalService,
        MeriComplianceAuditService,
        MeriClaimWriterService,
      ].map((provide) => ({ provide, useValue: {} })),
    ],
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
    const operation = options.operation ?? 'query_capiro_data',
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
      if (body.source === 'client_records') {
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
            capiroDataScope: {
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
        (entry: any) => entry.route?.path === '/api/clio/tools/:name',
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
    db,
    publicDb,
    audit,
    row,
    membership,
    state,
    session,
    selections,
    setDuring(fn: () => Promise<void>) {
      during = fn;
    },
  };
}

describe('private SQL actual interactive HTTP authority', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    f = await fixture();
  });
  afterEach(async () => {
    await f?.app.close();
  });
  it('serves General aggregate and narrowed rows while keeping canonical conversation scope null', async () => {
    const general = await f.send();
    expect(general.statusCode).toBe(200);
    expect(general.body).toMatchObject({
      ok: true,
      scope: { kind: 'client_records', clientId: null },
      rows: [{ total: '2' }],
    });
    const narrow = await f.send({ ...query, clientId });
    expect(narrow.statusCode).toBe(200);
    expect(narrow.body.scope.clientId).toBe(clientId);
    expect(f.selections.every((s) => s.clientId === null)).toBe(true);
    expect(f.db.runPrivateSql.mock.calls[1]![1].clientId).toBe(clientId);
  });
  it('serves selected-client describe and refuses another client before the SQL port', async () => {
    f.row.clientId = clientId;
    const describe = await f.send(
      { source: 'client_records' },
      { operation: 'describe_capiro_data' },
    );
    expect(describe.statusCode).toBe(200);
    expect(describe.body.scope.clientId).toBe(clientId);
    const denied = await f.send({ ...query, clientId: otherClient });
    expect(denied.statusCode).toBe(403);
    expect(f.db.runPrivateSql).not.toHaveBeenCalled();
  });
  it.each(['unowned', 'archived', 'no-bootstrap', 'inactive-member'] as const)(
    'canonical owner refuses %s before SQL',
    async (kind) => {
      if (kind === 'unowned') f.row.userId = id('99');
      if (kind === 'archived') f.row.archivedAt = new Date();
      if (kind === 'no-bootstrap') f.state.general = false;
      if (kind === 'inactive-member') f.membership.status = 'inactive';
      const result = await f.send();
      expect(result.statusCode).toBeGreaterThanOrEqual(400);
      expect(f.db.runPrivateSql).not.toHaveBeenCalled();
    },
  );
  it.each(['identity', 'roster', 'conversation'] as const)(
    'late %s change withholds current aggregate bytes',
    async (kind) => {
      f.setDuring(async () => {
        if (kind === 'identity') f.session.createdAt = 2;
        if (kind === 'roster') f.state.roster.pop();
        if (kind === 'conversation') f.row.status = 'completed';
      });
      const result = await f.send();
      expect([403, 409]).toContain(result.statusCode);
      expect(result.body.rows).toBeUndefined();
      expect(f.db.runPrivateSql).toHaveBeenCalledTimes(1);
    },
  );
  it('refuses missing service/correlation, cloned request provenance and forged principal', async () => {
    for (const options of [
      { secret: 'wrong' },
      { missingCorrelation: true },
      { unbound: true },
      {
        afterAuth: (_req: any, context: any) => {
          context.binding.actorId = id('99');
        },
      },
    ]) {
      const result = await f.send(query, options);
      expect(result.statusCode).toBe(403);
    }
    expect(f.db.runPrivateSql).not.toHaveBeenCalled();
  });
  it('does not admit a sidless control credential on the tool route', async () => {
    f.state.control = true;
    const result = await f.send();
    expect(result.statusCode).toBe(401);
    expect(f.db.runPrivateSql).not.toHaveBeenCalled();
  });
  it('keeps public requests on the existing actual tools/compiler path', async () => {
    const publicQuery = { sql: 'SELECT COUNT(*) AS total FROM program_elements', parameters: [] };
    for (const body of [publicQuery, { ...publicQuery, source: 'public' }]) {
      const result = await f.send(body);
      expect(result.statusCode).toBe(200);
      expect(result.body).toMatchObject({ version: '0.2.0', ok: true, rows: [{ total: '3' }] });
    }
    expect(f.db.runPrivateSql).not.toHaveBeenCalled();
    expect(f.publicDb.runPublicSql).toHaveBeenCalledTimes(2);
  });
});
