import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { TenantContext } from '@capiro/shared';
import { RolesGuard } from '../auth/roles.guard.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ClientKbService } from '../embeddings/client-kb.service.js';
import { ResearchPortfolioMeriToolsService } from '../research-portfolios/research-portfolio-meri-tools.service.js';
import { ResearchPortfolioMeriScopeService } from '../research-portfolios/research-portfolio-meri-scope.service.js';
import { MeriController } from './meri.controller.js';
import { MeriService } from './meri.service.js';
import { MeriToolsService } from './meri-tools.service.js';
import { MeriResearchService } from './meri-research.service.js';
import { MeriMcpService } from './meri-mcp.service.js';
import { MeriMcpOAuthService } from './meri-mcp-oauth.service.js';
import { MeriFirmSkillsService } from './meri-firm-skills.service.js';
import { MeriProcedureRuntimeValidationService } from './meri-procedure-runtime-validation.service.js';
import { MeriApprovalService } from './meri-approval.service.js';
import { MeriComplianceAuditService } from './meri-compliance-audit.service.js';
import { MeriClaimWriterService } from './meri-claim-writer.js';
import { ToolServiceSecretGuard } from './tool-service-secret.guard.js';

jest.setTimeout(60_000);

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const OTHER_CONVERSATION = '44444444-4444-4444-8444-444444444444';
const CLIENT = '55555555-5555-4555-8555-555555555555';
const OTHER_CLIENT = '66666666-6666-4666-8666-666666666666';
const PORTFOLIO = '77777777-7777-4777-8777-777777777777';
const SECRET = 'strict-rp-tool-transport-secret';

const storedScope = {
  kind: 'research_portfolio',
  researchPortfolioId: PORTFOLIO,
  researchPortfolioName: 'Synthetic portfolio',
  researchPortfolioRevision: 3,
  scopeVersion: 'a'.repeat(64),
};
const grantedScope = {
  ...storedScope,
  currentResearchPortfolioName: 'Synthetic portfolio',
  currentResearchPortfolioRevision: 3,
  stale: false,
};
const metadata = { researchPortfolioScope: storedScope };

function turn(selectedClientId: string | null = CLIENT, overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    userId: USER,
    conversationId: CONVERSATION,
    selectedClientId,
    ...overrides,
  };
}

function envelope(
  input: Record<string, unknown> = {},
  currentTurn = turn(),
): Record<string, unknown> {
  return { version: 1, input, currentTurn };
}

type OrchestratorRepo = {
  execute(ctx: unknown, name: string, input: Record<string, unknown>): Promise<unknown>;
};

describe('Research Portfolio actual repo -> HTTP -> controller -> canonical owner boundary', () => {
  let app: INestApplication;
  let apiBaseUrl: string;
  let currentClient: string | null = CLIENT;
  const detail = jest.fn(async (_ctx: TenantContext, portfolioId: string) => ({
    id: portfolioId,
    name: 'Synthetic portfolio',
    purpose: 'Boundary proof',
  }));
  const authorize = jest.fn(async () => grantedScope);
  const findFirst = jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
    if (
      where.id !== CONVERSATION ||
      where.tenantId !== TENANT ||
      where.userId !== USER ||
      where.archivedAt !== null
    ) {
      return null;
    }
    return { metadata, clientId: currentClient };
  });
  const tx = { clioConversation: { findFirst } };
  const prisma = {
    withTenant: jest.fn((_tenantId: string, run: (value: typeof tx) => unknown) => run(tx)),
  } as unknown as PrismaService;
  const scopeService = { authorize } as unknown as ResearchPortfolioMeriScopeService;
  const validateProcedureRuntime = jest.fn(async () => {
    throw new Error('Procedure runtime validation was not expected for a Research Portfolio tool');
  });
  const owner = new ResearchPortfolioMeriToolsService(
    prisma,
    scopeService,
    { detail } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const tools = Object.assign(Object.create(MeriToolsService.prototype), {
    prisma,
    researchPortfolioTools: owner,
    researchPortfolioScope: scopeService,
  }) as MeriToolsService;
  const priorSecret = process.env.INTERNAL_SERVICE_SECRET;
  const priorToolsFlag = process.env.RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED;

  beforeAll(async () => {
    process.env.INTERNAL_SERVICE_SECRET = SECRET;
    process.env.RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED = 'true';
    const moduleRef = await Test.createTestingModule({
      controllers: [MeriController],
      providers: [
        ToolServiceSecretGuard,
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'NODE_ENV'
                ? 'development'
                : key === 'INTERNAL_SERVICE_SECRET'
                  ? SECRET
                  : key === 'MERI_TOOLS_REQUIRE_SERVICE_SECRET'
                    ? false
                    : undefined,
          },
        },
        { provide: MeriToolsService, useValue: tools },
        { provide: MeriService, useValue: {} },
        { provide: MeriResearchService, useValue: {} },
        { provide: ClientKbService, useValue: {} },
        { provide: MeriMcpService, useValue: {} },
        { provide: MeriMcpOAuthService, useValue: {} },
        { provide: MeriFirmSkillsService, useValue: {} },
        {
          provide: MeriProcedureRuntimeValidationService,
          useValue: { validate: validateProcedureRuntime },
        },
        { provide: MeriApprovalService, useValue: {} },
        { provide: MeriComplianceAuditService, useValue: {} },
        { provide: MeriClaimWriterService, useValue: {} },
      ],
    })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use((req: { tenantContext?: TenantContext }, _res: unknown, next: () => void) => {
      req.tenantContext = {
        tenantId: TENANT,
        tenantSlug: 'test',
        userId: USER,
        clerkUserId: 'clerk-test',
        role: 'standard_user',
      };
      next();
    });
    await app.listen(0, '127.0.0.1');
    apiBaseUrl = await app.getUrl();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (priorToolsFlag === undefined) delete process.env.RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED;
    else process.env.RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED = priorToolsFlag;
    if (priorSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = priorSecret;
  });

  beforeEach(() => {
    currentClient = CLIENT;
    detail.mockClear();
    authorize.mockReset().mockResolvedValue(grantedScope);
    findFirst.mockClear();
    validateProcedureRuntime.mockClear();
  });

  afterEach(() => {
    expect(validateProcedureRuntime).not.toHaveBeenCalled();
  });

  it.each([undefined, 'false'])(
    'keeps strict opt-in default gate closed for %s without owner effect',
    async (flag) => {
      if (flag === undefined) delete process.env.RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED;
      else process.env.RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED = flag;
      try {
        await expect(executeThroughActualRepo({}, CLIENT)).rejects.toThrow('404');
        expect(detail).not.toHaveBeenCalled();
      } finally {
        process.env.RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED = 'true';
      }
    },
  );

  it('requires strict RP admission for whitespace-normalized tool names before canonical dispatch', async () => {
    await request(app.getHttpServer())
      .post('/api/clio/tools/%20get_research_portfolio%20')
      .send({ conversationId: CONVERSATION })
      .expect(403);
    expect(detail).not.toHaveBeenCalled();
  });

  function repo(): OrchestratorRepo {
    // Runtime require keeps the API package's production TypeScript root closed
    // while exercising the actual orchestrator repository over a real socket.
    const {
      ApiToolExecutorRepo,
    } = require('../../../meriv2-orchestrator/src/meri/api-tool-executor.repo');
    return new ApiToolExecutorRepo({
      get: (key: string) =>
        key === 'INTERNAL_SERVICE_SECRET'
          ? SECRET
          : key === 'MERIV2_API_BASE_URL'
            ? apiBaseUrl
            : key === 'MERIV2_TOOL_TIMEOUT_MS'
              ? '10000'
              : undefined,
    }) as OrchestratorRepo;
  }

  async function executeThroughActualRepo(
    input: Record<string, unknown>,
    selectedClientId: string | null = CLIENT,
  ) {
    const {
      RequestCredentialsStore,
    } = require('../../../meriv2-orchestrator/src/request/request-credentials.store');
    const {
      withTrustedCurrentTurnScope,
    } = require('../../../meriv2-orchestrator/src/request/trusted-current-turn-scope');
    return RequestCredentialsStore.run({ bearerToken: 'synthetic-user-token' }, () =>
      withTrustedCurrentTurnScope(turn(selectedClientId), () =>
        repo().execute({}, 'get_research_portfolio', input),
      ),
    );
  }

  const post = (body: Record<string, unknown>, secret: string | null | undefined = SECRET) => {
    const pending = request(app.getHttpServer())
      .post('/api/clio/tools/get_research_portfolio')
      .set('authorization', 'Bearer synthetic-user-token');
    if (typeof secret === 'string') pending.set('x-internal-service-secret', secret);
    return pending.send(body);
  };

  it('derives omitted/equal conversation and reaches the real canonical owner under UUID client scope', async () => {
    await expect(executeThroughActualRepo({})).resolves.toEqual({
      id: PORTFOLIO,
      name: 'Synthetic portfolio',
      purpose: 'Boundary proof',
    });
    await expect(executeThroughActualRepo({ conversationId: CONVERSATION })).resolves.toMatchObject(
      { id: PORTFOLIO },
    );

    expect(detail).toHaveBeenCalledTimes(2);
    expect(detail).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, userId: USER }),
      PORTFOLIO,
    );
    expect(authorize).toHaveBeenCalledTimes(4);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: CONVERSATION,
          tenantId: TENANT,
          userId: USER,
          archivedAt: null,
        },
      }),
    );
  });

  it('preserves exact null client scope and rejects UUID client mismatch before owner dispatch', async () => {
    currentClient = null;
    await expect(executeThroughActualRepo({}, null)).resolves.toMatchObject({ id: PORTFOLIO });

    detail.mockClear();
    currentClient = CLIENT;
    await expect(executeThroughActualRepo({}, OTHER_CLIENT)).rejects.toThrow(
      /current conversation client no longer matches/i,
    );
    expect(detail).not.toHaveBeenCalled();
  });

  it('rejects missing/different/invalid context and cross-actor transport before canonical owner', async () => {
    await post({ conversationId: CONVERSATION }).expect(400);
    await post(envelope({ conversationId: OTHER_CONVERSATION })).expect(400);
    await post(envelope({}, turn(CLIENT, { selectedClientId: 'not-a-uuid' }))).expect(400);
    await post(
      envelope({}, turn(CLIENT, { userId: '88888888-8888-4888-8888-888888888888' })),
    ).expect(403);
    await post({ ...envelope(), extra: true }).expect(400);
    expect(detail).not.toHaveBeenCalled();
  });

  it('requires configured exact service identity for RP even when the route guard is observe-only', async () => {
    await post(envelope(), null).expect(403);
    await post(envelope(), 'wrong-secret').expect(403);
    delete process.env.INTERNAL_SERVICE_SECRET;
    try {
      await post(envelope(), SECRET).expect(403);
    } finally {
      process.env.INTERNAL_SERVICE_SECRET = SECRET;
      process.env.RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED = 'true';
    }
    expect(detail).not.toHaveBeenCalled();
  });

  it('rechecks and rejects current-client drift while the asynchronous RP grant is pending', async () => {
    let grantStarted!: () => void;
    let releaseGrant!: () => void;
    const started = new Promise<void>((resolve) => {
      grantStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseGrant = resolve;
    });
    authorize.mockImplementationOnce(async () => {
      grantStarted();
      await blocked;
      return grantedScope;
    });

    const pending = post(envelope()).then((response) => response);
    await started;
    currentClient = OTHER_CLIENT;
    releaseGrant();
    const response = await pending;

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(
      /client changed while Research Portfolio access was checked/i,
    );
    expect(detail).not.toHaveBeenCalled();
  });
});
