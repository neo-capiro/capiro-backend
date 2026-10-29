import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ApplicationAuthorityModule } from '../auth/application-authority.module.js';
import { ApplicationCurrentService } from '../auth/application-current.service.js';
import { ClerkService } from '../auth/clerk.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantContextMiddleware } from '../tenant/tenant-context.middleware.js';
import { TenantContextStore } from '../tenant/tenant-context.store.js';
import { ToolServiceSecretGuard } from './tool-service-secret.guard.js';
import { LegiwatchActionController } from './legiwatch-action.controller.js';
import { LegiwatchActionService } from './legiwatch-action.service.js';

import { MeriActionProposalService } from './meri-action-proposal.service.js';
// Current/middleware/controller remain real. The ledger is exercised separately
// in meri-action-proposal.service.spec.ts; this route fixture observes its calls.
jest.mock('./meri-action-proposal.service.js', () => ({ MeriActionProposalService: class {} }));
const id = (digit: string) => `20000000-0000-4000-8000-${digit.padStart(12, '0')}`;
const tenantId = id('1'),
  actorId = id('2'),
  clientId = id('3'),
  conversationId = id('4'),
  otherClient = id('5'),
  strategyId = id('10');
const secret = 'synthetic-strategy-read-service';
const query = {
  version: 1,
  context: { conversationId, selectedClientId: null },
  request: {
    clientId,
    folderId: id('11'),
    jurisdiction: 'US',
    sessionKey: '119',
    suggestionId: id('12'),
    expectedVersion: 1,
    action: 'add',
    requestKey: 'synthetic-operation',
  },
};
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
  let during = async () => {};
  const proposals = {
    create: jest.fn(async (_ctx, request, _turn, access) => {
      await access.assertCurrent();
      await during();
      return { disposition: 'pending_approval', proposal: { proposalId: id('20') } };
    }),
    readLegiwatch: jest.fn(async (_ctx, proposalId, access) => {
      await access.assertCurrent();
      return {
        version: '0.1.0',
        proposalId,
        status: 'proposed',
        context: access.scope,
        request: query.request,
        receipt: null,
      };
    }),
    approveAndExecute: jest.fn(async (_ctx, _id, access) => {
      await access.assertCurrent();
    }),
    dismiss: jest.fn(),
  };
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [
          () => ({
            INTERNAL_SERVICE_SECRET: secret,
            MERI_TOOLS_REQUIRE_SERVICE_SECRET: true,
          }),
        ],
      }),
      ApplicationAuthorityModule,
    ],
    controllers: [LegiwatchActionController],
    providers: [
      LegiwatchActionService,
      ToolServiceSecretGuard,
      { provide: MeriActionProposalService, useValue: proposals },
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
      afterAuth?: (req: any) => void;
    } = {},
  ) {
    const operation = options.operation ?? 'prepare',
      url = `/api/clio/tools/${({ prepare: 'prepare_legiwatch_suggestion', read: 'read_legiwatch_suggestion_proposal', decide: 'decide_legiwatch_suggestion' } as Record<string, string>)[operation]}`;
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
      options.afterAuth?.(req);
      const layer = router.stack.find((entry: any) => entry.route?.path === url);
      expect(layer).toBeDefined();
      await layer.route.stack[0].handle(req, response, () => {});
    } catch (error: any) {
      response
        .status(error.getStatus?.() ?? 500)
        .json(error.getResponse?.() ?? { message: error.message });
    }
    return { status: response.statusCode, body: response.body };
  }
  return {
    send,
    state,
    row,
    membership,
    proposals,
    selections,
    close: () => app.close(),
    during(fn: () => Promise<void>) {
      during = fn;
    },
  };
}

afterEach(() => jest.restoreAllMocks());
test('mounted prepare uses actual current General owner, then only the approval ledger', async () => {
  const f = await fixture();
  try {
    const r = await f.send();
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('proposed');
    expect(f.proposals.create).toHaveBeenCalledTimes(1);
    expect(f.proposals.create.mock.calls[0]![1]).toMatchObject({
      tool: 'apply_legiwatch_suggestion',
      requireApproval: true,
      conversationId,
    });
    expect(f.selections.every((s) => s.clientId === null)).toBe(true);
    expect(f.proposals.approveAndExecute).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
test('mounted selected client refuses different target and foreign conversation', async () => {
  const f = await fixture();
  try {
    f.row.clientId = clientId;
    expect(
      (await f.send({ ...query, context: { conversationId, selectedClientId: clientId } })).status,
    ).toBe(200);
    expect(
      (
        await f.send({
          ...query,
          context: { conversationId, selectedClientId: clientId },
          request: { ...query.request, clientId: otherClient },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.send({
          ...query,
          context: { conversationId: id('99'), selectedClientId: clientId },
        })
      ).status,
    ).toBe(403);
    expect(f.proposals.create).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});
test.each(['secret', 'impersonation', 'control', 'no_general', 'expired'])(
  'mounted %s refuses before proposal creation',
  async (mode) => {
    const f = await fixture();
    try {
      if (mode === 'control') f.state.control = true;
      if (mode === 'no_general') f.state.general = false;
      const r = await f.send(query, {
        ...(mode === 'secret' ? { secret: 'wrong' } : {}),
        afterAuth(req) {
          if (mode === 'impersonation') req.headers['x-capiro-impersonate-tenant'] = id('99');
          if (mode === 'expired') req.headers['x-meri-deadline-at'] = '1';
        },
      });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(f.proposals.create).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);
test.each(['identity', 'membership', 'context'])(
  'current %s changes withhold the created proposal',
  async (mode) => {
    const f = await fixture();
    try {
      f.during(async () => {
        if (mode === 'identity') f.membership.role = 'user_admin';
        if (mode === 'membership') f.state.roster.pop();
        if (mode === 'context') f.state.generalRevision = id('90');
      });
      const r = await f.send();
      expect([403, 409]).toContain(r.status);
      expect(f.proposals.create).toHaveBeenCalledTimes(1);
      expect(f.proposals.readLegiwatch).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);
test('read/decision use exact stored current revisions; changed authority makes no decision', async () => {
  const f = await fixture();
  try {
    const p = await f.send();
    const body = { version: 1, proposalId: p.body.proposalId, context: p.body.context };
    expect((await f.send(body, { operation: 'read' })).status).toBe(200);
    f.state.roster.pop();
    expect((await f.send({ ...body, decision: 'approved' }, { operation: 'decide' })).status).toBe(
      409,
    );
    expect(f.proposals.approveAndExecute).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
