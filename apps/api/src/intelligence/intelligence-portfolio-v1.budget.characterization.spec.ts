import {
  type AlertResult,
  type Harness,
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

describe('Portfolio alert carried per-client results across budget-limited runs', () => {
  const second = client({ id: 'second', name: 'Second' });
  const third = client({ id: 'third', name: 'Third' });
  type Opened = Array<{ id: string; profile: ReturnType<typeof deferred<unknown>> }>;
  /** Every profile read opens its own pending promise for the test to settle. */
  const pendingProfiles = () => {
    const opened: Opened = [];
    const row = (id: string) => () => {
      const profile = deferred<unknown>();
      opened.push({ id, profile });
      return profile.promise;
    };
    return {
      opened,
      rows: {
        [`profile:${clientId}`]: row(clientId),
        'profile:second': row('second'),
        'profile:third': row('third'),
      },
    };
  };
  /** Finish the next `count` clients in walk order with one alert each; the one after stays pending. */
  const finish = async (opened: Opened, count: number) => {
    const first = opened.length;
    for (let i = 0; i < count; i++) {
      await drain();
      const current = opened[first + i]!;
      current.profile.resolve(profile([alert({ id: current.id })]));
    }
    await drain();
  };
  /** Drain the client the budget stopped: its profile fails with the abort reason. */
  const drop = async (h: Harness, opened: Opened, index: number) => {
    opened[index]!.profile.reject(h.source.mock.calls[index]![3]!.reason);
    await drain();
  };
  const clientIds = (value: AlertResult) => value.alerts.map((row) => row.clientId).sort();
  const carriedMap = (h: Harness) =>
    (
      h.service as unknown as {
        finalSources: { portfolioAlerts: { carried: Map<string, Map<string, unknown>> } };
      }
    ).finalSources.portfolioAlerts.carried;
  const carriedIds = (h: Harness) => [...carriedMap(h).get(key)!.keys()];

  test('three budget-limited runs converge on the full roster by carrying finished clients forward', async () => {
    budgets.PORTFOLIO_ALERTS_REQUEST_BUDGET_MS = 20;
    const { opened, rows } = pendingProfiles();
    const h = harness({ rows: { clients: [client(), second, third], ...rows } });
    const answers: AlertResult[] = [];
    for (const stopped of [1, 3, 5]) {
      // The next poll lands after the partial answer's TTL.
      if (answers.length) await jest.advanceTimersByTimeAsync(20000);
      const request = h.service.getPortfolioAlerts(tenantId, userId);
      await finish(opened, 1);
      await jest.advanceTimersByTimeAsync(20);
      const answer = await request;
      await drop(h, opened, stopped);
      expect(h.runtime.portfolioAlertsInflight.size).toBe(0);
      // The full answer expires with its oldest carried client (Acme, run one).
      expect(h.runtime.portfolioAlertsCache.get(key)).toEqual({
        expiresAt: answer.partial ? Date.now() + 20000 : now.getTime() + 120000,
        value: answer,
      });
      answers.push(answer);
    }
    expect(answers.map(clientIds)).toEqual([
      [clientId],
      [clientId, 'second'],
      [clientId, 'second', 'third'],
    ]);
    expect(answers[0]).toMatchObject({ total: 1, clientCount: 3, partial: true });
    expect(answers[1]).toMatchObject({ total: 2, clientCount: 3, partial: true });
    expect(answers[2]).toMatchObject({ total: 3, clientCount: 3 });
    expect(answers[2]).not.toHaveProperty('partial');
    // Each run walked the clients it still lacked first, from its rotated start.
    expect(opened.map((entry) => entry.id)).toEqual([
      clientId,
      'second',
      'second',
      'third',
      'third',
      clientId,
    ]);
    expect(carriedIds(h)).toEqual([clientId, 'second', 'third']);
    expect(h.warnings).toHaveBeenCalledTimes(3);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('recomputes carried entries older than the TTL first and never merges them', async () => {
    const { opened, rows } = pendingProfiles();
    const h = harness({ rows: { clients: [client(), second, third], ...rows } });
    const compute = () => h.runtime.computePortfolioAlerts(tenantId, userId, 12, 40);
    const complete = compute();
    await finish(opened, 3);
    expect(await complete.result).toMatchObject({ total: 3, clientCount: 3 });
    expect(await complete.result).not.toHaveProperty('partial');
    // A minute later only Second is refreshed before the budget stops the run;
    // every entry is still valid, so the answer is complete.
    jest.setSystemTime(now.getTime() + 60000);
    const refresh = compute();
    await finish(opened, 1);
    const refreshed = refresh.abort();
    await drop(h, opened, 4);
    expect(refreshed).toMatchObject({ total: 3, clientCount: 3 });
    expect(refreshed).not.toHaveProperty('partial');
    expect(await refresh.result).toEqual(refreshed);
    // At the TTL of the first run Acme and Third are stale and walk first; only
    // Third finishes, Second's valid entry is carried and stale Acme is neither
    // carried nor fresh, so the answer stays partial.
    jest.setSystemTime(now.getTime() + 120000);
    const stale = compute();
    await finish(opened, 1);
    const answer = stale.abort();
    await drop(h, opened, 6);
    expect(clientIds(answer)).toEqual(['second', 'third']);
    expect(answer).toMatchObject({ total: 2, clientCount: 3, partial: true });
    expect(opened.map((entry) => entry.id)).toEqual([
      clientId,
      'second',
      'third',
      'second',
      'third',
      'third',
      clientId,
    ]);
    expect(carriedIds(h)).toEqual(['second', 'third']);
  });

  test('evicts carried entries for clients that left the roster', async () => {
    const { opened, rows } = pendingProfiles();
    const h = harness({
      queues: {
        clients: [
          [client(), second],
          [second, third],
          [client(), second, third],
        ],
      },
      rows,
    });
    const compute = () => h.runtime.computePortfolioAlerts(tenantId, userId, 12, 40);
    const complete = compute();
    await finish(opened, 2);
    expect(await complete.result).toMatchObject({ total: 2, clientCount: 2 });
    // Acme leaves and Third joins: Third walks first, the stopped Second is
    // carried and nothing of Acme remains.
    const changed = compute();
    await finish(opened, 1);
    const answer = changed.abort();
    await drop(h, opened, 3);
    expect(clientIds(answer)).toEqual(['second', 'third']);
    expect(answer).toMatchObject({ total: 2, clientCount: 2 });
    expect(answer).not.toHaveProperty('partial');
    expect(carriedIds(h)).toEqual(['second', 'third']);
    // Acme returns without its old entry, so it is recomputed before the carried clients.
    const returned = compute();
    await finish(opened, 1);
    expect(returned.abort()).toMatchObject({ total: 3, clientCount: 3 });
    await drop(h, opened, 5);
    expect(opened.map((entry) => entry.id)).toEqual([
      clientId,
      'second',
      'third',
      'second',
      clientId,
      'third',
    ]);
    expect(carriedIds(h)).toEqual(['second', 'third', clientId]);
  });

  test('keeps no entry for a failed client, so the answer stays partial and the next run walks it first', async () => {
    const h = harness({
      rows: { clients: [client(), second], 'profile:second': profile([alert({ id: 'second' })]) },
      queues: {
        [`profile:${clientId}`]: [
          new Error('Profile unavailable'),
          profile([alert({ id: 'first' })]),
        ],
      },
    });
    const compute = () => h.runtime.computePortfolioAlerts(tenantId, userId, 12, 40);
    const failed = await compute().result;
    expect(clientIds(failed)).toEqual(['second']);
    expect(failed).toMatchObject({ total: 1, clientCount: 2, partial: true });
    expect(carriedIds(h)).toEqual(['second']);
    const recovered = await compute().result;
    expect(clientIds(recovered)).toEqual([clientId, 'second']);
    expect(recovered).not.toHaveProperty('partial');
    expect(h.source.mock.calls.map((call) => call[0])).toEqual([
      clientId,
      'second',
      clientId,
      'second',
    ]);
  });

  test('caps the cached answer at the expiry of its oldest carried client', async () => {
    budgets.PORTFOLIO_ALERTS_REQUEST_BUDGET_MS = 20;
    const { opened, rows } = pendingProfiles();
    const h = harness({ rows: { clients: [client(), second, third], ...rows } });
    const first = h.service.getPortfolioAlerts(tenantId, userId);
    await finish(opened, 2);
    await jest.advanceTimersByTimeAsync(20);
    expect(await first).toMatchObject({ total: 2, partial: true });
    await drop(h, opened, 2);
    await jest.advanceTimersByTimeAsync(20000);
    // Third finishes now; Acme and Second are carried from the start of the
    // clock, so the full answer expires with them rather than a TTL from now.
    const merged = h.service.getPortfolioAlerts(tenantId, userId);
    await finish(opened, 1);
    await jest.advanceTimersByTimeAsync(20);
    const answer = await merged;
    await drop(h, opened, 4);
    expect(answer).toMatchObject({ total: 3, clientCount: 3 });
    expect(answer).not.toHaveProperty('partial');
    expect(h.runtime.portfolioAlertsCache.get(key)).toEqual({
      expiresAt: now.getTime() + 120000,
      value: answer,
    });
    expect(Date.now()).toBe(now.getTime() + 20040);
  });

  test('sweeps keys whose carried entries have all expired on the next run of any key', async () => {
    const h = harness({
      queues: { clients: [[client()], [second], [client()]] },
      rows: { [`profile:${clientId}`]: profile([alert()]), 'profile:second': profile([alert()]) },
    });
    await h.runtime.computePortfolioAlerts(tenantId, userId, 12, 40).result;
    await h.runtime.computePortfolioAlerts('other-tenant', userId, 12, 40).result;
    expect([...carriedMap(h).keys()]).toEqual([key, `other-tenant:${userId}:12:40`]);
    jest.setSystemTime(now.getTime() + 120000);
    const again = await h.runtime.computePortfolioAlerts(tenantId, userId, 12, 40).result;
    expect(again).not.toHaveProperty('partial');
    expect([...carriedMap(h).keys()]).toEqual([key]);
    expect(carriedIds(h)).toEqual([clientId]);
  });

  test('keeps carried entries isolated per tenant/user key', async () => {
    budgets.PORTFOLIO_ALERTS_REQUEST_BUDGET_MS = 20;
    const { opened, rows } = pendingProfiles();
    const h = harness({
      queues: { clients: [[client(), second], [third], [client(), second]] },
      rows,
    });
    const other = ['other-tenant', 'other-user'] as const;
    const mine = h.service.getPortfolioAlerts(tenantId, userId);
    await finish(opened, 1);
    await jest.advanceTimersByTimeAsync(20);
    expect(clientIds(await mine)).toEqual([clientId]);
    await drop(h, opened, 1);
    const theirs = h.service.getPortfolioAlerts(...other);
    await finish(opened, 1);
    const otherAnswer = await theirs;
    expect(clientIds(otherAnswer)).toEqual(['third']);
    expect(otherAnswer).toMatchObject({ clientCount: 1 });
    expect(otherAnswer).not.toHaveProperty('partial');
    await jest.advanceTimersByTimeAsync(20000);
    const merged = h.service.getPortfolioAlerts(tenantId, userId);
    await finish(opened, 1);
    await jest.advanceTimersByTimeAsync(20);
    const answer = await merged;
    await drop(h, opened, 4);
    expect(clientIds(answer)).toEqual([clientId, 'second']);
    expect(answer).toMatchObject({ total: 2, clientCount: 2 });
    expect(answer).not.toHaveProperty('partial');
    expect([...carriedMap(h).get(`other-tenant:other-user:12:40`)!.keys()]).toEqual(['third']);
    expect(carriedIds(h)).toEqual([clientId, 'second']);
    expect(h.source.mock.calls.map((call) => [call[0], call[1], call[2]])).toEqual([
      [clientId, tenantId, userId],
      ['second', tenantId, userId],
      ['third', ...other],
      ['second', tenantId, userId],
      [clientId, tenantId, userId],
    ]);
  });
});
