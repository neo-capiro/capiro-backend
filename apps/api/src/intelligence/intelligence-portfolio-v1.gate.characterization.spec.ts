import {
  alert,
  client,
  clientId,
  deferred,
  emptyAlerts,
  harness,
  installHooks,
  profile,
  tenantId,
  userId,
} from '../../test/fixtures/intelligence-portfolio.js';

installHooks();

describe('Portfolio original nonasync compute promise authority', () => {
  test('returns the exact gated promise while assigning a different never-rejecting gate', async () => {
    const h = harness();
    const originalGate = h.runtime.portfolioAlertsGate;
    const next = jest.spyOn(originalGate, 'then');
    const compute = h.runtime.computePortfolioAlerts(tenantId, userId, 12, 40);
    expect(compute.result).toBe(next.mock.results[0]!.value);
    expect(h.runtime.portfolioAlertsGate).not.toBe(compute.result);
    expect(await compute.result).toEqual(emptyAlerts());
    await expect(h.runtime.portfolioAlertsGate).resolves.toBeUndefined();
  });
  test('uses a pending gate installed after construction before starting any roster I/O', async () => {
    const h = harness();
    const prior = deferred<unknown>();
    h.runtime.portfolioAlertsGate = prior.promise;
    const compute = h.runtime.computePortfolioAlerts(tenantId, userId, 12, 40);
    await Promise.resolve();
    expect(h.calls).toEqual([]);
    prior.resolve(undefined);
    expect(await compute.result).toEqual(emptyAlerts());
    expect(h.callsOf('clients')).toHaveLength(1);
  });
});

describe('Portfolio gate source serialization', () => {
  test('awaits one client profile before beginning the next and keeps exact tenant/user arguments', async () => {
    const first = deferred<unknown>();
    const h = harness({
      rows: {
        clients: [client(), client({ id: 'second', name: 'Second' })],
        [`profile:${clientId}`]: first.promise,
        'profile:second': profile([alert({ id: 'second' })]),
      },
    });
    const compute = h.runtime.computePortfolioAlerts(tenantId, userId, 12, 40);
    await h.started(`profile:${clientId}`);
    expect(h.source.mock.calls).toEqual([[clientId, tenantId, userId, expect.any(AbortSignal)]]);
    expect(h.callsOf('profile:second')).toEqual([]);
    first.resolve(profile([alert({ id: 'first' })]));
    const value = await compute.result;
    expect(h.source.mock.calls).toEqual([
      [clientId, tenantId, userId, expect.any(AbortSignal)],
      ['second', tenantId, userId, expect.any(AbortSignal)],
    ]);
    expect(value.alerts.map((row) => row.id)).toEqual([`${clientId}:first`, 'second:second']);
  });
  test('serializes different tenant/user keys on the same Root gate while retaining separate inflight/cache entries', async () => {
    const first = deferred<unknown>();
    const h = harness({
      queues: { clients: [[client()], [client({ id: 'second', name: 'Second' })]] },
      rows: { [`profile:${clientId}`]: first.promise, 'profile:second': profile([alert()]) },
    });
    const requestA = h.service.getPortfolioAlerts(tenantId, userId);
    await h.started(`profile:${clientId}`);
    const requestB = h.service.getPortfolioAlerts('other-tenant', 'other-user');
    await Promise.resolve();
    expect(h.callsOf('clients')).toHaveLength(1);
    expect(h.runtime.portfolioAlertsInflight.size).toBe(2);
    first.resolve(profile([alert()]));
    const values = await Promise.all([requestA, requestB]);
    expect(values[0]!.alerts[0]!.clientId).toBe(clientId);
    expect(values[1]!.alerts[0]!.clientId).toBe('second');
    expect(h.source.mock.calls[1]).toEqual([
      'second',
      'other-tenant',
      'other-user',
      expect.any(AbortSignal),
    ]);
    expect(h.runtime.portfolioAlertsCache.size).toBe(2);
    expect(h.runtime.portfolioAlertsInflight.size).toBe(0);
  });
});

describe('Portfolio roster rotation across runs', () => {
  test('starts each successive run for a tenant one client further along the alphabetical roster', async () => {
    const roster = [client(), client({ id: 'second', name: 'Second' }), client({ id: 'third', name: 'Third' })];
    const h = harness({ rows: { clients: roster } });
    for (const _ of roster) await h.runtime.computePortfolioAlerts(tenantId, userId, 12, 40).result;
    await h.runtime.computePortfolioAlerts('other-tenant', userId, 12, 40).result;
    expect(h.source.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      [clientId, tenantId],
      ['second', tenantId],
      ['third', tenantId],
      ['second', tenantId],
      ['third', tenantId],
      [clientId, tenantId],
      ['third', tenantId],
      [clientId, tenantId],
      ['second', tenantId],
      [clientId, 'other-tenant'],
      ['second', 'other-tenant'],
      ['third', 'other-tenant'],
    ]);
  });
});

describe('Portfolio preexisting rejected gate recovery', () => {
  test('runs after a rejected predecessor using the same run handler on both outcomes and heals the gate', async () => {
    const h = harness();
    const prior = Promise.reject(new Error('Prior run rejected'));
    const then = jest.spyOn(prior, 'then');
    h.runtime.portfolioAlertsGate = prior;
    const compute = h.runtime.computePortfolioAlerts(tenantId, userId, 12, 40);
    expect(then.mock.calls[0]![0]).toBe(then.mock.calls[0]![1]);
    expect(await compute.result).toEqual(emptyAlerts());
    await expect(h.runtime.portfolioAlertsGate).resolves.toBeUndefined();
    expect(h.warnings).not.toHaveBeenCalled();
  });
});
