import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ClientActivityController } from './client-activity.controller.js';
import { ClientActivityService } from './client-activity.service.js';
import { ctx, fixture, IDs } from '../../test/support/activity-command.fixture.js';

describe('Quick Log details through the canonical direct activity HTTP route', () => {
  let app: INestApplication;
  let f: ReturnType<typeof fixture>;
  beforeEach(async () => {
    f = fixture();
    Object.assign(f.tx.clientActivity, { findMany: jest.fn(async () => f.activities) });
    Object.assign(f.tx, {
      meeting: { findMany: jest.fn(async () => []) },
      engagementAttachment: { findMany: jest.fn(async () => []) },
      outreachRecord: { findMany: jest.fn(async () => []) },
    });
    const service = new ClientActivityService(
      f.prisma as never,
      {
        listMailThreads: jest.fn(async () => []),
      } as never,
    );
    const module = await Test.createTestingModule({
      controllers: [ClientActivityController],
      providers: [{ provide: ClientActivityService, useValue: service }],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    app.use((req: any, _res: any, next: () => void) => {
      req.tenantContext = ctx;
      next();
    });
    await app.init();
  });
  afterEach(async () => {
    await app.close();
  });
  const path = `/api/clients/${IDs.client}/activity`;
  const input = {
    kind: 'commitment',
    title: 'Send briefing',
    direction: 'they_owe',
    counterparty: '  Client team  ',
  };

  it('persists and returns explicit fields on create and authorized list without raw metadata', async () => {
    const created = await request(app.getHttpServer()).post(path).send(input).expect(201);
    expect(created.body).toMatchObject({
      id: IDs.activity,
      direction: 'they_owe',
      counterparty: 'Client team',
      objective: null,
    });
    expect(created.body).not.toHaveProperty('metadata');
    const listed = await request(app.getHttpServer()).get(path).expect(200);
    expect(listed.body[0]).toMatchObject({
      id: IDs.activity,
      direction: 'they_owe',
      counterparty: 'Client team',
      objective: null,
      origin: 'recorded',
    });
    expect(listed.body[0]).not.toHaveProperty('metadata');
    f.state.actorWall = false;
    await request(app.getHttpServer()).get(path).expect(404);
  });
  it.each([
    { kind: 'note' },
    { direction: 'unknown' },
    { counterparty: ' ' },
    { counterparty: 'x'.repeat(301) },
    { objectiveId: IDs.task },
    { objectiveVersion: 1 },
    { objectiveId: IDs.task, objectiveVersion: 0 },
    { objectiveRevisionId: IDs.task },
    { metadata: { quickLog: {} } },
    { strategyStepId: IDs.task },
  ])('refuses malformed or unsupported direct fields %j before writes', async (change) => {
    await request(app.getHttpServer())
      .post(path)
      .send({ ...input, ...change })
      .expect(400);
    expect(f.activities).toHaveLength(0);
  });
});
