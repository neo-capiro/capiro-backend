import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { TenantContext } from '@capiro/shared';
import { RolesGuard } from '../auth/roles.guard.js';
import { MeriActionProposalController } from './meri-action-proposal.controller.js';
import { MeriActionProposalService } from './meri-action-proposal.service.js';
import { ToolServiceSecretGuard } from './tool-service-secret.guard.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const OTHER_CONVERSATION = '44444444-4444-4444-8444-444444444444';
const CLIENT = '55555555-5555-4555-8555-555555555555';
const PROPOSAL = '66666666-6666-4666-8666-666666666666';
const SECRET = 'rp-proposal-http-secret';

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    tool: 'create_research_portfolio_snapshot',
    input: { operationKey: 'snapshot:http' },
    surface: 'chat',
    ...overrides,
  };
}

function currentTurn(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    userId: USER,
    conversationId: CONVERSATION,
    selectedClientId: CLIENT,
    ...overrides,
  };
}

function envelope(
  proposalOverrides: Record<string, unknown> = {},
  turnOverrides: Record<string, unknown> = {},
) {
  return {
    version: 1,
    proposal: proposal(proposalOverrides),
    currentTurn: currentTurn(turnOverrides),
  };
}

/**
 * Real Nest controller/DTO/strict admission proof with HAND-MOCKED auth
 * middleware and proposal service. Service persistence/execution is covered by
 * meri-action-proposal.service.spec.ts; no real JWT or database is claimed.
 */
describe('Research Portfolio proposal HTTP transport', () => {
  let app: INestApplication;
  const create = jest.fn().mockResolvedValue({
    disposition: 'pending_approval',
    proposal: { proposalId: PROPOSAL, status: 'proposed' },
  });
  const approveAndExecute = jest.fn().mockResolvedValue({
    proposalId: PROPOSAL,
    status: 'succeeded',
  });
  const service = {
    create,
    approveAndExecute,
    list: jest.fn().mockResolvedValue([]),
    dismiss: jest.fn(),
  };
  const priorSecret = process.env.INTERNAL_SERVICE_SECRET;

  beforeAll(async () => {
    process.env.INTERNAL_SERVICE_SECRET = SECRET;
    const moduleRef = await Test.createTestingModule({
      controllers: [MeriActionProposalController],
      providers: [
        ToolServiceSecretGuard,
        { provide: MeriActionProposalService, useValue: service },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) =>
              key === 'NODE_ENV'
                ? 'development'
                : key === 'MERI_TOOLS_REQUIRE_SERVICE_SECRET'
                  ? false
                  : key === 'INTERNAL_SERVICE_SECRET'
                    ? SECRET
                    : undefined,
          },
        },
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
        clerkUserId: 'mocked-auth-user',
        role: 'standard_user',
      };
      next();
    });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    if (priorSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = priorSecret;
  });

  beforeEach(() => {
    create.mockClear();
    approveAndExecute.mockClear();
    process.env.INTERNAL_SERVICE_SECRET = SECRET;
  });

  const post = (body: Record<string, unknown>, secret?: string) => {
    const pending = request(app.getHttpServer())
      .post('/api/clio/action-proposals')
      .set('authorization', 'Bearer mocked-user-token');
    if (secret !== undefined) pending.set('x-internal-service-secret', secret);
    return pending.send(body);
  };

  it('admits a valid actor-bound envelope and derives omitted outer and inner conversation ids', async () => {
    await post(envelope(), SECRET).expect(201);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, userId: USER }),
      {
        tool: 'create_research_portfolio_snapshot',
        input: { operationKey: 'snapshot:http', conversationId: CONVERSATION },
        conversationId: CONVERSATION,
        surface: 'chat',
      },
      { conversationId: CONVERSATION, selectedClientId: CLIENT },
    );
  });

  it('requires configured valid service identity despite development observe mode', async () => {
    await post(envelope()).expect(403);
    await post(envelope(), 'wrong').expect(403);
    delete process.env.INTERNAL_SERVICE_SECRET;
    await post(envelope(), SECRET).expect(403);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects absent scope, malformed scope, actor drift, and outer or inner retargeting', async () => {
    await post(proposal(), SECRET).expect(400);
    await post(envelope({}, { selectedClientId: 'not-a-uuid' }), SECRET).expect(400);
    await post(envelope({}, { userId: '77777777-7777-4777-8777-777777777777' }), SECRET).expect(
      403,
    );
    await post(envelope({ conversationId: OTHER_CONVERSATION }), SECRET).expect(400);
    await post(
      envelope({ input: { conversationId: OTHER_CONVERSATION, operationKey: 'snapshot:http' } }),
      SECRET,
    ).expect(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps ordinary proposal creation compatible in observe mode', async () => {
    const body = {
      tool: 'send_email',
      input: { to: 'person@example.com', body: 'Hello' },
      surface: 'chat',
    };
    await post(body).expect(201);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, userId: USER }),
      body,
    );
  });

  it('preserves the existing ordinary optional-null conversation under the actual strict DTO pipeline', async () => {
    const body = {
      tool: 'send_email',
      input: { to: 'person@example.com', body: 'Hello' },
      surface: 'chat',
      conversationId: null,
    };
    await post(body).expect(201);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, userId: USER }),
      body,
    );
    create.mockClear();
    await post({ ...body, unexpected: 'denied' }).expect(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('keeps browser approval opaque and rejects scope retarget fields', async () => {
    await request(app.getHttpServer())
      .post(`/api/clio/action-proposals/${PROPOSAL}/approve`)
      .send({})
      .expect(201);
    expect(approveAndExecute).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, userId: USER }),
      PROPOSAL,
    );
    approveAndExecute.mockClear();
    await request(app.getHttpServer())
      .post(`/api/clio/action-proposals/${PROPOSAL}/approve`)
      .send({ conversationId: OTHER_CONVERSATION, selectedClientId: null })
      .expect(400);
    expect(approveAndExecute).not.toHaveBeenCalled();
  });
});
