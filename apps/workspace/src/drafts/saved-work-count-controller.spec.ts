import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DraftsController } from './drafts.controller.js';
import { DraftsService } from './drafts.service.js';
import { TenantGuard } from '../auth/tenant.guard.js';
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));

describe('saved-work-count authenticated fixed route', () => {
  const count = jest.fn().mockResolvedValue({ count: 0, complete: true, capped: false });
  const byId = jest.fn();
  let app: any, allowed = true;
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [DraftsController],
      providers: [{ provide: DraftsService, useValue: { savedWorkCount: count, byId } }] })
      .overrideGuard(TenantGuard).useValue({ canActivate: (context: any) => {
        context.switchToHttp().getRequest().tenantContext = { tenantId: 'trusted-tenant', clerkUserId: 'trusted-actor' };
        return allowed;
      } }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('workspace-api');
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  });
  afterAll(async () => { await app.close(); });
  afterEach(() => { count.mockClear(); byId.mockClear(); allowed = true; });
  it('routes before :id, forwards trusted scope and forbids caching', async () => {
    await request(app.getHttpServer()).get('/workspace-api/drafts/saved-work-count').expect(200).expect('Cache-Control', 'no-store');
    expect(count).toHaveBeenCalledWith('trusted-tenant', 'trusted-actor', {}); expect(byId).not.toHaveBeenCalled();
  });
  it('forwards the exact client query', async () => {
    const clientId = '22222222-2222-4222-8222-222222222222';
    await request(app.getHttpServer()).get('/workspace-api/drafts/saved-work-count').query({ clientId }).expect(200);
    expect(count).toHaveBeenCalledWith('trusted-tenant', 'trusted-actor', { clientId });
  });
  it.each([{ clientId: 'Acme' }, { tenantId: 'forged' }, { actorId: 'forged' }, { limit: '1' }])('rejects invalid/extra filters %j', async query => {
    await request(app.getHttpServer()).get('/workspace-api/drafts/saved-work-count').query(query).expect(400);
    expect(count).not.toHaveBeenCalled();
  });
  it('retains the existing TenantGuard', async () => {
    allowed = false;
    await request(app.getHttpServer()).get('/workspace-api/drafts/saved-work-count').expect(403);
    expect(count).not.toHaveBeenCalled();
  });
});
