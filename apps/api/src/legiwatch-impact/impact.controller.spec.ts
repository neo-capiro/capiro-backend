import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import request from 'supertest';
import { ImpactController } from './impact.controller.js';
import { ImpactService } from './impact.service.js';
import { ImpactRefreshService } from './impact-refresh.service.js';

const client = '30000000-0000-4000-8000-000000000001';
const ctx = {
  tenantId: '10000000-0000-4000-8000-000000000001',
  userId: '20000000-0000-4000-8000-000000000001',
  clerkUserId: 'synthetic',
  tenantSlug: 'fixture',
  role: 'standard_user',
} as TenantContext;
let app: INestApplication;
const list = jest.fn().mockResolvedValue({ rows: [], clients: [], total: 0 });
const detail = jest.fn().mockResolvedValue({ row: { billId: '119-hr-1' } });
const updateContext = jest
  .fn()
  .mockResolvedValue({ row: { billId: '119-hr-1', position: 'support' } });
const enqueue = jest.fn().mockResolvedValue({ refresh: { state: 'queued' } });

beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [ImpactController],
    providers: [
      { provide: ImpactService, useValue: { list, detail, updateContext } },
      { provide: ImpactRefreshService, useValue: { request: enqueue } },
    ],
  }).compile();
  app = module.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
  );
  app.use((req: any, _res: any, next: () => void) => {
    if (req.headers['x-fixture-auth'] === 'yes') req.tenantContext = ctx;
    next();
  });
  await app.init();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => jest.clearAllMocks());

it('requires current authenticated role context for every new endpoint', async () => {
  expect((await request(app.getHttpServer()).get('/api/legiwatch/tracker')).status).toBe(403);
  expect(
    (
      await request(app.getHttpServer()).get(
        `/api/legiwatch/clients/${client}/bills/119-hr-1/impact`,
      )
    ).status,
  ).toBe(403);
  expect(list).not.toHaveBeenCalled();
});
it('defaults to all authorized clients and binds tenant only from trusted context', async () => {
  const response = await request(app.getHttpServer())
    .get('/api/legiwatch/tracker?limit=10')
    .set('x-fixture-auth', 'yes');
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(list).toHaveBeenCalledWith(ctx, expect.objectContaining({ limit: 10 }));
  expect(list.mock.calls[0][1].clientId).toBeUndefined();
  expect(
    (
      await request(app.getHttpServer())
        .get('/api/legiwatch/tracker?tenantId=other')
        .set('x-fixture-auth', 'yes')
    ).status,
  ).toBe(400);
});
it('rejects invalid scope, cursor bounds, page size and analyst enums', async () => {
  for (const query of ['clientId=invalid', 'limit=51', 'limit=-1'])
    expect(
      (
        await request(app.getHttpServer())
          .get(`/api/legiwatch/tracker?${query}`)
          .set('x-fixture-auth', 'yes')
      ).status,
    ).toBe(400);
  expect(
    (
      await request(app.getHttpServer())
        .put(`/api/legiwatch/clients/${client}/bills/119-hr-1/context`)
        .set('x-fixture-auth', 'yes')
        .send({ position: 'positive' })
    ).status,
  ).toBe(400);
});
it('enqueues analysis and returns accepted without running a model in the request', async () => {
  const response = await request(app.getHttpServer())
    .post(`/api/legiwatch/clients/${client}/bills/119-hr-1/impact/analyze`)
    .set('x-fixture-auth', 'yes')
    .send({});
  expect(response.status).toBe(202);
  expect(response.body.refresh.state).toBe('queued');
  expect(enqueue).toHaveBeenCalledWith(ctx, client, '119-hr-1');
});
it('keeps analyst stance independent from impact direction', async () => {
  const response = await request(app.getHttpServer())
    .put(`/api/legiwatch/clients/${client}/bills/119-hr-1/context`)
    .set('x-fixture-auth', 'yes')
    .send({ position: 'support', priority: null });
  expect(response.status).toBe(200);
  expect(updateContext).toHaveBeenCalledWith(
    ctx,
    client,
    '119-hr-1',
    expect.objectContaining({ position: 'support', priority: null }),
  );
});
