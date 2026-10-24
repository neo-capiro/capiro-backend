import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { RolesGuard } from '../../auth/roles.guard.js';
import { ToolServiceSecretGuard } from '../../auth/tool-service-secret.guard.js';
import { configureApiHttpApp } from '../../bootstrap/configure-api-http-app.js';
import type { Request, Response, NextFunction } from 'express';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ClientKbService } from '../../embeddings/client-kb.service.js';
import { MeriController } from '../meri.controller.js';
import { MeriModule } from '../meri.module.js';
import { MeriService } from '../meri.service.js';
import { MeriToolsService } from '../meri-tools.service.js';
import { MeriResearchService } from '../meri-research.service.js';
import { MeriMcpService } from '../meri-mcp.service.js';
import { MeriMcpOAuthService } from '../meri-mcp-oauth.service.js';
import { MeriFirmSkillsService } from '../meri-firm-skills.service.js';
import { MeriProcedureRuntimeValidationService } from '../meri-procedure-runtime-validation.service.js';
import { MeriApprovalService } from '../meri-approval.service.js';
import { MeriComplianceAuditService } from '../meri-compliance-audit.service.js';
import { MeriClaimWriterService } from '../meri-claim-writer.js';
import * as source from './meri-passive-memory-source.js';
import { MeriMemoryHelperController } from './meri-memory-helper.controller.js';

/** Actual Nest route order and service guard. User authentication is a synthetic
 * fixture; canonical eligibility is tested separately against its real owner. */
describe('ordinary memory helper HTTP mount', () => {
  const secret = 'synthetic-http-mount-secret';
  const helperPath = '/api/clio/tools/search_memory_eligibility';
  const raw = Buffer.from('{ "schemaVersion": 1, "input": {"b":2,"a":1}, "metadata": null }', 'utf8');
  let app: INestApplication;
  const withTenantUser = jest.fn();
  const ctx = { tenantId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', role: 'standard_user' } as TenantContext;

  beforeAll(async () => {
    const controllers = (Reflect.getMetadata('controllers', MeriModule) as Function[])
      .filter(value => value === MeriMemoryHelperController || value === MeriController);
    expect(controllers).toEqual([MeriMemoryHelperController, MeriController]);
    const moduleRef = await Test.createTestingModule({
      // Mount these actual controller classes in MeriModule's source order.
      // The dynamic MeriController route must not claim the fixed helper.
      controllers: controllers as Array<typeof MeriController | typeof MeriMemoryHelperController>,
      providers: [
        ToolServiceSecretGuard,
        { provide: ConfigService, useValue: { get: (key: string) => ({
          NODE_ENV: 'staging', MERI_TOOLS_REQUIRE_SERVICE_SECRET: true,
          INTERNAL_SERVICE_SECRET: secret,
        } as Record<string, unknown>)[key] } },
        { provide: PrismaService, useValue: { withTenantUser } },
        { provide: MeriService, useValue: {} },
        { provide: MeriToolsService, useValue: {} },
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
    }).overrideGuard(RolesGuard).useValue({ canActivate: () => true }).compile();
    app = moduleRef.createNestApplication();
    configureApiHttpApp(app, {
      includeClerkRawBody: false, includeRecallRawBody: false, includeTangoRawBody: false,
      includeMeriReadDelegationRawBody: false, includeEmailSignatureLargeBody: false,
      defaultJsonLimit: '1mb',
    });
    app.use((req: Request & { tenantContext?: TenantContext }, res: Response, next: NextFunction) => {
      if (req.headers.authorization !== 'Bearer synthetic-user-session') {
        res.status(401).json({ error: 'Synthetic fixture requires its authenticated user' });
        return;
      }
      req.tenantContext = ctx;
      next();
    });
    await app.init();
  });

  afterAll(async () => { await app?.close(); });
  afterEach(() => { jest.restoreAllMocks(); withTenantUser.mockClear(); });

  const post = (authorization = 'Bearer synthetic-user-session', service = secret) => request(app.getHttpServer()).post(helperPath)
    .set('Authorization', authorization).set('x-internal-service-secret', service)
    .set('Content-Type', 'application/json; charset=utf-8').send(raw.toString('utf8'));

  it('routes the fixed helper before tools/:name and sends parsed input to the canonical eligibility owner', async () => {
    const check = jest.spyOn(source, 'checkPassiveMemoryEligibility').mockResolvedValue({ syntheticMountOnly: true } as never);
    const response = await post();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ syntheticMountOnly: true });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-meri-memory-proof']).toBeUndefined();
    expect(check).toHaveBeenCalledWith(expect.anything(), ctx, JSON.parse(raw.toString('utf8')));
    expect(check).toHaveBeenCalledTimes(1);
    expect(withTenantUser).not.toHaveBeenCalled();
  });

  it('requires both ordinary user authentication and the real service guard', async () => {
    const check = jest.spyOn(source, 'checkPassiveMemoryEligibility');
    expect((await post('Bearer foreign-user-session')).status).toBe(401);
    expect((await post('CapiroMeriRead retired.token')).status).toBe(401);
    expect((await post('Bearer synthetic-user-session', 'wrong-service')).status).toBe(403);
    expect(check).not.toHaveBeenCalled();
    expect(withTenantUser).not.toHaveBeenCalled();
  });
});
