import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ActivityCommandController } from './activity-command.controller.js';
import { ActivityCommandService } from './activity-command.service.js';
import { bearer, basicInput, ctx, IDs } from '../../../test/support/activity-command.fixture.js';

describe('Core activity command HTTP boundary', () => {
  let app: INestApplication;
  const service = {
    create: jest.fn(async () => ({})),
    get: jest.fn(async () => ({})),
    resume: jest.fn(async () => ({})),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ActivityCommandController],
      providers: [{ provide: ActivityCommandService, useValue: service }],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.use((req: any, _res: any, next: () => void) => {
      if (req.headers['x-qa-auth'] === 'yes') req.tenantContext = ctx;
      next();
    });
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
  });
  const path = `/api/clients/${IDs.client}/activity-commands`;
  it('delegates one browser create through Core with the existing tenant context and bearer', async () => {
    await request(app.getHttpServer())
      .post(path)
      .set('x-qa-auth', 'yes')
      .set('Authorization', bearer)
      .send(basicInput)
      .expect(201);
    expect(service.create).toHaveBeenCalledWith(ctx, IDs.client, basicInput, bearer);
  });
  it.each(['create', 'get', 'resume'] as const)(
    'rejects impersonation before %s delegation',
    async (verb) => {
      const call =
        verb === 'get'
          ? request(app.getHttpServer()).get(`${path}/${IDs.request}`)
          : request(app.getHttpServer()).post(
              verb === 'create' ? path : `${path}/${IDs.request}/resume`,
            );
      await call
        .set('x-qa-auth', 'yes')
        .set('Authorization', bearer)
        .set('x-capiro-impersonate-tenant', IDs.tenant)
        .send({})
        .expect(403);
      expect(service[verb]).not.toHaveBeenCalled();
    },
  );
  it.each(['create', 'get', 'resume'] as const)('requires tenant context for %s', async (verb) => {
    const call =
      verb === 'get'
        ? request(app.getHttpServer()).get(`${path}/${IDs.request}`)
        : request(app.getHttpServer()).post(
            verb === 'create' ? path : `${path}/${IDs.request}/resume`,
          );
    await call.send({}).expect(403);
    expect(service[verb]).not.toHaveBeenCalled();
  });
});
