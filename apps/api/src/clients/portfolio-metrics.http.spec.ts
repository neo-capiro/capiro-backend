import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ClientsController } from './clients.controller.js';
import { ClientsService } from './clients.service.js';
import { PreviewNativeReadService } from '../auth/preview-native-read.service.js';

describe('portfolio metrics HTTP boundary', () => {
  let app: INestApplication;
  const service = { metrics: jest.fn(async (ctx) => ({ tenantId: ctx.tenantId })), get: jest.fn() };
  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      controllers: [ClientsController],
      providers: [
        { provide: ClientsService, useValue: service },
        { provide: PreviewNativeReadService, useValue: {} },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.use((req: any, _res: any, next: () => void) => {
      if (req.headers['x-synthetic-role'])
        req.tenantContext = {
          tenantId: '10000000-0000-4000-8000-000000000001',
          role: req.headers['x-synthetic-role'],
        };
      next();
    });
    await app.init();
  });
  afterEach(async () => {
    await app.close();
  });
  it('routes metrics before client ID and makes the response uncacheable', async () => {
    await request(app.getHttpServer())
      .get('/api/clients/metrics')
      .set('x-synthetic-role', 'standard_user')
      .expect(200)
      .expect('Cache-Control', 'no-store');
    expect(service.metrics).toHaveBeenCalledTimes(1);
    expect(service.get).not.toHaveBeenCalled();
  });
  it.each([undefined, 'client_portal_user', 'unknown'])(
    'rejects unauthorized role %s',
    async (role) => {
      const req = request(app.getHttpServer()).get('/api/clients/metrics');
      if (role) req.set('x-synthetic-role', role);
      await req.expect(403);
      expect(service.metrics).not.toHaveBeenCalled();
    },
  );
});
