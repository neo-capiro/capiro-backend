import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ApplicationAuthorityModule } from '../auth/application-authority.module.js';
import { ClerkService } from '../auth/clerk.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantContextMiddleware } from '../tenant/tenant-context.middleware.js';
import { TenantContextStore } from '../tenant/tenant-context.store.js';
import { ToolServiceSecretGuard } from './tool-service-secret.guard.js';
import { BizdevActionController } from './bizdev-action.controller.js';
import { BizdevActionService } from './bizdev-action.service.js';
import {
  BRIEF_SECTION_KEYS,
  type BriefSectionKey,
} from '../business-development/bizdev-brief.types.js';
import {
  BizDevMeriScopeService,
  computeMeriProspectScopeVersion,
} from '../business-development/bizdev-meri-scope.service.js';

import { MeriActionProposalService } from './meri-action-proposal.service.js';
import {
  bizdevBriefReceipt,
  bizdevInput,
  classifyBizdevBriefFailure,
} from './bizdev-action.contract.js';
// Current/middleware/controller and the real prospect-scope owner remain real.
// The ledger is exercised separately in meri-action-proposal.service.spec.ts;
// this route fixture observes its calls.
jest.mock('./meri-action-proposal.service.js', () => ({ MeriActionProposalService: class {} }));
const id = (digit: string) => `20000000-0000-4000-8000-${digit.padStart(12, '0')}`;
const tenantId = id('1'),
  actorId = id('2'),
  conversationId = id('4'),
  prospectId = id('7'),
  linkedClientId = id('3'),
  briefId = id('30'),
  versionId = id('31');
const secret = 'synthetic-bizdev-brief-service';
const NOW = 1800000000000;
const sections = Object.fromEntries(
  BRIEF_SECTION_KEYS.map((key) => [key, { text: `${key} text`, citationIndexes: [0, 1] }]),
) as Record<BriefSectionKey, { text: string; citationIndexes: number[] }>;
const request = {
  conversationId,
  expectedVersionNumber: 2,
  title: 'Updated brief',
  sections,
  requestKey: 'synthetic-bizdev-brief-operation',
};
const query = { version: 1, context: { conversationId }, request };
const scopeFor = (linked: string | null) => ({
  prospectId,
  prospectName: 'Synthetic Prospect',
  canonicalOrganizationId: null,
  linkedClientId: linked,
  scopeVersion: computeMeriProspectScopeVersion({
    prospectId,
    canonicalOrganizationId: null,
    linkedClientId: linked,
  }),
});
async function fixture() {
  const user = { id: actorId, clerkUserId: 'user_private_query' };
  const tenant = {
    id: tenantId,
    slug: 'fixture',
    status: 'active',
    clerkOrgId: 'org_private_query',
    settings: {
      clioFeatureFlags: {
        'businessDevelopment.enabled': true,
        'businessDevelopment.meriProspectTools.enabled': true,
      },
    },
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
    metadata: { bizdevProspectScope: scopeFor(null) },
  };
  const state = { scopeLinkedClientId: null as string | null, prospectTools: true, session: true };
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
      sid: session.id,
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
          $queryRaw: async () => [],
          user: { findUnique: async () => user, findFirst: async () => user, update: async () => user },
          tenant: {
            findUnique: async () => ({
              ...tenant,
              settings: {
                clioFeatureFlags: {
                  'businessDevelopment.enabled': true,
                  'businessDevelopment.meriProspectTools.enabled': state.prospectTools,
                },
              },
            }),
          },
          tenantMembership: {
            findMany: async () => [membership],
            findFirst: async () => membership,
          },
          clioConversation: {
            findFirst: async ({ where }: any) =>
              Object.entries(where).every(([key, value]) => row[key] === value) ? { ...row } : null,
          },
          businessDevelopmentProspect: {
            findFirst: async ({ where }: any) =>
              where.id === prospectId
                ? {
                    id: prospectId,
                    displayName: 'Synthetic Prospect',
                    canonicalEntityId: null,
                    linkedClientId: state.scopeLinkedClientId,
                  }
                : null,
          },
          client: { findMany: async () => [], findFirst: async () => null },
        }),
    }),
    withSystem: PrismaService.prototype.withSystem,
    withTenant: PrismaService.prototype.withTenant,
  };
  let during = async () => {};
  const receipt = bizdevBriefReceipt(
    {
      tool: 'save_business_development_brief',
      status: 'saved',
      generatedAt: new Date(NOW).toISOString(),
      brief: {
        id: briefId,
        title: 'Updated brief',
        status: 'draft',
        currentVersionNumber: 3,
        updatedAt: new Date(NOW).toISOString(),
      },
      version: {
        id: versionId,
        versionNumber: 3,
        createdAt: new Date(NOW).toISOString(),
        citationCount: 2,
      },
      reused: false,
      prospectName: 'Synthetic Prospect',
    },
    bizdevInput(request),
  );
  const ledger: { saved: boolean } = { saved: false };
  const proposals = {
    create: jest.fn(async (_ctx, body, _turn, _legiwatch, access) => {
      await access.assertCurrent();
      await during();
      return { disposition: 'pending_approval', proposal: { proposalId: id('20') } };
    }),
    readBizdev: jest.fn(async (_ctx, proposalId, access) => {
      await access.assertCurrent();
      return {
        version: '0.1.0',
        proposalId,
        status: ledger.saved ? 'succeeded' : 'proposed',
        context: access.scope,
        request,
        receipt: ledger.saved ? receipt : null,
      };
    }),
    approveAndExecute: jest.fn(async (_ctx, _id2, _legiwatch, access) => {
      await access.assertCurrent();
      ledger.saved = true;
    }),
    dismiss: jest.fn(async (_ctx, _id2, _legiwatch, access) => {
      await access.assertCurrent();
    }),
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
    controllers: [BizdevActionController],
    providers: [
      BizdevActionService,
      BizDevMeriScopeService,
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
  const router = app.getHttpAdapter().getInstance()._router;
  async function send(
    body: any = query,
    options: {
      operation?: string;
      secret?: string;
      afterAuth?: (req: any) => void;
    } = {},
  ) {
    const operation = options.operation ?? 'prepare',
      url = `/api/clio/tools/${{ prepare: 'prepare_business_development_brief', read: 'read_business_development_brief_proposal', decide: 'decide_business_development_brief' }[operation]}`;
    const headers: any = {
      authorization: 'Bearer synthetic',
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
    ledger,
    receipt,
    close: () => app.close(),
    during(fn: () => Promise<void>) {
      during = fn;
    },
  };
}

afterEach(() => jest.restoreAllMocks());
test('mounted prepare resolves the persisted prospect scope and only creates one proposal', async () => {
  const f = await fixture();
  try {
    const r = await f.send();
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('proposed');
    expect(f.proposals.create).toHaveBeenCalledTimes(1);
    const [ctx, body, , legiwatchArg, access] = f.proposals.create.mock.calls[0]!;
    expect(ctx.tenantId).toBe(tenantId);
    expect(body).toMatchObject({
      tool: 'save_business_development_brief',
      requireApproval: true,
      surface: 'chat',
      conversationId,
    });
    expect(legiwatchArg).toBeUndefined();
    expect(access.scope).toMatchObject({ conversationId, prospectId, prospectName: 'Synthetic Prospect' });
    expect(body.input.conversationId).toBe(conversationId);
    expect(body.input.expectedVersionNumber).toBe(2);
    expect(body.input.title).toBe('Updated brief');
    expect(Object.keys(body.input.sections).sort()).toEqual([...BRIEF_SECTION_KEYS].sort());
    expect(body.input.sections.judgment).toEqual({ text: 'judgment text', citationIndexes: [0, 1] });
    expect(body.input.sections.judgment.provenance).toBeUndefined();
    expect(f.proposals.approveAndExecute).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
test('an unscoped conversation is never treated as canonical General', async () => {
  const f = await fixture();
  try {
    f.row.metadata = {};
    const r = await f.send();
    expect(r.status).toBe(403);
    expect(f.proposals.create).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
test('foreign, undisclosed and authority-like inputs refuse before proposal creation', async () => {
  const f = await fixture();
  try {
    expect((await f.send({ ...query, request: { ...request, conversationId: id('99') } })).status).toBe(
      400,
    );
    expect((await f.send({ ...query, request: { ...request, prospectId } })).status).toBe(400);
    expect(
      (
        await f.send({
          ...query,
          request: {
            ...request,
            sections: {
              ...sections,
              judgment: { text: 'x', citationIndexes: [0], provenance: 'edited' },
            },
          },
        })
      ).status,
    ).toBe(400);
    expect((await f.send({ ...query, request: { ...request, expectedVersionNumber: 0 } })).status).toBe(
      400,
    );
    expect(f.proposals.create).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
test.each(['secret', 'impersonation', 'expired'])(

  'mounted %s refuses before proposal creation',
  async (mode) => {
    const f = await fixture();
    try {
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
test.each(['flag', 'linkage'])(

  'a prospect scope that changes during prepare withholds the created proposal (%s)',
  async (mode) => {
    const f = await fixture();
    try {
      f.during(async () => {
        if (mode === 'flag') f.state.prospectTools = false;
        if (mode === 'linkage') f.state.scopeLinkedClientId = linkedClientId;
      });
      const r = await f.send();
      expect([403, 409]).toContain(r.status);
      expect(f.proposals.create).toHaveBeenCalledTimes(1);
      expect(f.proposals.readBizdev).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);
test('read/decision use the exact stored scope; a changed scope makes no decision', async () => {
  const f = await fixture();
  try {
    const p = await f.send();
    const body = { version: 1, proposalId: p.body.proposalId, context: p.body.context };
    expect((await f.send(body, { operation: 'read' })).status).toBe(200);
    f.state.prospectTools = false;
    expect((await f.send({ ...body, decision: 'approved' }, { operation: 'decide' })).status).toBe(
      409,
    );
    expect(f.proposals.approveAndExecute).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
test('an explicit approval releases the exact saved brief/version receipt once', async () => {
  const f = await fixture();
  try {
    const p = await f.send();
    const body = { version: 1, proposalId: p.body.proposalId, context: p.body.context };
    const decided = await f.send({ ...body, decision: 'approved' }, { operation: 'decide' });
    expect(decided.status).toBe(200);
    expect(f.proposals.approveAndExecute).toHaveBeenCalledTimes(1);
    expect(decided.body.status).toBe('succeeded');
    expect(decided.body.receipt).toEqual(f.receipt);
    expect(decided.body.receipt.version.versionNumber).toBe(3);
    expect(decided.body.receipt.brief.currentVersionNumber).toBe(3);
    expect(decided.body.receipt.request.expectedVersionNumber).toBe(2);
  } finally {
    await f.close();
  }
});
test('a rejection dismisses and never approves', async () => {
  const f = await fixture();
  try {
    const p = await f.send();
    const body = { version: 1, proposalId: p.body.proposalId, context: p.body.context };
    expect((await f.send({ ...body, decision: 'rejected' }, { operation: 'decide' })).status).toBe(
      200,
    );
    expect(f.proposals.dismiss).toHaveBeenCalledTimes(1);
    expect(f.proposals.approveAndExecute).not.toHaveBeenCalled();
    expect(f.ledger.saved).toBe(false);
  } finally {
    await f.close();
  }
});
test('an unconfirmed or foreign saved-brief receipt is never released', () => {
  const input = bizdevInput(request);
  const base = {
    tool: 'save_business_development_brief',
    status: 'saved',
    generatedAt: new Date(NOW).toISOString(),
    brief: {
      id: briefId,
      title: 'Updated brief',
      status: 'draft',
      currentVersionNumber: 3,
      updatedAt: new Date(NOW).toISOString(),
    },
    version: {
      id: versionId,
      versionNumber: 3,
      createdAt: new Date(NOW).toISOString(),
      citationCount: 2,
    },
    reused: false,
    prospectName: 'Synthetic Prospect',
  };
  expect(bizdevBriefReceipt(base, input).version.versionNumber).toBe(3);
  expect(() =>
    bizdevBriefReceipt({ ...base, version: { ...base.version, versionNumber: 4 } }, input),
  ).toThrow();
  expect(() =>
    bizdevBriefReceipt({ ...base, tool: 'get_business_development_brief' }, input),
  ).toThrow();
  expect(() =>
    bizdevBriefReceipt(
      { ...base, brief: { ...base.brief, currentVersionNumber: 2 } },
      input,
    ),
  ).toThrow();
  expect(() => bizdevBriefReceipt(base, bizdevInput({ ...request, expectedVersionNumber: 3 }))).toThrow();
  expect(() =>
    bizdevBriefReceipt({ ...base, prospectName: '' }, input),
  ).toThrow();
});
test('a proven pre-effect refusal is terminal while every unconfirmed effect stays UNKNOWN', () => {
  // The saved-version owner raises these inside its single transaction, before
  // the version write: the brief is unchanged and no replay is started.
  expect(
    classifyBizdevBriefFailure({
      status: 'failed_terminal',
      code: 'BIZDEV_BRIEF_VERSION_CONFLICT',
      message: 'The brief changed since this edit was prepared',
    }),
  ).toEqual({
    status: 'failed_terminal',
    code: 'BIZDEV_BRIEF_VERSION_CONFLICT',
    message: 'The brief changed since this edit was prepared',
  });
  expect(
    classifyBizdevBriefFailure({
      status: 'failed_terminal',
      code: 'BAD_REQUEST',
      message: 'This prospect has no brief yet',
    }).status,
  ).toBe('failed_terminal');
  // A bare status is not proof of the side of the write it came from: the owner
  // can throw after the version landed, so a generic 4xx/5xx stays UNKNOWN.
  expect(
    classifyBizdevBriefFailure({
      status: 'failed_terminal',
      code: 'BAD_REQUEST',
      message: 'Invalid business-development brief edit',
    }),
  ).toMatchObject({ status: 'outcome_unknown', code: 'bizdev_brief_outcome_unknown' });
  expect(
    classifyBizdevBriefFailure({
      status: 'failed_terminal',
      code: 'INTERNAL_SERVER_ERROR',
      message: 'PrismaClientKnownRequestError',
    }).status,
  ).toBe('outcome_unknown');
  // A retryable classification is never promoted to a proven refusal, even when
  // its message names a precondition.
  expect(
    classifyBizdevBriefFailure({
      status: 'failed_retryable',
      code: 'BIZDEV_BRIEF_VERSION_CONFLICT',
      message: 'The brief changed since this edit was prepared',
    }).status,
  ).toBe('outcome_unknown');
});
