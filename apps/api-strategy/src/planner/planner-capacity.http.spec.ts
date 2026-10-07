import { Test } from '@nestjs/testing';
import type { INestApplication, ExecutionContext } from '@nestjs/common';
import request from 'supertest';
import { PlannerCapacityController } from './planner-capacity.controller.js';
import { PlannerCapacityService } from './planner-capacity.service.js';
import { TenantGuard } from '../auth/tenant.guard.js';
const id = '80000000-0000-4000-8000-000000000001',
  ctx = {
    tenantId: '10000000-0000-4000-8000-000000000045',
    clerkUserId: 'member',
    role: 'org:member',
  };
describe('Strategies capacity routes', () => {
  let app: INestApplication;
  const service = {
    catalog: jest.fn(async () => ({ plans: [], teams: [], placeholders: [] })),
    plan: jest.fn(async () => ({ allocations: [] })),
    saveRecord: jest.fn(async () => ({ id })),
    saveAllocations: jest.fn(async () => ({ allocations: [] })),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [PlannerCapacityController],
      providers: [{ provide: PlannerCapacityService, useValue: service }],
    })
      .overrideGuard(TenantGuard)
      .useValue({
        canActivate(c: ExecutionContext) {
          const req = c.switchToHttp().getRequest();
          if (req.headers['x-qa'] !== 'allowed') return false;
          req.tenantContext = ctx;
          return true;
        },
      })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('strategy-api');
    await app.init();
  });
  afterAll(async () => app?.close());
  it.each([
    ['get', ''],
    ['get', `/plans/${id}`],
    ['post', '/plans'],
    ['post', '/teams'],
    ['post', '/placeholders'],
    ['post', '/allocations'],
  ])('requires signed-in tenant authentication on %s %s', async (method, path) => {
    await (request(app.getHttpServer()) as any)
      [method]('/strategy-api/planner/capacity' + path)
      .expect(403);
  });
  it.each(['/plans', '/teams', '/placeholders', '/allocations'])(
    'rejects impersonated writes to %s',
    async (path) => {
      await request(app.getHttpServer())
        .post('/strategy-api/planner/capacity' + path)
        .set('x-qa', 'allowed')
        .set('x-capiro-impersonate-tenant', 'other')
        .send({})
        .expect(403);
    },
  );
  it('forwards captured revision and preserves the signed-in organization', async () => {
    const query = { revision: 'a'.repeat(64), cursor: id, archived: 'true' };
    await request(app.getHttpServer())
      .get(`/strategy-api/planner/capacity/plans/${id}`)
      .set('x-qa', 'allowed')
      .query(query)
      .expect(200);
    expect(service.plan).toHaveBeenLastCalledWith(ctx, id, query);
  });
  it.each([
    ['plans', 'capacity_plan'],
    ['teams', 'capacity_team'],
    ['placeholders', 'capacity_placeholder'],
  ])('uses dedicated %s validation instead of generic resources', async (path, kind) => {
    const body = { id, name: 'Planner staffing', data: {} };
    await request(app.getHttpServer())
      .post('/strategy-api/planner/capacity/' + path)
      .set('x-qa', 'allowed')
      .send(body)
      .expect(201);
    expect(service.saveRecord).toHaveBeenLastCalledWith(ctx, kind, body);
  });
});
