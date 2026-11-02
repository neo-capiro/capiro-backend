import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { TenantContext } from '@capiro/shared';
import { RolesGuard } from '../auth/roles.guard.js';
import { LegiWatchAnalyticsController } from './legiwatch-analytics.controller.js';
import { LegiWatchAnalyticsService } from './legiwatch-analytics.service.js';

describe('LegiWatch analytics after digest retirement', () => {
  let app: INestApplication;
  const context: TenantContext = {
    tenantId: 'analytics-test-tenant',
    tenantSlug: 'analytics-test',
    userId: 'analytics-test-user',
    clerkUserId: 'analytics-test-user',
    role: 'standard_user',
  };
  const summary = jest.fn().mockResolvedValue({ signalsTotal: 7 });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [LegiWatchAnalyticsController],
      providers: [{ provide: LegiWatchAnalyticsService, useValue: { summary } }],
    })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.use((req: { tenantContext?: TenantContext }, _res: unknown, next: () => void) => {
      req.tenantContext = context;
      next();
    });
    await app.init();
  });

  afterAll(async () => app?.close());

  it('keeps analytics mounted with its current tenant and selected client', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/legiwatch/live-hearings/analytics/summary')
      .query({ clientId: 'client-a', from: '2026-10-01', to: '2026-10-31' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ signalsTotal: 7 });
    expect(summary).toHaveBeenCalledWith(context, 'client-a', '2026-10-01', '2026-10-31');
  });

  it.each([
    ['post', 'digest/generate'],
    ['get', 'digest/history'],
    ['get', 'digest/schedule/config'],
    ['put', 'digest/schedule/config'],
    ['get', 'digest/retired-run'],
  ] as const)('does not expose the removed %s %s route', async (method, path) => {
    const response = await request(app.getHttpServer())[method](
      `/api/legiwatch/live-hearings/${path}`,
    );
    expect(response.status).toBe(404);
  });
});
