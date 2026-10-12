import 'reflect-metadata';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { TenantGuard } from '../auth/tenant.guard.js';
import { StrategyPlannerGuard } from '../flags/strategy-planner.guard.js';
import { StrategyService } from './strategy.service.js';
import { NodeService } from './node.service.js';
import { VersionService } from './version.service.js';
import { StrategyReportService } from '../reports/strategy-report.service.js';
import { StrategyController } from './strategy.controller.js';
import { PlannerService } from '../planner/planner.service.js';
import { PlannerController } from '../planner/planner.controller.js';

const ctx: AuthTenantContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  clerkUserId: 'user_synthetic',
  role: 'standard_user',
};
const resourceId = '33333333-3333-4333-8333-333333333333';
const query = {
  clientId: '44444444-4444-4444-8444-444444444444',
  objectiveId: '55555555-5555-4555-8555-555555555555',
  objectiveVersion: 3,
};
const paths = [
  `/strategies/${resourceId}/objective-destination`,
  `/planner/tasks/${resourceId}/objective-destination`,
];

describe('Strategy/Planner Objective destination transport (synthetic identity)', () => {
  let app: INestApplication;
  let strategyEnabled = true;
  const strategies = {
    objectiveDestination: jest
      .fn()
      .mockResolvedValue({ destination: { kind: 'strategy', resourceId } }),
  };
  const planner = {
    objectiveDestination: jest
      .fn()
      .mockResolvedValue({ destination: { kind: 'planner_task', resourceId } }),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [StrategyController, PlannerController],
      providers: [
        { provide: StrategyService, useValue: strategies },
        { provide: NodeService, useValue: {} },
        { provide: VersionService, useValue: {} },
        { provide: StrategyReportService, useValue: {} },
        { provide: PlannerService, useValue: planner },
      ],
    })
      .overrideGuard(TenantGuard)
      .useValue({
        canActivate: (context: {
          switchToHttp(): { getRequest(): { tenantContext?: AuthTenantContext } };
        }) => !!context.switchToHttp().getRequest().tenantContext,
      })
      .overrideGuard(StrategyPlannerGuard)
      .useValue({ canActivate: () => strategyEnabled })
      .compile();
    app = module.createNestApplication();
    app.use(
      (
        req: Request & { tenantContext?: AuthTenantContext },
        _res: Response,
        next: NextFunction,
      ) => {
        if (req.headers['x-test-actor'] === 'synthetic') req.tenantContext = ctx;
        next();
      },
    );
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });
  afterAll(async () => app?.close());
  beforeEach(() => {
    jest.clearAllMocks();
    strategyEnabled = true;
  });

  it.each(paths)(
    'validates exact revision/resource query and uncacheable response for %s',
    async (path) => {
      const res = await request(app.getHttpServer())
        .get(path)
        .query(query)
        .set('x-test-actor', 'synthetic')
        .expect(200);
      expect(res.headers['cache-control']).toBe('private, no-store');
      const owner = path.startsWith('/strategies') ? strategies : planner;
      expect(owner.objectiveDestination).toHaveBeenCalledWith(ctx, resourceId, query);
    },
  );

  it('honors current existing tenant/Strategy feature and Planner impersonation guards', async () => {
    for (const path of paths) await request(app.getHttpServer()).get(path).query(query).expect(403);
    strategyEnabled = false;
    await request(app.getHttpServer())
      .get(paths[0]!)
      .query(query)
      .set('x-test-actor', 'synthetic')
      .expect(403);
    await request(app.getHttpServer())
      .get(paths[1]!)
      .query(query)
      .set('x-test-actor', 'synthetic')
      .set('x-capiro-impersonate-tenant', ctx.tenantId)
      .expect(403);
    expect(strategies.objectiveDestination).not.toHaveBeenCalled();
    expect(planner.objectiveDestination).not.toHaveBeenCalled();
  });

  it.each(['clientId', 'objectiveId', 'objectiveVersion'])(
    'rejects missing %s for both owner kinds',
    async (field) => {
      const partial = { ...query } as Record<string, unknown>;
      delete partial[field];
      for (const path of paths)
        await request(app.getHttpServer())
          .get(path)
          .query(partial)
          .set('x-test-actor', 'synthetic')
          .expect(400);
    },
  );

  it.each(['0', '-1', '1.5', '2147483648', 'Infinity', 'x', ''])(
    'rejects unbounded objectiveVersion %s',
    async (objectiveVersion) => {
      for (const path of paths)
        await request(app.getHttpServer())
          .get(path)
          .query({ ...query, objectiveVersion })
          .set('x-test-actor', 'synthetic')
          .expect(400);
    },
  );

  it('rejects arbitrary destination kind, URL, actor, tenant and revision claims', async () => {
    for (const extra of [
      { kind: 'workspace' },
      { resourceId },
      { url: 'https://foreign.invalid' },
      { userId: ctx.clerkUserId },
      { tenantId: ctx.tenantId },
      { objectiveRevisionId: resourceId },
    ]) {
      for (const path of paths)
        await request(app.getHttpServer())
          .get(path)
          .query({ ...query, ...extra })
          .set('x-test-actor', 'synthetic')
          .expect(400);
    }
    expect(strategies.objectiveDestination).not.toHaveBeenCalled();
    expect(planner.objectiveDestination).not.toHaveBeenCalled();
  });
});
