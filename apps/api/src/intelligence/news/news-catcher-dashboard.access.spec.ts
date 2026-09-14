import { NewsCatcherDashboardService } from './news-catcher-dashboard.service.js';

describe('News dashboard authorization-sensitive cache', () => {
  const value = { items: [], generatedAt: '2026-09-14T00:00:00Z', cached: false };
  test('denies unavailable client selection before assembling a provider query', async () => {
    const service = new NewsCatcherDashboardService({} as never),
      compute = jest.spyOn(service as any, 'computeDashboard').mockResolvedValue(value);
    jest.spyOn(service, 'allowedNewsClients').mockResolvedValue([{ id: 'public', revision: '1' }]);
    await expect(
      service.getDashboard('tenant', { clientIds: ['private'] }, 'actor'),
    ).rejects.toThrow('NEWS_CLIENT_UNAVAILABLE');
    expect(compute).not.toHaveBeenCalled();
  });
  test('isolates cache entries by actor and rechecks membership on every read', async () => {
    const service = new NewsCatcherDashboardService({} as never),
      compute = jest.spyOn(service as any, 'computeDashboard').mockResolvedValue(value);
    const allowed = jest
      .spyOn(service, 'allowedNewsClients')
      .mockResolvedValue([{ id: 'client', revision: '1' }]);
    await service.getDashboard('tenant', {}, 'first');
    await service.getDashboard('tenant', {}, 'second');
    expect(compute).toHaveBeenCalledTimes(2);
    expect((await service.getDashboard('tenant', {}, 'first')).cached).toBe(true);
    allowed.mockResolvedValue([]);
    expect((await service.getDashboard('tenant', {}, 'first')).reason).toBe('no_clients');
    expect(compute).toHaveBeenCalledTimes(2);
  });
  test('revocation while requests are coalesced denies both callers', async () => {
    const service = new NewsCatcherDashboardService({} as never);
    let release!: (value: unknown) => void;
    const compute = jest.spyOn(service as any, 'computeDashboard').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const allowed = jest
      .spyOn(service, 'allowedNewsClients')
      .mockResolvedValue([{ id: 'client', revision: '1' }]);
    const first = service.getDashboard('tenant', {}, 'actor'),
      second = service.getDashboard('tenant', {}, 'actor');
    const finished = Promise.allSettled([first, second]);
    await Promise.resolve();
    await Promise.resolve();
    allowed.mockResolvedValue([]);
    release(value);
    const results = await finished;
    expect(compute).toHaveBeenCalledTimes(1);
    expect(
      results.every(
        (result) =>
          result.status === 'rejected' &&
          String(result.reason).includes('NEWS_CLIENT_ACCESS_CHANGED'),
      ),
    ).toBe(true);
  });
});
