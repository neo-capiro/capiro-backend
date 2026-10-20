import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { RolesGuard } from '../../auth/roles.guard.js';
import { ToolServiceSecretGuard } from '../../auth/tool-service-secret.guard.js';
import * as gate from '../../auth/read-delegation/signed-memory-http-gate.js';
import { configureApiHttpApp } from '../../bootstrap/configure-api-http-app.js';
import { TenantContextMiddleware } from '../../tenant/tenant-context.middleware.js';
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
import * as helperReceiver from './meri-memory-helper-receiver.js';
import { MeriMemoryHelperController } from './meri-memory-helper.controller.js';

/** Actual Nest routing plus the production bootstrap parser and tenant-middleware
 * methods, with all database and signed-receiver work replaced by inert probes.
 * The enabled case uses only a Jest spy; the source gate remains hard off. */
describe('signed memory helper HTTP mount', () => {
  const secret = 'synthetic-http-mount-secret';
  const helperPath = '/api/clio/tools/search_memory_eligibility';
  const pagePath = '/api/clio/tools/search_memory';
  const proposalPath = '/api/clio/tools/memory.list_own_proposals';
  const raw = Buffer.from('{ "schemaVersion": 1, "input": {"b":2,"a":1}, "metadata": null }', 'utf8');
  let app: INestApplication;
  const withSystem = jest.fn();
  const admitOrdinaryToken = jest.fn();

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
        { provide: PrismaService, useValue: { withSystem } },
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
      includeMeriReadDelegationRawBody: true, includeEmailSignatureLargeBody: false,
      defaultJsonLimit: '1mb',
    });
    const middleware = Object.create(TenantContextMiddleware.prototype) as TenantContextMiddleware;
    Object.assign(middleware, { useMeriReadDelegation: admitOrdinaryToken });
    app.use((req: Parameters<TenantContextMiddleware['use']>[0],
      res: Parameters<TenantContextMiddleware['use']>[1], next: Parameters<TenantContextMiddleware['use']>[2]) => {
      void middleware.use(req, res, next).catch(next);
    });
    await app.init();
  });

  afterAll(async () => { await app?.close(); });
  afterEach(() => { jest.restoreAllMocks(); withSystem.mockClear(); admitOrdinaryToken.mockClear(); });

  const post = (path: string, body = raw.toString('utf8')) => request(app.getHttpServer()).post(path)
    .set('Authorization', 'CapiroMeriRead synthetic.signed.token')
    .set('x-internal-service-secret', secret)
    .set('Content-Type', 'application/json; charset=utf-8')
    .send(body);

  it('returns 503 on all three signed targets before consuming an ordinary JTI', async () => {
    const consume = jest.spyOn(helperReceiver, 'consumeTaskBoundMemoryHelper');
    for (const path of [helperPath, pagePath, proposalPath]) {
      const response = await post(path);
      expect(response.status).toBe(503);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    expect(consume).not.toHaveBeenCalled();
    expect(admitOrdinaryToken).not.toHaveBeenCalled();
    expect(withSystem).not.toHaveBeenCalled();
    expect(gate.signedMemoryPageEnabled()).toBe(false);
    expect(gate.signedMemoryProposalEnabled()).toBe(false);
  });

  it('routes the fixed helper before tools/:name and delivers unchanged UTF-8 bytes', async () => {
    // Test-only simulated activation; no request or environment variable can
    // change the source gate. The actual receiver is replaced before any SQL.
    jest.spyOn(gate, 'signedMemoryPageEnabled').mockReturnValue(true);
    const consume = jest.spyOn(helperReceiver, 'consumeTaskBoundMemoryHelper')
      .mockResolvedValue({ syntheticMountOnly: true } as never);
    const response = await post(helperPath);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ syntheticMountOnly: true });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(consume).toHaveBeenCalledTimes(1);
    expect(consume.mock.calls[0]![2]).toEqual(raw);
    expect(consume.mock.calls[0]![1].originalUrl).toBe(helperPath);
    expect(admitOrdinaryToken).not.toHaveBeenCalled();
    expect(withSystem).not.toHaveBeenCalled();
  });
});
