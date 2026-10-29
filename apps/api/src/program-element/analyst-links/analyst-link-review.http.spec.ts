import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AnalystLinkReviewController } from './analyst-link-review.controller.js';
import { AnalystLinkReviewService } from './analyst-link-review.service.js';
const id = '10000000-0000-4000-8000-000000000001';
describe('HQ analyst source-review HTTP boundary', () => {
  let app: INestApplication, role: string;
  const service = { list: jest.fn(), detail: jest.fn(), receipt: jest.fn(), decide: jest.fn() };
  const body = {
    requestId: id,
    expectedVersion: 'a'.repeat(64),
    decision: 'accept',
    reason: 'Synthetic source checked',
  };
  beforeEach(async () => {
    role = 'capiro_admin';
    for (const fn of Object.values(service)) fn.mockReset().mockResolvedValue({ schemaVersion: 1 });
    const module = await Test.createTestingModule({
      controllers: [AnalystLinkReviewController],
      providers: [{ provide: AnalystLinkReviewService, useValue: service }],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    app.use((req: any, _res: any, next: () => void) => {
      req.tenantContext = { role, userId: id, tenantId: id, clerkUserId: 'synthetic' };
      next();
    });
    await app.init();
  });
  afterEach(async () => {
    await app.close();
  });
  it.each(['provision', 'sam'])(
    'routes exact %s identities, evidence versions and no-store reads',
    async (kind) => {
      const path = '/capiro-admin/analyst-links/' + kind;
      await request(app.getHttpServer())
        .get(path + '?page=2&limit=5&status=accepted')
        .expect('Cache-Control', 'no-store')
        .expect(200);
      expect(service.list.mock.calls[0][3]).toMatchObject({
        page: 2,
        limit: 5,
        status: 'accepted',
      });
      await request(app.getHttpServer())
        .get(path + '/' + id)
        .expect(200);
      await request(app.getHttpServer())
        .post(path + '/' + id + '/decision')
        .send(body)
        .expect('Cache-Control', 'no-store')
        .expect(201);
      expect(service.decide.mock.calls[0].slice(2)).toEqual([kind, id, body]);
      await request(app.getHttpServer())
        .get('/capiro-admin/analyst-links/receipts/' + id)
        .expect(200);
      expect(service.receipt.mock.calls[0][2]).toBe(id);
    },
  );
  it.each(['user_admin', 'standard_user', 'basic_user'])(
    'refuses %s before source access',
    async (value) => {
      role = value;
      for (const kind of ['provision', 'sam']) {
        await request(app.getHttpServer())
          .get('/capiro-admin/analyst-links/' + kind)
          .expect(403);
        await request(app.getHttpServer())
          .post('/capiro-admin/analyst-links/' + kind + '/' + id + '/decision')
          .send(body)
          .expect(403);
      }
      for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
    },
  );
  it('rejects missing version, forged actor, malformed identity and unbounded pagination', async () => {
    const path = '/capiro-admin/analyst-links/sam/' + id + '/decision';
    await request(app.getHttpServer())
      .post(path)
      .send({ ...body, expectedVersion: undefined })
      .expect(400);
    await request(app.getHttpServer())
      .post(path)
      .send({ ...body, actorId: id })
      .expect(400);
    await request(app.getHttpServer()).get('/capiro-admin/analyst-links/sam/no-id').expect(400);
    await request(app.getHttpServer()).get('/capiro-admin/analyst-links/sam?limit=101').expect(400);
    expect(service.decide).not.toHaveBeenCalled();
  });
});
