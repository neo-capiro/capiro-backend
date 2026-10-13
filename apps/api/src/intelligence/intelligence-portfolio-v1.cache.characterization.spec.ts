import {
  type AlertResult,
  alert,
  budgets,
  client,
  clientId,
  deferred,
  emptyAlerts,
  harness,
  installHooks,
  now,
  profile,
  tenantId,
  userId,
} from '../../test/fixtures/intelligence-portfolio.js';

installHooks();
const key = `${tenantId}:${userId}:12:40`;

describe('Portfolio alert current cache map and expiry', () => {
  test('returns a current-map cache value by reference without I/O or a request timer', async () => {
    const h = harness();
    const cached = { ...emptyAlerts(), marker: 'cached' };
    h.runtime.portfolioAlertsCache = new Map([
      [key, { expiresAt: now.getTime() + 1, value: cached }],
    ]);
    expect(await h.service.getPortfolioAlerts(tenantId, userId)).toBe(cached);
    expect(h.calls).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
  });
  test('treats exact expiry as expired and replaces it after a successful empty computation', async () => {
    const h = harness();
    const cached = emptyAlerts();
    h.runtime.portfolioAlertsCache.set(key, { expiresAt: now.getTime(), value: cached });
    const value = await h.service.getPortfolioAlerts(tenantId, userId);
    expect(value).not.toBe(cached);
    expect(h.callsOf('clients')).toHaveLength(1);
    expect(h.runtime.portfolioAlertsCache.get(key)).toEqual({
      expiresAt: now.getTime() + 120000,
      value,
    });
    expect(h.runtime.portfolioAlertsInflight.size).toBe(0);
  });
  test('returns the completed cached payload by identity until it expires', async () => {
    const h = harness({
      rows: { clients: [client()], [`profile:${clientId}`]: profile([alert()]) },
    });
    const first = await h.service.getPortfolioAlerts(tenantId, userId);
    expect(await h.service.getPortfolioAlerts(tenantId, userId)).toBe(first);
    expect(h.callsOf('clients')).toHaveLength(1);
    expect(h.source).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('Portfolio alert in-flight promise and key identity', () => {
  test('coalesces the stored compute chain while keeping independent HTTP budget promises', async () => {
    const pendingProfile = deferred<unknown>();
    const h = harness({
      rows: { clients: [client()], [`profile:${clientId}`]: pendingProfile.promise },
    });
    const compute = jest.spyOn(h.runtime, 'computePortfolioAlerts');
    const requestBudget = jest.spyOn(h.runtime, 'withPortfolioAlertsRequestBudget');
    const first = h.service.getPortfolioAlerts(tenantId, userId);
    const underlying = h.runtime.portfolioAlertsInflight.get(key)!;
    const second = h.service.getPortfolioAlerts(tenantId, userId);
    expect(first).not.toBe(second);
    expect(underlying).not.toBe(first);
    expect(underlying).not.toBe(compute.mock.results[0]!.value);
    expect(h.runtime.portfolioAlertsInflight.get(key)).toBe(underlying);
    expect(requestBudget.mock.calls[0]![1]).toBe(underlying);
    expect(requestBudget.mock.calls[1]![1]).toBe(underlying);
    expect(compute).toHaveBeenCalledTimes(1);
    await h.started(`profile:${clientId}`);
    pendingProfile.resolve(profile([alert()]));
    const values = await Promise.all([first, second]);
    expect(values[0]).toBe(values[1]);
    expect(h.runtime.portfolioAlertsCache.get(key)!.value).toBe(values[0]);
    expect(h.runtime.portfolioAlertsInflight.size).toBe(0);
  });
  test('keeps tenant/user/options keys separate while undefined and literal anon share their original key', async () => {
    const h = harness();
    const anonymous = await h.service.getPortfolioAlerts(tenantId, undefined);
    expect(await h.service.getPortfolioAlerts(tenantId, 'anon')).toBe(anonymous);
    await h.service.getPortfolioAlerts(tenantId, '');
    await h.service.getPortfolioAlerts(tenantId, userId);
    await h.service.getPortfolioAlerts('other-tenant', userId);
    await h.service.getPortfolioAlerts(tenantId, userId, { limit: 0, maxClients: 0 });
    expect([...h.runtime.portfolioAlertsCache.keys()]).toEqual([
      `${tenantId}:anon:12:40`,
      `${tenantId}::12:40`,
      key,
      `other-tenant:${userId}:12:40`,
      `${tenantId}:${userId}:1:1`,
    ]);
    expect(h.callsOf('clients')).toHaveLength(5);
  });
});

describe('Portfolio alert late map and TTL observations', () => {
  test('writes current cache, deletes current inflight and reads current TTL at completion across map replacement', async () => {
    const pendingProfile = deferred<unknown>();
    const h = harness({
      rows: { clients: [client()], [`profile:${clientId}`]: pendingProfile.promise },
    });
    const originalCache = h.runtime.portfolioAlertsCache;
    const originalInflight = h.runtime.portfolioAlertsInflight;
    const pending = h.service.getPortfolioAlerts(tenantId, userId);
    await h.started(`profile:${clientId}`);
    const underlying = originalInflight.get(key)!;
    h.runtime.portfolioAlertsCache = new Map();
    h.runtime.portfolioAlertsInflight = new Map([[key, Promise.resolve(emptyAlerts())]]);
    budgets.PORTFOLIO_ALERTS_TTL_MS = 7;
    jest.setSystemTime(now.getTime() + 1000);
    pendingProfile.resolve(profile([alert()]));
    const value = await pending;
    expect(value.generatedAt).toBe(new Date(now.getTime() + 1000).toISOString());
    expect(h.runtime.portfolioAlertsCache.get(key)).toEqual({
      expiresAt: now.getTime() + 1007,
      value,
    });
    expect(originalCache.size).toBe(0);
    expect(h.runtime.portfolioAlertsInflight.has(key)).toBe(false);
    expect(originalInflight.get(key)).toBe(underlying);
  });
  test('uses an externally replaced inflight map and preserves an externally owned promise entry', async () => {
    const h = harness();
    const work = deferred<AlertResult>();
    h.runtime.portfolioAlertsInflight = new Map([[key, work.promise]]);
    const request = h.service.getPortfolioAlerts(tenantId, userId);
    const value = emptyAlerts();
    work.resolve(value);
    expect(await request).toBe(value);
    expect(h.calls).toEqual([]);
    expect(h.runtime.portfolioAlertsInflight.get(key)).toBe(work.promise);
    expect(h.runtime.portfolioAlertsCache.size).toBe(0);
  });
});

describe('Portfolio alert failed computation cleanup', () => {
  test('fails open without caching, removes inflight and leaves the gate healthy for a retry', async () => {
    const h = harness({ queues: { clients: [new Error('Roster unavailable'), [client()]] } });
    expect(await h.service.getPortfolioAlerts(tenantId, userId)).toEqual(emptyAlerts());
    expect(h.runtime.portfolioAlertsCache.has(key)).toBe(false);
    expect(h.runtime.portfolioAlertsInflight.has(key)).toBe(false);
    expect(h.warnings).toHaveBeenCalledWith(
      `portfolio-alerts: compute failed for ${key}: Roster unavailable`,
    );
    expect((await h.service.getPortfolioAlerts(tenantId, userId)).clientCount).toBe(1);
    expect(h.runtime.portfolioAlertsCache.has(key)).toBe(true);
  });
  test('formats non-Error computation rejection without changing the fail-open payload', async () => {
    const h = harness({ errors: { clients: 'unavailable' } });
    expect(await h.service.getPortfolioAlerts(tenantId, userId)).toEqual(emptyAlerts());
    expect(h.warnings).toHaveBeenCalledWith(
      `portfolio-alerts: compute failed for ${key}: unavailable`,
    );
    expect(h.runtime.portfolioAlertsInflight.size).toBe(0);
  });
});
