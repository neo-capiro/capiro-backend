import { BadRequestException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { NewsDashboardController } from './news-dashboard.controller.js';
import type { NewsCatcherDashboardService } from './news-catcher-dashboard.service.js';

describe('NewsDashboardController filters', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const clientId = '22222222-2222-4222-8222-222222222222';
  const ctx = { tenantId, clerkUserId: 'actor' } as TenantContext;

  it('passes normalized dashboard choices into the news service', () => {
    const news = { getDashboard: jest.fn().mockReturnValue({ available: true }) };
    const controller = new NewsDashboardController(news as unknown as NewsCatcherDashboardService);

    controller.dashboard(
      ctx,
      clientId,
      'budget,procurement',
      'program,capability',
      'Golden Dome,Counter-UAS',
      '7d',
    );

    expect(news.getDashboard).toHaveBeenCalledWith(
      tenantId,
      {
        clientIds: [clientId],
        policyTopics: ['budget', 'procurement'],
        signalKinds: ['program', 'capability'],
        customTopics: ['Golden Dome', 'Counter-UAS'],
        lookback: '7d',
      },
      'actor',
    );
  });

  it('uses the shared Data Explorer corpus when requested', () => {
    const news = { getSharedNewsDashboard: jest.fn().mockReturnValue({ available: true }) };
    const controller = new NewsDashboardController(news as unknown as NewsCatcherDashboardService);

    controller.dashboard(
      ctx,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'explorer',
      'counter UAS',
      'Politico',
      'Defense Department',
    );

    expect(news.getSharedNewsDashboard).toHaveBeenCalledWith({
      query: 'counter UAS',
      sources: ['Politico'],
      topics: undefined,
      agencies: ['Defense Department'],
      lookback: undefined,
    });
  });

  it('accepts repeated shared-corpus query parameters', () => {
    const news = { getSharedNewsDashboard: jest.fn().mockReturnValue({ available: true }) };
    const controller = new NewsDashboardController(news as unknown as NewsCatcherDashboardService);

    controller.dashboard(
      ctx,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'explorer',
      undefined,
      ['politico', 'axios'],
      ['DoD', 'Army'],
    );

    expect(news.getSharedNewsDashboard).toHaveBeenCalledWith({
      query: undefined,
      sources: ['politico', 'axios'],
      topics: undefined,
      agencies: ['DoD', 'Army'],
      lookback: undefined,
    });
  });

  it('fails closed when a client filter is not a UUID', () => {
    const news = { getDashboard: jest.fn() };
    const controller = new NewsDashboardController(news as unknown as NewsCatcherDashboardService);

    expect(() => controller.dashboard(ctx, 'not-a-client-id')).toThrow(BadRequestException);
    expect(news.getDashboard).not.toHaveBeenCalled();
  });

  it('bounds custom topics before they reach provider-query construction', () => {
    const news = { getDashboard: jest.fn().mockReturnValue({ available: true }) };
    const controller = new NewsDashboardController(news as unknown as NewsCatcherDashboardService);
    const oversized = 'x'.repeat(200);

    controller.dashboard(ctx, undefined, undefined, undefined, oversized, undefined);

    const passed = news.getDashboard.mock.calls[0]?.[1] as { customTopics?: string[] };
    expect(passed.customTopics?.[0]).toHaveLength(120);
  });
});
