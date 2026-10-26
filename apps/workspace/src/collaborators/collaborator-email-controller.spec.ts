import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { CollaboratorsModule } from './collaborators.module.js';
import { CollaboratorsService } from './collaborators.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantGuard } from '../auth/tenant.guard.js';
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
@Global()
@Module({ providers: [{ provide: PrismaService, useValue: {} }], exports: [PrismaService] })
class FixturePrismaModule {}
describe('mounted internal invitation read in actual CollaboratorsModule', () => {
  const savedSecret = process.env.INTERNAL_SERVICE_SECRET;
  const body = { tenantId: '11111111-1111-4111-8111-111111111111', draftId: '22222222-2222-4222-8222-222222222222', invitationId: '33333333-3333-4333-8333-333333333333', actorId: 'owner' };
  const context = jest.fn().mockResolvedValue({ ...body, invitation: null, reason: 'InvitationUnavailable' });
  let app: any;
  beforeAll(async () => {
    process.env.INTERNAL_SERVICE_SECRET = 'synthetic-only-service-secret';
    const module = await Test.createTestingModule({ imports: [FixturePrismaModule, CollaboratorsModule] })
      .overrideProvider(CollaboratorsService).useValue({ emailContext: context })
      .overrideGuard(TenantGuard).useValue({ canActivate: () => false }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('workspace-api'); await app.init();
  });
  afterAll(async () => { await app.close(); if (savedSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET; else process.env.INTERNAL_SERVICE_SECRET = savedSecret; });
  afterEach(() => context.mockClear());
  it('requires the real existing service-secret guard and validates exact identity', async () => {
    const route = '/workspace-api/internal/workspace/collaborator-invitations/email-context';
    await request(app.getHttpServer()).post(route).send(body).expect(401);
    await request(app.getHttpServer()).post(route).set('x-internal-service-secret', 'wrong').send(body).expect(401);
    await request(app.getHttpServer()).post(route).set('x-internal-service-secret', 'synthetic-only-service-secret').send({ ...body, tenantId: 'invalid' }).expect(400);
    expect(context).not.toHaveBeenCalled();
    await request(app.getHttpServer()).post(route).set('x-internal-service-secret', 'synthetic-only-service-secret').send(body).expect(201);
    expect(context).toHaveBeenCalledWith(body.tenantId, body.draftId, body.invitationId, body.actorId);
  });
  it('retains TenantGuard on the existing browser route', async () => {
    await request(app.getHttpServer()).get(`/workspace-api/drafts/${body.draftId}/collaborators`).set('x-internal-service-secret', 'synthetic-only-service-secret').expect(403);
    expect(context).not.toHaveBeenCalled();
  });
});
