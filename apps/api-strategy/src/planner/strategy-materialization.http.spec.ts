import { Test } from '@nestjs/testing';
import type { ExecutionContext, INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PlannerController } from './planner.controller.js';
import { PlannerService } from './planner.service.js';
import { TenantGuard } from '../auth/tenant.guard.js';
import { StrategyFlagsService } from '../flags/strategy-flags.service.js';
import {
  parseMaterialization,
  materializationError,
  materializationUuid,
} from './strategy-materialization.js';

const ID = '10000000-0000-4000-8000-000000000001';
const ctx = { tenantId: ID, clerkUserId: 'user_http_fixture', role: 'standard_user' };
const input = {
  requestId: ID,
  generationJobId: ID,
  expected: { strategyId: ID, strategyVersionId: ID, objectiveRevisionId: ID },
};
describe('Planner materialization exact routes and existing guards', () => {
  let app: INestApplication;
  const flags = { isEnabled: jest.fn(async () => true) };
  const planner = {
    prepareStrategyPlan: jest.fn(async (_ctx: unknown, raw: unknown) => ({
      requestId: parseMaterialization(raw).requestId,
    })),
    strategyMaterialization: jest.fn(async (_ctx: unknown, id: string) => {
      materializationUuid(id);
      materializationError('MATERIALIZATION_NOT_AVAILABLE', id);
    }),
    bootstrap: jest.fn(async () => ({ projects: [] })),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [PlannerController],
      providers: [
        { provide: PlannerService, useValue: planner },
        { provide: StrategyFlagsService, useValue: flags },
      ],
    })
      .overrideGuard(TenantGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const req = context.switchToHttp().getRequest();
          if (req.headers['x-fixture-auth'] !== 'yes') return false;
          req.tenantContext = ctx;
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('strategy-api');
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    flags.isEnabled.mockResolvedValue(true);
    planner.prepareStrategyPlan.mockClear();
    planner.strategyMaterialization.mockClear();
  });
  test('POST exact command forwards authenticated scope and private/no-store', async () => {
    const response = await request(app.getHttpServer())
      .post('/strategy-api/planner/strategy-materializations')
      .set('x-fixture-auth', 'yes')
      .send(input)
      .expect(201);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(planner.prepareStrategyPlan).toHaveBeenCalledWith(ctx, input);
  });
  test('GET missing receipt remains typed unconfirmed, private/no-store', async () => {
    const response = await request(app.getHttpServer())
      .get('/strategy-api/planner/strategy-materializations/' + ID)
      .set('x-fixture-auth', 'yes')
      .expect(404);
    expect(response.body).toEqual({
      httpStatus: 404,
      code: 'MATERIALIZATION_NOT_AVAILABLE',
      requestId: ID,
      message: 'This plan preparation request is not currently available.',
      outcome: 'unconfirmed',
      recordedAttempt: null,
      issues: [],
    });
    expect(response.headers['cache-control']).toBe('private, no-store');
  });
  test.each(['post', 'get'])('%s keeps authentication and impersonation refusal', async (verb) => {
    const url =
      '/strategy-api/planner/strategy-materializations' + (verb === 'get' ? '/' + ID : '');
    await (request(app.getHttpServer()) as any)[verb](url).send(input).expect(403);
    await (request(app.getHttpServer()) as any)
      [verb](url)
      .set('x-fixture-auth', 'yes')
      .set('x-capiro-impersonate-tenant', ID)
      .send(input)
      .expect(403);
    expect(planner.prepareStrategyPlan).not.toHaveBeenCalled();
    expect(planner.strategyMaterialization).not.toHaveBeenCalled();
  });
  test.each(['post', 'get'])(
    '%s requires Strategy rollout without gating ordinary Planner',
    async (verb) => {
      flags.isEnabled.mockResolvedValue(false);
      const url =
        '/strategy-api/planner/strategy-materializations' + (verb === 'get' ? '/' + ID : '');
      await (request(app.getHttpServer()) as any)
        [verb](url)
        .set('x-fixture-auth', 'yes')
        .send(input)
        .expect(403);
      await request(app.getHttpServer())
        .get('/strategy-api/planner/bootstrap')
        .set('x-fixture-auth', 'yes')
        .expect(200);
    },
  );
  test.each(['x-capiro-expected-tenant-id', 'x-capiro-expected-actor-id'])(
    'scope header %s only narrows authority',
    async (header) => {
      for (const verb of ['get', 'post']) {
        const url =
          '/strategy-api/planner/strategy-materializations' + (verb === 'get' ? '/' + ID : '');
        await (request(app.getHttpServer()) as any)
          [verb](url)
          .set('x-fixture-auth', 'yes')
          .set(header, 'other')
          .send(input)
          .expect(403);
      }
      expect(planner.prepareStrategyPlan).not.toHaveBeenCalled();
      expect(planner.strategyMaterialization).not.toHaveBeenCalled();
    },
  );
  test('malformed input and UUID retain fixed safe error body', async () => {
    const response = await request(app.getHttpServer())
      .post('/strategy-api/planner/strategy-materializations')
      .set('x-fixture-auth', 'yes')
      .send({ ...input, activate: true })
      .expect(400);
    expect(response.body.code).toBe('MATERIALIZATION_INPUT_INVALID');
    expect(response.body.outcome).toBe('unconfirmed');
    await request(app.getHttpServer())
      .get('/strategy-api/planner/strategy-materializations/invalid')
      .set('x-fixture-auth', 'yes')
      .expect(400);
  });
});
