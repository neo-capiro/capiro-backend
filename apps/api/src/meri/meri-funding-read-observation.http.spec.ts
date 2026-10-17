import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
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
import { currentMeriFundingReadAsOf } from './meri-funding-read-observation.js';

const NAME = 'search_funding_opportunities';
const BODY = {
  query: ' Civic & energía 🌱 ',
  clientId: 'a1234567-b123-4c12-8d12-e123456789ab',
  pageSize: 5,
};
const CARRIER =
  'eyJjb250ZXh0Ijp7ImFzT2YiOiIyMDI2LTEwLTE3VDEyOjM0OjU2Ljc4OVoifSwib3BlcmF0aW9uIjp7ImlkIjoic2VhcmNoX2Z1bmRpbmdfb3Bwb3J0dW5pdGllcyIsInZlcnNpb24iOiIwLjIuMCJ9LCJyZXF1ZXN0U2hhMjU2IjoiNTA5MmY4ZWJmYTE3OTc4MzNmOTYzNTNlOTNiODA3ZGZjMjRjZjExMDdhNmM5OGNlOTlhZDQ5ZjhiODY0YjRlOCIsInNjaGVtYVZlcnNpb24iOiJtZXJpLW5hdGl2ZS1yZWFkLW9ic2VydmF0aW9uLzEifQ';
const AS_OF = '2026-10-17T12:34:56.789Z';
const SECRET = 'strict-funding-observation-service-secret';

describe('served finite funding observation', () => {
  let app: INestApplication;
  const execute = jest.fn(async (_ctx: TenantContext, name: string) => ({
    asOf: currentMeriFundingReadAsOf(name as typeof NAME)?.toISOString() ?? null,
  }));

  beforeAll(async () => {
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
        { provide: MeriToolsService, useValue: { executeFromAuthenticatedUser: execute } },
        { provide: MeriService, useValue: {} },
        { provide: MeriResearchService, useValue: {} },
        { provide: ClientKbService, useValue: {} },
        { provide: MeriMcpService, useValue: {} },
        { provide: MeriMcpOAuthService, useValue: {} },
        { provide: MeriFirmSkillsService, useValue: {} },
        { provide: MeriProcedureRuntimeValidationService, useValue: {} },
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
      (req: { tenantContext?: TenantContext }, _res: unknown, next: () => void) => {
        req.tenantContext = {
          tenantId: '11111111-1111-4111-8111-111111111111',
          tenantSlug: 'test',
          userId: '22222222-2222-4222-8222-222222222222',
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
  });

  beforeEach(() => execute.mockClear());

  function post(name = NAME, body: Record<string, unknown> = BODY, secret?: string, carrier?: string) {
    const pending = request(app.getHttpServer())
      .post(`/api/clio/tools/${name}`)
      .set('authorization', 'Bearer fresh-user-token');
    if (secret !== undefined) pending.set('x-internal-service-secret', secret);
    if (carrier !== undefined) pending.set('x-meri-read-observation', carrier);
    return pending.send(body);
  }

  it('carries the trusted instant through the existing HTTP controller closure', async () => {
    const response = await post(NAME, BODY, SECRET, CARRIER).expect(200);
    expect(response.body).toEqual({ asOf: AS_OF });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(currentMeriFundingReadAsOf(NAME)).toBeUndefined();
  });

  it('preserves a legacy no-header request in observe mode', async () => {
    const response = await post(NAME, BODY, 'wrong').expect(200);
    expect(response.body).toEqual({ asOf: null });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('refuses the header with missing or wrong service proof before dispatch', async () => {
    await post(NAME, BODY, undefined, CARRIER).expect(403);
    await post(NAME, BODY, 'wrong', CARRIER).expect(403);
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses changed original body and route before dispatch', async () => {
    await post(NAME, { ...BODY, query: BODY.query.trim() }, SECRET, CARRIER).expect(400);
    await post('get_funding_opportunity', BODY, SECRET, CARRIER).expect(400);
    expect(execute).not.toHaveBeenCalled();
  });
});
