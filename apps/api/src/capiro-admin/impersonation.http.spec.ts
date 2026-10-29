import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ImpersonationController } from './impersonation.controller.js';
import { ImpersonationService } from './impersonation.service.js';
const id = '10000000-0000-4000-8000-000000000001';
describe('HQ impersonation HTTP boundary', () => {
  let app: INestApplication, role: string;
  const service = { start: jest.fn(), read: jest.fn(), end: jest.fn() };
  beforeEach(async () => {
    role = 'capiro_admin';
    for (const method of Object.values(service))
      method.mockReset().mockResolvedValue({ sessionId: id });
    const module = await Test.createTestingModule({
      controllers: [ImpersonationController],
      providers: [{ provide: ImpersonationService, useValue: service }],
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
  it('requires start identity/reason and exact end identity; no old close-all route remains', async () => {
    await request(app.getHttpServer())
      .post('/capiro-admin/impersonate')
      .send({ tenantId: id, reason: 'Synthetic support request' })
      .expect(400);
    await request(app.getHttpServer()).post('/capiro-admin/impersonate/end').send({}).expect(400);
    await request(app.getHttpServer())
      .post('/capiro-admin/impersonate')
      .send({ requestId: id, tenantId: id, reason: 'short' })
      .expect(400);
    expect(service.start).not.toHaveBeenCalled();
    expect(service.end).not.toHaveBeenCalled();
  });
  it('routes the captured request and exact IDs to the canonical lifecycle owner', async () => {
    await request(app.getHttpServer())
      .post('/capiro-admin/impersonate')
      .send({ requestId: id, tenantId: id, reason: 'Synthetic support request' })
      .expect('Cache-Control', 'no-store')
      .expect(201);
    await request(app.getHttpServer())
      .get('/capiro-admin/impersonate/' + id)
      .expect('Cache-Control', 'no-store')
      .expect(200);
    await request(app.getHttpServer())
      .post('/capiro-admin/impersonate/end')
      .send({ sessionId: id })
      .expect('Cache-Control', 'no-store')
      .expect(201);
    expect(service.start.mock.calls[0][2]).toEqual({
      requestId: id,
      tenantId: id,
      reason: 'Synthetic support request',
    });
    expect(service.read.mock.calls[0][2]).toBe(id);
    expect(service.end.mock.calls[0][2]).toBe(id);
    expect(service.start.mock.calls[0][1].tenantContext.role).toBe('capiro_admin');
  });
  it.each(['user_admin', 'standard_user', 'basic_user'])(
    'refuses %s before any lifecycle call',
    async (actorRole) => {
      role = actorRole;
      await request(app.getHttpServer())
        .post('/capiro-admin/impersonate')
        .send({ requestId: id, tenantId: id, reason: 'Synthetic support request' })
        .expect(403);
      await request(app.getHttpServer())
        .get('/capiro-admin/impersonate/' + id)
        .expect(403);
      await request(app.getHttpServer())
        .post('/capiro-admin/impersonate/end')
        .send({ sessionId: id })
        .expect(403);
      expect(service.start).not.toHaveBeenCalled();
      expect(service.read).not.toHaveBeenCalled();
      expect(service.end).not.toHaveBeenCalled();
    },
  );
  it('refuses malformed identities and extra authority fields', async () => {
    await request(app.getHttpServer()).get('/capiro-admin/impersonate/not-a-session').expect(400);
    await request(app.getHttpServer())
      .post('/capiro-admin/impersonate/end')
      .send({ sessionId: id, actorId: id })
      .expect(400);
  });
});
