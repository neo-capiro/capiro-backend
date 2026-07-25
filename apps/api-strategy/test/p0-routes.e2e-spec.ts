import { describe, expect, test, beforeAll, afterAll, jest } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { AgentsController } from '../src/agents/agents.controller.js';
import { StrategyController } from '../src/strategy/strategy.controller.js';
import { MissionsService } from '../src/agents/missions.service.js';
import { RunsService } from '../src/agents/runs.service.js';
import { ChangeSetsService } from '../src/agents/change-sets.service.js';
import { WatcherService } from '../src/agents/watcher.service.js';
import { ExecutionService } from '../src/agents/execution.service.js';
import { RunReconcilerService } from '../src/agents/run-reconciler.service.js';
import { StrategyService } from '../src/strategy/strategy.service.js';
import { NodeService } from '../src/strategy/node.service.js';
import { VersionService } from '../src/strategy/version.service.js';
import { TenantGuard } from '../src/auth/tenant.guard.js';
import { StrategyPlannerGuard } from '../src/flags/strategy-planner.guard.js';
import { AgenticGuard } from '../src/flags/agentic.guard.js';
import { ExecutionAgentGuard } from '../src/flags/execution-agent.guard.js';
import { StrategyWatcherGuard } from '../src/flags/strategy-watcher.guard.js';
import { ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

/*
 * P0-1/P0-2/P0-3 route-wiring e2e (gap found by QA: every existing test for
 * these endpoints is service-level over a fake tx; nothing exercises the actual
 * Nest HTTP pipeline — route registration, guard order, DTO validation).
 *
 * All FIVE guards a route in this controller can carry are stubbed to allow +
 * inject a fixed req.tenantContext (mirrors TenantGuard's real contract).
 * Every service the controllers inject is a jest mock — no Prisma, no DB. This
 * proves the wiring (paths resolve, the right method fires, class-validator
 * actually rejects malformed input) without re-testing business logic already
 * covered by the service-level specs.
 */

const TENANT_CTX = { tenantId: 't-1', clerkUserId: 'u-1', role: 'admin' };

function allowGuard() {
  return {
    canActivate: (ctx: import('@nestjs/common').ExecutionContext) => {
      const req = ctx.switchToHttp().getRequest<Request & { tenantContext?: unknown }>();
      req.tenantContext = TENANT_CTX;
      return true;
    },
  };
}

describe('P0 route wiring (e2e)', () => {
  let app: INestApplication;
  type Async = (...args: unknown[]) => Promise<unknown>;
  const fn = () => jest.fn<Async>();
  const runs = {
    get: fn(),
    transition: fn(),
    retry: fn(),
    markFailed: fn(),
    policyFor: fn(),
    listAttempts: fn(),
    listFirmReview: fn(),
    listForMission: fn(),
    createRun: fn(),
  };
  const execution = {
    listRuns: fn(),
    plan: fn(),
    execute: fn(),
    resume: fn(),
    cancel: fn(),
    approvalStatus: fn(),
    approve: fn(),
    rejectApproval: fn(),
  };
  const reconciler = {
    reconcileRun: fn(),
    resolveReservation: fn(),
    listDuplicateArtifactRefs: fn(),
  };
  const versions = {
    list: fn(),
    restore: fn(),
    restoreImpact: fn(),
    listDetached: fn(),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AgentsController, StrategyController],
      providers: [
        { provide: MissionsService, useValue: {} },
        { provide: RunsService, useValue: runs },
        { provide: ChangeSetsService, useValue: {} },
        { provide: WatcherService, useValue: {} },
        { provide: ExecutionService, useValue: execution },
        { provide: RunReconcilerService, useValue: reconciler },
        { provide: StrategyService, useValue: {} },
        { provide: NodeService, useValue: {} },
        { provide: VersionService, useValue: versions },
      ],
    })
      .overrideGuard(TenantGuard)
      .useValue(allowGuard())
      .overrideGuard(StrategyPlannerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AgenticGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ExecutionAgentGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(StrategyWatcherGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('strategy-api');
    // Same pipe config as main.ts — the DTO-rejection assertions are only
    // meaningful if this matches production exactly.
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

  // ---- P0-1 ------------------------------------------------------------------

  test('GET /strategy-api/strategies/:id/versions/:versionId/restore-impact routes to VersionService.restoreImpact', async () => {
    versions.restoreImpact.mockResolvedValueOnce({ noOp: false });
    const res = await request(app.getHttpServer()).get(
      '/strategy-api/strategies/S1/versions/V1/restore-impact',
    );
    expect(res.status).toBe(200);
    expect(versions.restoreImpact).toHaveBeenCalledWith('t-1', 'S1', 'V1');
  });

  test('GET /strategy-api/strategies/:id/detached routes to VersionService.listDetached', async () => {
    versions.listDetached.mockResolvedValueOnce({ nodes: [], artifacts: [] });
    const res = await request(app.getHttpServer()).get('/strategy-api/strategies/S1/detached');
    expect(res.status).toBe(200);
    expect(versions.listDetached).toHaveBeenCalledWith('t-1', 'S1');
  });

  test('POST /strategy-api/strategies/:id/versions/:versionId/restore routes to VersionService.restore with the caller identity', async () => {
    versions.restore.mockResolvedValueOnce({ id: 'S1' });
    const res = await request(app.getHttpServer()).post(
      '/strategy-api/strategies/S1/versions/V1/restore',
    );
    expect(res.status).toBe(201);
    expect(versions.restore).toHaveBeenCalledWith('t-1', 'u-1', 'S1', 'V1');
  });

  // ---- P0-2 --------------------------------------------------------------------

  test('POST /strategy-api/agents/execution/runs/:id/cancel routes to ExecutionService.cancel (was dead code with no route before P0-2)', async () => {
    execution.cancel.mockResolvedValueOnce({ id: 'R1', state: 'canceled' });
    const res = await request(app.getHttpServer()).post(
      '/strategy-api/agents/execution/runs/R1/cancel',
    );
    expect(res.status).toBe(201);
    expect(execution.cancel).toHaveBeenCalledWith('t-1', 'u-1', 'R1');
  });

  test('POST /strategy-api/agents/execution/runs/:id/retry routes to RunsService.retry', async () => {
    runs.retry.mockResolvedValueOnce({ id: 'R2', state: 'queued', attempt: 2 });
    const res = await request(app.getHttpServer()).post(
      '/strategy-api/agents/execution/runs/R1/retry',
    );
    expect(res.status).toBe(201);
    expect(runs.retry).toHaveBeenCalledWith('t-1', 'u-1', 'R1');
  });

  test('POST /strategy-api/agents/execution/runs/:id/mark-failed accepts an optional reason', async () => {
    runs.markFailed.mockResolvedValueOnce({ id: 'R1', state: 'failed_terminal' });
    const res = await request(app.getHttpServer())
      .post('/strategy-api/agents/execution/runs/R1/mark-failed')
      .send({ reason: 'gave up' });
    expect(res.status).toBe(201);
    expect(runs.markFailed).toHaveBeenCalledWith('t-1', 'u-1', 'R1', 'gave up');
  });

  test('POST /strategy-api/agents/execution/runs/:id/mark-failed works with NO body at all', async () => {
    runs.markFailed.mockResolvedValueOnce({ id: 'R1', state: 'failed_terminal' });
    const res = await request(app.getHttpServer()).post(
      '/strategy-api/agents/execution/runs/R1/mark-failed',
    );
    expect(res.status).toBe(201);
    expect(runs.markFailed).toHaveBeenCalledWith('t-1', 'u-1', 'R1', undefined);
  });

  test('POST /strategy-api/agents/execution/runs/:id/reconcile routes to RunReconcilerService.reconcileRun', async () => {
    reconciler.reconcileRun.mockResolvedValueOnce({ runId: 'R1', findings: [], applied: null, needsHuman: false });
    const res = await request(app.getHttpServer()).post(
      '/strategy-api/agents/execution/runs/R1/reconcile',
    );
    expect(res.status).toBe(201);
    expect(reconciler.reconcileRun).toHaveBeenCalledWith('t-1', 'u-1', 'R1');
  });

  test('GET /strategy-api/agents/execution/runs/:id/policy routes to RunsService.policyFor', async () => {
    runs.policyFor.mockResolvedValueOnce({ runId: 'R1', actions: ['cancel'] });
    const res = await request(app.getHttpServer()).get(
      '/strategy-api/agents/execution/runs/R1/policy',
    );
    expect(res.status).toBe(200);
    expect(runs.policyFor).toHaveBeenCalledWith('t-1', 'R1');
  });

  test('GET /strategy-api/agents/execution/runs/:id/attempts routes to RunsService.listAttempts', async () => {
    runs.listAttempts.mockResolvedValueOnce([]);
    const res = await request(app.getHttpServer()).get(
      '/strategy-api/agents/execution/runs/R1/attempts',
    );
    expect(res.status).toBe(200);
    expect(runs.listAttempts).toHaveBeenCalledWith('t-1', 'R1');
  });

  test('POST /strategy-api/agents/execution/runs/:id/resolve-reservation validates action is adopt|release', async () => {
    const bad = await request(app.getHttpServer())
      .post('/strategy-api/agents/execution/runs/R1/resolve-reservation')
      .send({ action: 'delete-everything' });
    expect(bad.status).toBe(400);
    expect(reconciler.resolveReservation).not.toHaveBeenCalled();

    reconciler.resolveReservation.mockResolvedValueOnce({ runId: 'R1', action: 'release' });
    const good = await request(app.getHttpServer())
      .post('/strategy-api/agents/execution/runs/R1/resolve-reservation')
      .send({ action: 'release' });
    expect(good.status).toBe(201);
    expect(reconciler.resolveReservation).toHaveBeenCalledWith('t-1', 'u-1', 'R1', {
      action: 'release',
      artifactRef: undefined,
    });
  });

  test('GET /strategy-api/agents/execution/duplicate-artifacts is registered before /agents/execution/runs/:id-style patterns cannot swallow it', async () => {
    reconciler.listDuplicateArtifactRefs.mockResolvedValueOnce([]);
    const res = await request(app.getHttpServer()).get(
      '/strategy-api/agents/execution/duplicate-artifacts',
    );
    expect(res.status).toBe(200);
    expect(reconciler.listDuplicateArtifactRefs).toHaveBeenCalledWith('t-1', undefined);
  });

  // ---- P0-3 --------------------------------------------------------------------

  test('GET /strategy-api/agents/execution/runs/:id/approval routes to ExecutionService.approvalStatus', async () => {
    execution.approvalStatus.mockResolvedValueOnce({ runId: 'R1', action: 'stage' });
    const res = await request(app.getHttpServer()).get(
      '/strategy-api/agents/execution/runs/R1/approval',
    );
    expect(res.status).toBe(200);
    expect(execution.approvalStatus).toHaveBeenCalledWith('t-1', 'R1');
  });

  test('POST /strategy-api/agents/execution/runs/:id/approve REJECTS a request with no contentHash (whitelist strips it, service 400s on empty)', async () => {
    const res = await request(app.getHttpServer())
      .post('/strategy-api/agents/execution/runs/R1/approve')
      .send({});
    // class-validator: contentHash is @IsString() with no @IsOptional — missing
    // required field fails validation before the controller method ever runs.
    expect(res.status).toBe(400);
    expect(execution.approve).not.toHaveBeenCalled();
  });

  test('POST /strategy-api/agents/execution/runs/:id/approve REJECTS an oversized contentHash (MaxLength 128)', async () => {
    const res = await request(app.getHttpServer())
      .post('/strategy-api/agents/execution/runs/R1/approve')
      .send({ contentHash: 'a'.repeat(129) });
    expect(res.status).toBe(400);
    expect(execution.approve).not.toHaveBeenCalled();
  });

  test('POST /strategy-api/agents/execution/runs/:id/approve REJECTS unknown extra fields (forbidNonWhitelisted)', async () => {
    const res = await request(app.getHttpServer())
      .post('/strategy-api/agents/execution/runs/R1/approve')
      .send({ contentHash: 'a'.repeat(64), sneaky: 'field' });
    expect(res.status).toBe(400);
    expect(execution.approve).not.toHaveBeenCalled();
  });

  test('POST /strategy-api/agents/execution/runs/:id/approve with a valid hash calls approve with the caller identity', async () => {
    execution.approve.mockResolvedValueOnce({ runId: 'R1', approvalValid: true });
    const hash = 'a'.repeat(64);
    const res = await request(app.getHttpServer())
      .post('/strategy-api/agents/execution/runs/R1/approve')
      .send({ contentHash: hash });
    expect(res.status).toBe(201);
    expect(execution.approve).toHaveBeenCalledWith('t-1', 'u-1', 'R1', { contentHash: hash });
  });

  test('POST /strategy-api/agents/execution/runs/:id/reject-approval works with and without a reason', async () => {
    execution.rejectApproval.mockResolvedValue({ id: 'R1' });
    const withReason = await request(app.getHttpServer())
      .post('/strategy-api/agents/execution/runs/R1/reject-approval')
      .send({ reason: 'bad recipient' });
    expect(withReason.status).toBe(201);
    expect(execution.rejectApproval).toHaveBeenCalledWith('t-1', 'u-1', 'R1', 'bad recipient');

    const withoutReason = await request(app.getHttpServer()).post(
      '/strategy-api/agents/execution/runs/R1/reject-approval',
    );
    expect(withoutReason.status).toBe(201);
    expect(execution.rejectApproval).toHaveBeenCalledWith('t-1', 'u-1', 'R1', undefined);
  });

  // ---- cross-cutting: guard order actually runs -------------------------------

  test('a request that fails TenantGuard never reaches the controller (guard order sanity)', async () => {
    // Rebuild a second app with TenantGuard denying, to prove the guard is truly
    // in the chain rather than the other four coincidentally passing everything.
    const denyModuleRef = await Test.createTestingModule({
      controllers: [AgentsController],
      providers: [
        { provide: MissionsService, useValue: {} },
        { provide: RunsService, useValue: runs },
        { provide: ChangeSetsService, useValue: {} },
        { provide: WatcherService, useValue: {} },
        { provide: ExecutionService, useValue: execution },
        { provide: RunReconcilerService, useValue: reconciler },
      ],
    })
      .overrideGuard(TenantGuard)
      .useValue({ canActivate: () => false })
      .overrideGuard(StrategyPlannerGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AgenticGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(ExecutionAgentGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(StrategyWatcherGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const denyApp = denyModuleRef.createNestApplication();
    denyApp.setGlobalPrefix('strategy-api');
    await denyApp.init();

    execution.cancel.mockClear(); // isolate from the earlier passing 'cancel' test
    const res = await request(denyApp.getHttpServer()).post(
      '/strategy-api/agents/execution/runs/R1/cancel',
    );
    expect(res.status).toBe(403);
    expect(execution.cancel).not.toHaveBeenCalled();
    await denyApp.close();
  });
});
