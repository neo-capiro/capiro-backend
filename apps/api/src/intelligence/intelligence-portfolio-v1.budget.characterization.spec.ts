import {
  type AlertResult,
  type PortfolioAlertsRun,
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
const budgetWarning = (budgetMs: number, cacheKey: string) =>
  `portfolio-alerts: exceeded ${budgetMs}ms request budget for ${cacheKey}; stopping the roll-up and returning the partial result`;
// The run settles through promise chains only; one fake-timer tick crosses a
// real macrotask boundary and so drains every pending microtask.
const drain = () => jest.advanceTimersByTimeAsync(0);

describe('Portfolio alert request budget stops the roll-up and keeps its partial result', () => {
  test('answers at the budget with the clients finished so far, starts no further client and caches the drained partial result', async () => {
    budgets.PORTFOLIO_ALERTS_REQUEST_BUDGET_MS = 20;
    const pendingSecond = deferred<unknown>();
    const h = harness({
      rows: {
        clients: [
          client(),
          client({ id: 'second', name: 'Second' }),
          client({ id: 'third', name: 'Third' }),
        ],
        [`profile:${clientId}`]: profile([alert({ id: 'first' })]),
        'profile:second': pendingSecond.promise,
        'profile:third': profile([alert({ id: 'third' })]),
      },
    });
    const request = h.service.getPortfolioAlerts(tenantId, userId);
    const inflight = h.runtime.portfolioAlertsInflight.get(key)!;
    await h.started('profile:second');
    const signal = h.source.mock.calls[1]![3]!;
    expect(signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(20);
    const answer = await request;
    expect(answer).toEqual({
      alerts: [expect.objectContaining({ id: `${clientId}:first`, clientId })],
      total: 1,
      clientCount: 3,
      generatedAt: new Date(now.getTime() + 20).toISOString(),
      partial: true,
    });
    expect(signal.aborted).toBe(true);
    expect(h.warnings).toHaveBeenCalledWith(budgetWarning(20, key));
    // While the in-flight client drains, later callers get the budgeted answer
    // rather than a new roll-up, and nothing is cached yet.
    expect(h.runtime.portfolioAlertsInflight.get(key)).toBe(inflight);
    expect(await h.service.getPortfolioAlerts(tenantId, userId)).toBe(answer);
    expect(h.runtime.portfolioAlertsCache.size).toBe(0);
    expect(h.callsOf('clients')).toHaveLength(1);

    pendingSecond.resolve(profile([alert({ id: 'second' })]));
    await drain();
    expect(h.source).toHaveBeenCalledTimes(2);
    expect(h.callsOf('profile:third')).toEqual([]);
    expect(h.runtime.portfolioAlertsInflight.size).toBe(0);
    const cached = h.runtime.portfolioAlertsCache.get(key)!;
    expect(cached.expiresAt).toBe(now.getTime() + 20 + 20000);
    expect(cached.value).toEqual({
      alerts: [
        expect.objectContaining({ id: `${clientId}:first` }),
        expect.objectContaining({ id: 'second:second' }),
      ],
      total: 2,
      clientCount: 3,
      generatedAt: new Date(now.getTime() + 20).toISOString(),
      partial: true,
    });
    expect(await h.service.getPortfolioAlerts(tenantId, userId)).toBe(cached.value);
    expect(h.callsOf('clients')).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a run aborted while queued behind another roll-up never starts and caches an empty partial result', async () => {
    budgets.PORTFOLIO_ALERTS_REQUEST_BUDGET_MS = 20;
    const prior = deferred<unknown>();
    const h = harness({
      rows: { clients: [client()], [`profile:${clientId}`]: profile([alert()]) },
    });
    h.runtime.portfolioAlertsGate = prior.promise;
    const request = h.service.getPortfolioAlerts(tenantId, userId);
    await jest.advanceTimersByTimeAsync(20);
    const partialEmpty = {
      ...emptyAlerts(new Date(now.getTime() + 20).toISOString()),
      partial: true,
    };
    expect(await request).toEqual(partialEmpty);
    prior.resolve(undefined);
    await drain();
    expect(h.calls).toEqual([]);
    expect(h.runtime.portfolioAlertsCache.get(key)).toEqual({
      expiresAt: now.getTime() + 20 + 20000,
      value: partialEmpty,
    });
    expect(h.runtime.portfolioAlertsInflight.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('an abort landing during the roster read answers an empty partial with clientCount 0 and caches no full result', async () => {
    budgets.PORTFOLIO_ALERTS_REQUEST_BUDGET_MS = 20;
    const pendingRoster = deferred<unknown>();
    const h = harness({
      rows: { clients: pendingRoster.promise, [`profile:${clientId}`]: profile([alert()]) },
    });
    const request = h.service.getPortfolioAlerts(tenantId, userId);
    await h.started('clients');
    await jest.advanceTimersByTimeAsync(20);
    expect(await request).toEqual({
      ...emptyAlerts(new Date(now.getTime() + 20).toISOString()),
      clientCount: 0,
      partial: true,
    });
    pendingRoster.resolve([client()]);
    await drain();
    expect(h.source).not.toHaveBeenCalled();
    expect(h.runtime.portfolioAlertsCache.get(key)).toEqual({
      expiresAt: now.getTime() + 20 + 20000,
      value: {
        ...emptyAlerts(new Date(now.getTime() + 20).toISOString()),
        clientCount: 1,
        partial: true,
      },
    });
    expect(h.runtime.portfolioAlertsInflight.size).toBe(0);
  });

  test('a profile that fails because the budget aborted it is dropped without a warning', async () => {
    budgets.PORTFOLIO_ALERTS_REQUEST_BUDGET_MS = 20;
    const pendingProfile = deferred<unknown>();
    const h = harness({
      rows: {
        clients: [client(), client({ id: 'second', name: 'Second' })],
        [`profile:${clientId}`]: pendingProfile.promise,
        'profile:second': profile([alert()]),
      },
    });
    const request = h.service.getPortfolioAlerts(tenantId, userId);
    await h.started(`profile:${clientId}`);
    await jest.advanceTimersByTimeAsync(20);
    expect((await request).partial).toBe(true);
    pendingProfile.reject(h.source.mock.calls[0]![3]!.reason);
    await drain();
    expect(h.warnings).toHaveBeenCalledTimes(1);
    expect(h.source).toHaveBeenCalledTimes(1);
    expect(h.runtime.portfolioAlertsCache.get(key)!.value).toEqual({
      ...emptyAlerts(new Date(now.getTime() + 20).toISOString()),
      clientCount: 2,
      partial: true,
    });
  });
});

describe('Portfolio alert coalesced requests share one budget', () => {
  test('a later waiter receives the same partial answer when the first budget stops the run', async () => {
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
    await jest.advanceTimersByTimeAsync(9);
    expect(secondSettled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    const values = await Promise.all([first, second]);
    expect(values[0]).toBe(values[1]);
    expect(values[0]).toMatchObject({ total: 0, clientCount: 1, partial: true });
    expect(h.source).toHaveBeenCalledTimes(1);
    expect(h.warnings).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    pendingProfile.resolve(profile([alert()]));
    await drain();
    expect(h.runtime.portfolioAlertsInflight.size).toBe(0);
  });
});

describe('Portfolio private budget timer protocol', () => {
  const run = (result: Promise<AlertResult>, aborted: AlertResult) =>
    ({ result, abort: jest.fn(() => aborted) }) as PortfolioAlertsRun & { abort: jest.Mock };
  const partial = (): AlertResult => ({ ...emptyAlerts(), partial: true });

  test('reads delay now but warning budget later, aborts the run at the budget and clears the timer', async () => {
    budgets.PORTFOLIO_ALERTS_REQUEST_BUDGET_MS = 20;
    const work = deferred<AlertResult>();
    const aborted = partial();
    const handle = run(work.promise, aborted);
    const h = harness();
    let settled = false;
    const pending = h.runtime.withPortfolioAlertsRequestBudget('diagnostic', handle).then((value) => {
      settled = true;
      return value;
    });
    budgets.PORTFOLIO_ALERTS_REQUEST_BUDGET_MS = 7;
    await jest.advanceTimersByTimeAsync(19);
    expect(settled).toBe(false);
    expect(handle.abort).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(await pending).toBe(aborted);
    expect(handle.abort).toHaveBeenCalledTimes(1);
    expect(h.warnings).toHaveBeenCalledWith(budgetWarning(7, 'diagnostic'));
    expect(jest.getTimerCount()).toBe(0);
    work.resolve(emptyAlerts());
  });
  test('unrefs an object timer and clears its exact identity after an early result without aborting', async () => {
    const h = harness();
    const handle = { unref: jest.fn() };
    const schedule = jest
      .spyOn(globalThis, 'setTimeout')
      .mockReturnValue(handle as unknown as ReturnType<typeof setTimeout>);
    const clear = jest.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    const value = emptyAlerts();
    const early = run(Promise.resolve(value), partial());
    expect(await h.runtime.withPortfolioAlertsRequestBudget('early', early)).toBe(value);
    expect(early.abort).not.toHaveBeenCalled();
    expect(schedule.mock.calls[0]![1]).toBe(12000);
    expect(handle.unref).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledWith(handle);
  });
});

describe('Portfolio private budget fallback timer and failure protocol', () => {
  const run = (result: Promise<AlertResult>): PortfolioAlertsRun => ({
    result,
    abort: () => ({ ...emptyAlerts(), partial: true }),
  });

  test('supports a numeric handle without unref and clears it after completion', async () => {
    const h = harness();
    jest
      .spyOn(globalThis, 'setTimeout')
      .mockReturnValue(7 as unknown as ReturnType<typeof setTimeout>);
    const clear = jest.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    await h.runtime.withPortfolioAlertsRequestBudget('numeric', run(Promise.resolve(emptyAlerts())));
    expect(clear).toHaveBeenCalledWith(7);
  });
  test('propagates supplied work rejection and clears its pending request timer', async () => {
    const h = harness();
    const error = new Error('Work failed');
    await expect(
      h.runtime.withPortfolioAlertsRequestBudget('failed', run(Promise.reject(error))),
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
    await expect(h.runtime.portfolioAlertsInflight.get(key)).rejects.toBe(error);
    await h.started(`profile:${clientId}`);
    pendingProfile.resolve(profile([alert()]));
    await drain();
    expect(h.runtime.portfolioAlertsCache.get(key)!.value).toMatchObject({ total: 1, clientCount: 1 });
    expect(h.runtime.portfolioAlertsCache.get(key)!.value).not.toHaveProperty('partial');
    expect(h.runtime.portfolioAlertsInflight.size).toBe(0);
  });
});
