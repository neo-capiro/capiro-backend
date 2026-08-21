import { IntelligenceService } from './intelligence.service.js';

/**
 * P0 regression: GET /api/intelligence/portfolio-alerts hung open on live
 * (pending forever in Chrome) because cold roll-ups serially run full
 * profile-v1 per client behind a process-wide gate. A single slow client
 * budget (20s, non-cancelling) made the HTTP request appear stuck and left
 * Needs Attention unresolved on os.capiro.ai landing.
 *
 * The request must fail open with an empty alerts payload inside a hard
 * wall-clock budget so the dashboard can paint.
 */
describe('IntelligenceService.getPortfolioAlerts request budget', () => {
  const tenantId = '00000000-0000-0000-0000-000000000001';
  const userId = 'user_test';

  const makeService = () => {
    const prisma: any = {
      withTenant: jest.fn(async (_t: string, run: (tx: any) => Promise<any>) =>
        run({
          client: {
            findMany: jest.fn(async () => [
              { id: 'c1', name: 'Slow Client' },
              { id: 'c2', name: 'Other Client' },
            ]),
          },
        }),
      ),
    };
    const service = new IntelligenceService(prisma);
    return { service, prisma };
  };

  it('fails open with empty alerts when the roll-up exceeds the request budget', async () => {
    const { service } = makeService();
    const never = new Promise(() => {
      /* intentionally never settles */
    });
    jest.spyOn(service as any, 'computePortfolioAlerts').mockReturnValue(never);

    // Keep the unit test fast: shrink the budget for this process.
    const original = (IntelligenceService as any).PORTFOLIO_ALERTS_REQUEST_BUDGET_MS;
    (IntelligenceService as any).PORTFOLIO_ALERTS_REQUEST_BUDGET_MS = 30;
    try {
      const started = Date.now();
      const result = await service.getPortfolioAlerts(tenantId, userId, { limit: 30 });
      const elapsed = Date.now() - started;

      expect(elapsed).toBeLessThan(2_000);
      expect(result).toEqual(
        expect.objectContaining({
          alerts: [],
          total: 0,
        }),
      );
      expect(Array.isArray(result.alerts)).toBe(true);
      expect(typeof result.generatedAt).toBe('string');
    } finally {
      (IntelligenceService as any).PORTFOLIO_ALERTS_REQUEST_BUDGET_MS = original;
    }
  });

  it('returns the real roll-up when compute finishes inside the budget', async () => {
    const { service } = makeService();
    const payload = {
      alerts: [
        {
          id: 'c1:a1',
          clientId: 'c1',
          clientName: 'Slow Client',
          title: 'Hearing tomorrow',
          severity: 'critical',
        },
      ],
      total: 1,
      clientCount: 2,
      generatedAt: '2026-08-21T00:00:00.000Z',
    };
    jest.spyOn(service as any, 'computePortfolioAlerts').mockResolvedValue(payload);

    const original = (IntelligenceService as any).PORTFOLIO_ALERTS_REQUEST_BUDGET_MS;
    (IntelligenceService as any).PORTFOLIO_ALERTS_REQUEST_BUDGET_MS = 5_000;
    try {
      await expect(service.getPortfolioAlerts(tenantId, userId, { limit: 30 })).resolves.toEqual(
        payload,
      );
    } finally {
      (IntelligenceService as any).PORTFOLIO_ALERTS_REQUEST_BUDGET_MS = original;
    }
  });
});
