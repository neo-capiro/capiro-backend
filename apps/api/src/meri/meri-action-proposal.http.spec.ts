import { GoneException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { TenantContext } from '@capiro/shared';
import { RolesGuard } from '../auth/roles.guard.js';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ClientKbService } from '../embeddings/client-kb.service.js';
import { MeriActionProposalController } from './meri-action-proposal.controller.js';
import { MeriActionProposalService } from './meri-action-proposal.service.js';
import { MeriApprovalService } from './meri-approval.service.js';
import { MeriComplianceAuditService } from './meri-compliance-audit.service.js';
import { MeriController } from './meri.controller.js';
import { MeriFirmSkillsService } from './meri-firm-skills.service.js';
import { MeriMcpOAuthService } from './meri-mcp-oauth.service.js';
import { MeriMcpService } from './meri-mcp.service.js';
import { MeriClaimWriterService } from './meri-claim-writer.js';
import { MeriResearchService } from './meri-research.service.js';
import { MeriService } from './meri.service.js';
import { MeriToolsService } from './meri-tools.service.js';
import { ToolServiceSecretGuard } from './tool-service-secret.guard.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const PROPOSAL = '33333333-3333-4333-8333-333333333333';
const OTHER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECRET = 'phase0-internal-secret';

function tenantContext(headers: Record<string, unknown>): TenantContext {
  const tenant = typeof headers['x-test-tenant'] === 'string' ? headers['x-test-tenant'] : TENANT;
  const user = typeof headers['x-test-user'] === 'string' ? headers['x-test-user'] : USER;
  return {
    tenantId: tenant,
    tenantSlug: 'test',
    userId: user,
    clerkUserId: `clerk_${user}`,
    role: 'standard_user',
  };
}

describe('MeriV2 Phase 0 HTTP adversarial boundary', () => {
  let app: INestApplication;
  const executeTool = jest.fn().mockResolvedValue({ ok: true });
  const createProposal = jest.fn().mockResolvedValue({
    proposalId: PROPOSAL,
    status: 'proposed',
    preview: { label: 'Send email', fields: {}, counts: {}, reason: 'Approval required' },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const approve = jest.fn(async (ctx: TenantContext, proposalId: string) => {
    if (ctx.tenantId !== TENANT || ctx.userId !== USER || proposalId !== PROPOSAL) {
      throw new NotFoundException('Action proposal not found.');
    }
    return { proposalId, status: 'succeeded' };
  });
  const proposalService = {
    create: createProposal,
    list: jest.fn().mockResolvedValue([]),
    approveAndExecute: approve,
    dismiss: jest.fn().mockResolvedValue({ proposalId: PROPOSAL, status: 'dismissed' }),
  };

  beforeAll(async () => {
    const legacyApproval = new MeriApprovalService({
      withTenant: jest.fn((_tenantId: string, fn: (tx: unknown) => unknown) =>
        fn({ meriActionApproval: { findMany: jest.fn().mockResolvedValue([]) } }),
      ),
    } as unknown as PrismaService);

    const moduleRef = await Test.createTestingModule({
      controllers: [MeriController, MeriActionProposalController],
      providers: [
        ToolServiceSecretGuard,
        {
          provide: ConfigService,
          useValue: {
            get: (key: keyof AppConfig) =>
              key === 'NODE_ENV'
                ? 'production'
                : key === 'INTERNAL_SERVICE_SECRET'
                  ? SECRET
                  : key === 'MERI_TOOLS_REQUIRE_SERVICE_SECRET'
                    ? false
                    : undefined,
          },
        },
        { provide: MeriActionProposalService, useValue: proposalService },
        { provide: MeriApprovalService, useValue: legacyApproval },
        {
          provide: MeriToolsService,
          useValue: {
            executeFromAuthenticatedUser: executeTool,
            manifest: jest.fn().mockReturnValue([]),
            anthropicToolSchemas: jest.fn().mockReturnValue([]),
            checkClientRef: jest.fn(),
          },
        },
        { provide: MeriService, useValue: {} },
        { provide: MeriResearchService, useValue: {} },
        { provide: ClientKbService, useValue: {} },
        { provide: MeriMcpService, useValue: {} },
        { provide: MeriMcpOAuthService, useValue: {} },
        { provide: MeriFirmSkillsService, useValue: {} },
        { provide: MeriComplianceAuditService, useValue: {} },
        { provide: MeriClaimWriterService, useValue: {} },
      ],
    })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use((req: { headers: Record<string, unknown>; tenantContext?: TenantContext }, _res: unknown, next: () => void) => {
      req.tenantContext = tenantContext(req.headers);
      next();
    });
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    executeTool.mockClear();
    createProposal.mockClear();
    approve.mockClear();
  });

  it('normal user cannot POST arbitrary legacy pending action data', async () => {
    const response = await request(app.getHttpServer()).post('/api/clio/pending-actions').send({
      fingerprint: 'f'.repeat(64),
      tool: 'send_email',
      input: { to: 'victim@example.com', body: 'attacker controlled' },
    });
    expect(response.status).toBe(new GoneException().getStatus());
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('raw write tool rejects a valid user route without or with wrong service identity', async () => {
    await request(app.getHttpServer())
      .post('/api/clio/tools/send_email')
      .send({ to: 'victim@example.com', body: 'test' })
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/clio/tools/send_email')
      .set('x-internal-service-secret', 'wrong')
      .send({ to: 'victim@example.com', body: 'test' })
      .expect(403);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('correct service identity plus effective user context reaches the delegated service', async () => {
    await request(app.getHttpServer())
      .post('/api/clio/tools/send_email')
      .set('x-internal-service-secret', SECRET)
      .send({ to: 'victim@example.com', body: 'test' })
      .expect(201);
    expect(executeTool).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, userId: USER }),
      'send_email',
      { to: 'victim@example.com', body: 'test' },
    );
  });

  it('browser cannot create a trusted proposal without service identity', async () => {
    const body = {
      tool: 'send_email',
      input: { to: 'victim@example.com', body: 'test' },
      surface: 'chat',
    };
    await request(app.getHttpServer()).post('/api/clio/action-proposals').send(body).expect(403);
    await request(app.getHttpServer())
      .post('/api/clio/action-proposals')
      .set('x-internal-service-secret', 'wrong')
      .send(body)
      .expect(403);
    expect(createProposal).not.toHaveBeenCalled();
  });

  it('orchestrator identity can submit only tool/input/conversation/surface fields', async () => {
    const body = {
      tool: 'send_email',
      input: { to: 'victim@example.com', body: 'test' },
      surface: 'chat',
    };
    await request(app.getHttpServer())
      .post('/api/clio/action-proposals')
      .set('x-internal-service-secret', SECRET)
      .send(body)
      .expect(201);
    expect(createProposal).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, userId: USER }),
      body,
    );
    await request(app.getHttpServer())
      .post('/api/clio/action-proposals')
      .set('x-internal-service-secret', SECRET)
      .send({ ...body, fingerprint: 'f'.repeat(64), tenantId: OTHER, policyDecision: 'WARN' })
      .expect(400);
  });

  it('approval body rejects tool, payload, fingerprint, tenant, and status fields', async () => {
    await request(app.getHttpServer())
      .post(`/api/clio/action-proposals/${PROPOSAL}/approve`)
      .send({
        tool: 'send_email',
        input: { to: 'victim@example.com' },
        fingerprint: 'f'.repeat(64),
        tenantId: OTHER,
        status: 'succeeded',
      })
      .expect(400);
    expect(approve).not.toHaveBeenCalled();
  });

  it('another user and another tenant cannot approve an opaque proposal id', async () => {
    await request(app.getHttpServer())
      .post(`/api/clio/action-proposals/${PROPOSAL}/approve`)
      .set('x-test-user', OTHER)
      .send({})
      .expect(404);
    await request(app.getHttpServer())
      .post(`/api/clio/action-proposals/${PROPOSAL}/approve`)
      .set('x-test-tenant', OTHER)
      .send({})
      .expect(404);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('owner approval sends no browser authority beyond proposal id', async () => {
    await request(app.getHttpServer())
      .post(`/api/clio/action-proposals/${PROPOSAL}/approve`)
      .send({})
      .expect(201)
      .expect(({ body }) => expect(body).toEqual({ proposalId: PROPOSAL, status: 'succeeded' }));
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, userId: USER }),
      PROPOSAL,
    );
  });
});
