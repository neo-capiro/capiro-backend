import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import type { TenantContext } from '@capiro/shared';
import { ClientObjectivesController } from './objectives.controller.js';
import { ClientObjectivesService } from './objectives.service.js';

const clientId = '11111111-1111-4111-8111-111111111111';
const objectiveId = '22222222-2222-4222-8222-222222222222';
const draftRequestId = '33333333-3333-4333-8333-333333333333';
const route = `/clients/${clientId}/objectives`;
const ctx: TenantContext = {
  tenantId: '44444444-4444-4444-8444-444444444444',
  tenantSlug: 'synthetic',
  userId: '55555555-5555-4555-8555-555555555555',
  clerkUserId: 'user_synthetic',
  role: 'standard_user',
};

describe('Objective HTTP validation and role boundary (synthetic trusted context)', () => {
  let app: INestApplication;
  const service = {
    list: jest.fn().mockResolvedValue([]),
    get: jest.fn().mockResolvedValue({ id: objectiveId }),
    create: jest.fn().mockResolvedValue({ id: objectiveId, status: 'draft' }),
    update: jest.fn().mockResolvedValue({ id: objectiveId, version: 2 }),
    transition: jest.fn().mockResolvedValue({ id: objectiveId, status: 'ready' }),
    remove: jest.fn().mockResolvedValue({ id: objectiveId, deleted: true }),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ClientObjectivesController],
      providers: [{ provide: ClientObjectivesService, useValue: service }],
    }).compile();
    app = module.createNestApplication();
    app.use(
      (req: Request & { tenantContext?: TenantContext }, _res: Response, next: NextFunction) => {
        // Explicit fixture injection exercises RolesGuard, not Clerk authentication.
        if (req.headers['x-test-actor'] === 'standard') req.tenantContext = ctx;
        if (req.headers['x-test-actor'] === 'portal')
          req.tenantContext = { ...ctx, role: 'client_portal_user' };
        next();
      },
    );
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('missing context and portal users are refused before service access', async () => {
    await request(app.getHttpServer()).get(route).expect(403);
    await request(app.getHttpServer()).get(route).set('x-test-actor', 'portal').expect(403);
    expect(service.list).not.toHaveBeenCalled();
  });

  test('list and optional Objective selector parse independently', async () => {
    await request(app.getHttpServer()).get(route).set('x-test-actor', 'standard').expect(200, []);
    await request(app.getHttpServer())
      .get(`${route}?objectiveId=${objectiveId}`)
      .set('x-test-actor', 'standard')
      .expect(200);
    expect(service.get).toHaveBeenCalledWith(ctx, clientId, objectiveId);
    await request(app.getHttpServer())
      .get(`${route}?objectiveId=invalid`)
      .set('x-test-actor', 'standard')
      .expect(400);
  });

  test('empty draft creation requires a UUID request ID and rejects forged authority', async () => {
    await request(app.getHttpServer())
      .post(route)
      .set('x-test-actor', 'standard')
      .send({})
      .expect(400);
    await request(app.getHttpServer())
      .post(route)
      .set('x-test-actor', 'standard')
      .send({ requestId: draftRequestId, tenantId: 'forged' })
      .expect(400);
    expect(service.create).not.toHaveBeenCalled();
    await request(app.getHttpServer())
      .post(route)
      .set('x-test-actor', 'standard')
      .send({ requestId: draftRequestId })
      .expect(201);
    expect(service.create).toHaveBeenCalledWith(
      ctx,
      clientId,
      expect.objectContaining({ requestId: draftRequestId }),
    );
  });

  test('updates reject missing versions and caller-supplied lifecycle fields', async () => {
    const selected = `${route}?objectiveId=${objectiveId}`;
    await request(app.getHttpServer())
      .patch(selected)
      .set('x-test-actor', 'standard')
      .send({ outcome: 'New' })
      .expect(400);
    await request(app.getHttpServer())
      .patch(selected)
      .set('x-test-actor', 'standard')
      .send({ expectedVersion: 1, status: 'ready' })
      .expect(400);
    expect(service.update).not.toHaveBeenCalled();
    await request(app.getHttpServer())
      .patch(selected)
      .set('x-test-actor', 'standard')
      .send({ expectedVersion: 1, outcome: 'New' })
      .expect(200);
    expect(service.update).toHaveBeenCalledWith(ctx, clientId, objectiveId, 1, { outcome: 'New' });
  });

  test('transitions expose only the agreed review/ready actions', async () => {
    const selected = `${route}/transition?objectiveId=${objectiveId}`;
    await request(app.getHttpServer())
      .post(selected)
      .set('x-test-actor', 'standard')
      .send({ expectedVersion: 1, action: 'activate_strategy' })
      .expect(400);
    expect(service.transition).not.toHaveBeenCalled();
    await request(app.getHttpServer())
      .post(selected)
      .set('x-test-actor', 'standard')
      .send({ expectedVersion: 1, action: 'confirm_ready' })
      .expect(201);
    expect(service.transition).toHaveBeenCalledWith(ctx, clientId, objectiveId, 1, 'confirm_ready');
  });
});
