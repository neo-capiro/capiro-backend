import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { TenantContext } from '@capiro/shared';
import { RolesGuard } from '../auth/roles.guard.js';
import { ClientKbService } from '../embeddings/client-kb.service.js';
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
import { currentMeriChatAttachmentReadScope } from './meri-chat-attachment-read-scope.js';
import { assertMeriToolRequestActive } from './meri-tool-request-control.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const OTHER_CONVERSATION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLIENT = '44444444-4444-4444-8444-444444444444';
const SECRET = 'strict-served-attachment-secret';

function currentTurn(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    userId: USER,
    conversationId: CONVERSATION,
    selectedClientId: CLIENT,
    ...overrides,
  };
}

function envelope(input: Record<string, unknown> = {}, scope = currentTurn()) {
  return { version: 1, input, currentTurn: scope };
}

describe('served attachment real API controller dispatch', () => {
  let app: INestApplication;
  const read = jest.fn(async (ctx: TenantContext, input: Record<string, unknown>) => {
    assertMeriToolRequestActive();
    const scope = currentMeriChatAttachmentReadScope();
    return {
      tool: 'read_chat_attachments',
      ctx: { tenantId: ctx.tenantId, userId: ctx.userId },
      input,
      scope,
      records: [{ payload: { text: 'persisted generated-byte evidence' } }],
    };
  });
  const tools = Object.assign(Object.create(MeriToolsService.prototype), {
    chatAttachmentReader: { read },
  }) as MeriToolsService;
  const validateProcedureRuntime = jest.fn(async () => {
    throw new Error('Procedure runtime validation was not expected for an attachment read');
  });
  const priorSecret = process.env.INTERNAL_SERVICE_SECRET;

  beforeAll(async () => {
    process.env.INTERNAL_SERVICE_SECRET = SECRET;
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
    app.use(
      (
        req: { headers: Record<string, unknown>; tenantContext?: TenantContext },
        _res: unknown,
        next: () => void,
      ) => {
        req.tenantContext = {
          tenantId: TENANT,
          tenantSlug: 'test',
          userId: USER,
          clerkUserId: 'clerk-test',
          role: 'standard_user',
        };
        next();
      },
    );
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (priorSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
    else process.env.INTERNAL_SERVICE_SECRET = priorSecret;
  });

  beforeEach(() => {
    read.mockClear();
    validateProcedureRuntime.mockClear();
  });

  afterEach(() => {
    expect(validateProcedureRuntime).not.toHaveBeenCalled();
  });

  const post = (body: Record<string, unknown>, secret: string | null | undefined = SECRET) => {
    const pending = request(app.getHttpServer())
      .post('/api/clio/tools/read_chat_attachments')
      .set('authorization', 'Bearer fresh-user-token');
    if (typeof secret === 'string') pending.set('x-internal-service-secret', secret);
    return pending.send(body);
  };

  it('runs controller -> canonical dispatch -> dedicated reader with server-derived conversation', async () => {
    const first = await post(
      envelope({ attachmentId: '55555555-5555-4555-8555-555555555555' }),
    ).expect(200);
    expect(first.body).toMatchObject({
      tool: 'read_chat_attachments',
      ctx: { tenantId: TENANT, userId: USER },
      input: {
        conversationId: CONVERSATION,
        attachmentId: '55555555-5555-4555-8555-555555555555',
      },
      scope: currentTurn(),
    });
    const repeated = await post(envelope({ limit: 10 })).expect(200);
    expect(repeated.body.input.conversationId).toBe(CONVERSATION);
    expect(read).toHaveBeenCalledTimes(2);
    expect(currentMeriChatAttachmentReadScope()).toBeUndefined();
  });

  it('requires configured service identity for this read despite development observe mode', async () => {
    await post(envelope(), null).expect(403);
    await post(envelope(), 'wrong-secret').expect(403);
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects missing context, forged body conversation, actor drift, and malformed client scope', async () => {
    await post({ conversationId: CONVERSATION }).expect(400);
    await post(envelope({ conversationId: OTHER_CONVERSATION })).expect(400);
    await post(
      envelope({}, currentTurn({ userId: '66666666-6666-4666-8666-666666666666' })),
    ).expect(403);
    await post(envelope({}, currentTurn({ selectedClientId: 'not-a-uuid' }))).expect(400);
    expect(read).not.toHaveBeenCalled();
  });
});
