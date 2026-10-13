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

describe('Portfolio alert request timeout leaves computation alive', () => {
  test('fails open on time, then the same real computation fills the cache from its later completion clock', async () => {
    budgets.PORTFOLIO_ALERTS_REQUEST_BUDGET_MS = 20;
    const pendingProfile = deferred<unknown>();
    const h = harness({
      rows: { clients: [client()], [`profile:${clientId}`]: pendingProfile.promise },
    });
    const empty = jest.spyOn(h.runtime, 'emptyPortfolioAlerts');
    const request = h.service.getPortfolioAlerts(tenantId, userId);
    const compute = h.runtime.portfolioAlertsInflight.get(key)!;
    await h.started(`profile:${clientId}`);
    await jest.advanceTimersByTimeAsync(20);
    expect(await request).toEqual(emptyAlerts(new Date(now.getTime() + 20).toISOString()));
    expect(empty).toHaveBeenCalledTimes(1);
    expect(h.runtime.portfolioAlertsInflight.get(key)).toBe(compute);
    expect(h.runtime.portfolioAlertsCache.size).toBe(0);
    expect(h.warnings).toHaveBeenCalledWith(
      `portfolio-alerts: exceeded 20ms request budget for ${key}; failing open`,
    );
    await jest.advanceTimersByTimeAsync(5);
    pendingProfile.resolve(profile([alert()]));
    const late = (await compute) as AlertResult;
    expect(late.clientCount).toBe(1);
    expect(h.runtime.portfolioAlertsCache.get(key)).toEqual({
      expiresAt: now.getTime() + 25 + 120000,
      value: late,
    });
    expect(await h.service.getPortfolioAlerts(tenantId, userId)).toBe(late);
    expect(h.source).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('Portfolio alert coalesced request budget independence', () => {
  test('gives a later waiter its own full budget while the first request times out', async () => {
    budgets.PORTFOLIO_ALERTS_REQUEST_BUDGET_MS = 20;
    const pendingProfile = deferred<unknown>();
    const h = harness({
      rows: { clients: [client()], [`profile:${clientId}`]: pendingProfile.promise },
    });
    const first = h.service.getPortfolioAlerts(tenantId, userId);
    await h.started(`profile:${clientId}`);
    await jest.advanceTimersByTimeAsync(10);
    let secondSettled = false;
    const second = h.service.getPortfolioAlerts(tenantId, userId).then((value) => {
      secondSettled = true;
      return value;
    });
    await jest.advanceTimersByTimeAsync(10);
    expect((await first).clientCount).toBe(0);
    expect(secondSettled).toBe(false);
    pendingProfile.resolve(profile([alert()]));
    expect((await second).clientCount).toBe(1);
    expect(h.source).toHaveBeenCalledTimes(1);
    expect(h.warnings).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('Portfolio private budget timer protocol', () => {
  test('reads delay now but warning budget later and clears the timed-out timer', async () => {
    budgets.PORTFOLIO_ALERTS_REQUEST_BUDGET_MS = 20;
    const work = deferred<AlertResult>();
    const h = harness();
    let settled = false;
    const pending = h.runtime
      .withPortfolioAlertsRequestBudget('diagnostic', work.promise)
      .then((value) => {
        settled = true;
        return value;
      });
    budgets.PORTFOLIO_ALERTS_REQUEST_BUDGET_MS = 7;
    await jest.advanceTimersByTimeAsync(19);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual(emptyAlerts(new Date(now.getTime() + 20).toISOString()));
    expect(h.warnings).toHaveBeenCalledWith(
      'portfolio-alerts: exceeded 7ms request budget for diagnostic; failing open',
    );
    expect(jest.getTimerCount()).toBe(0);
    work.resolve(emptyAlerts());
  });
  test('unrefs an object timer and clears its exact identity after an early result', async () => {
    const h = harness();
    const handle = { unref: jest.fn() };
    const schedule = jest
      .spyOn(globalThis, 'setTimeout')
      .mockReturnValue(handle as unknown as ReturnType<typeof setTimeout>);
    const clear = jest.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    const value = emptyAlerts();
    expect(await h.runtime.withPortfolioAlertsRequestBudget('early', Promise.resolve(value))).toBe(
      value,
    );
    expect(schedule.mock.calls[0]![1]).toBe(12000);
    expect(handle.unref).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledWith(handle);
  });
});

describe('Portfolio private budget fallback timer and failure protocol', () => {
  test('supports a numeric handle without unref and clears it after completion', async () => {
    const h = harness();
    jest
      .spyOn(globalThis, 'setTimeout')
      .mockReturnValue(7 as unknown as ReturnType<typeof setTimeout>);
    const clear = jest.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    await h.runtime.withPortfolioAlertsRequestBudget('numeric', Promise.resolve(emptyAlerts()));
    expect(clear).toHaveBeenCalledWith(7);
  });
  test('propagates supplied work rejection and clears its pending request timer', async () => {
    const h = harness();
    const error = new Error('Work failed');
    await expect(
      h.runtime.withPortfolioAlertsRequestBudget('failed', Promise.reject(error)),
    ).rejects.toBe(error);
    expect(h.warnings).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
  test('keeps timer-creation failure fatal to the request while computation can still finish and cache', async () => {
    const pendingProfile = deferred<unknown>();
    const h = harness({
      rows: { clients: [client()], [`profile:${clientId}`]: pendingProfile.promise },
    });
    const error = new Error('Timer unavailable');
    jest.spyOn(globalThis, 'setTimeout').mockImplementation(() => {
      throw error;
    });
    await expect(h.service.getPortfolioAlerts(tenantId, userId)).rejects.toBe(error);
    const compute = h.runtime.portfolioAlertsInflight.get(key)!;
    await h.started(`profile:${clientId}`);
    pendingProfile.resolve(profile([alert()]));
    const value = await compute;
    expect(h.runtime.portfolioAlertsCache.get(key)!.value).toBe(value);
    expect(h.runtime.portfolioAlertsInflight.size).toBe(0);
  });
});
