import { IntelligenceService } from './intelligence.service.js';
import {
  clientId,
  deferred,
  harness,
  installHooks,
  policies,
  type Subject,
} from '../../test/fixtures/intelligence-facade-compatibility.js';

installHooks();

it('facade keeps original static policy values as own writable data properties', () => {
  const expected = {
    PORTFOLIO_ALERTS_TTL_MS: 120000,
    PORTFOLIO_ALERTS_REQUEST_BUDGET_MS: 12000,
    PROFILE_V1_SOURCE_BUDGET_MS: 20000,
    PROFILE_V1_SLOW_SOURCE_MS: 3000,
  };
  for (const [name, value] of Object.entries(expected)) {
    expect(Object.getOwnPropertyDescriptor(IntelligenceService, name)).toEqual({
      value,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }
});

it('facade keeps original own cache/inflight/gate fields with separate per-instance storage', async () => {
  const h = harness();
  const other = harness();
  expect(h.fields.portfolioAlertsCache).toBeInstanceOf(Map);
  expect(h.fields.portfolioAlertsInflight).toBeInstanceOf(Map);
  expect(h.fields.portfolioAlertsCache.size).toBe(0);
  expect(h.fields.portfolioAlertsInflight.size).toBe(0);
  expect(h.fields.portfolioAlertsCache).not.toBe(other.fields.portfolioAlertsCache);
  expect(h.fields.portfolioAlertsInflight).not.toBe(other.fields.portfolioAlertsInflight);
  expect(h.fields.portfolioAlertsGate).not.toBe(other.fields.portfolioAlertsGate);
  await expect(h.fields.portfolioAlertsGate).resolves.toBeUndefined();
  for (const name of ['portfolioAlertsCache', 'portfolioAlertsInflight', 'portfolioAlertsGate']) {
    expect(Object.getOwnPropertyDescriptor(h.service, name)).toMatchObject({
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }
});

it('facade portfolio callbacks observe replaced own state and mutable policies after construction', () => {
  const h = harness();
  const ports = h.fields.finalSources.portfolioAlerts.ports;
  const cache = new Map([['entry', { expiresAt: 10, value: 'cached' }]]);
  const inflight = new Map([['entry', Promise.resolve('work')]]);
  const gate = Promise.resolve('gate');
  h.fields.portfolioAlertsCache = cache;
  h.fields.portfolioAlertsInflight = inflight;
  h.fields.portfolioAlertsGate = gate;
  policies.PORTFOLIO_ALERTS_TTL_MS = 7;
  policies.PORTFOLIO_ALERTS_REQUEST_BUDGET_MS = 11;
  expect(ports.cache()).toBe(cache);
  expect(ports.inflight()).toBe(inflight);
  expect(ports.gate()).toBe(gate);
  expect(ports.ttlMs()).toBe(7);
  expect(ports.requestBudgetMs()).toBe(11);
  const replacementGate = Promise.resolve('replacement');
  ports.setGate(replacementGate);
  expect(h.fields.portfolioAlertsGate).toBe(replacementGate);
});

it('facade source budget works on a prototype-only host and reads current static labels/slow policy after timer scheduling', async () => {
  const warn = jest.fn(function (this: unknown, ..._args: unknown[]) {});
  const logger = { warn };
  const host = Object.create(IntelligenceService.prototype) as Subject & { logger: typeof logger };
  host.logger = logger;
  policies.PROFILE_V1_SOURCE_BUDGET_MS = 7;
  policies.PROFILE_V1_SLOW_SOURCE_MS = 100000;
  const work = deferred<number>();
  const outcome = host
    .withSourceBudget('source-one', clientId, work.promise)
    .catch((error: unknown) => error);
  policies.PROFILE_V1_SOURCE_BUDGET_MS = 99;
  policies.PROFILE_V1_SLOW_SOURCE_MS = 0;
  await jest.advanceTimersByTimeAsync(7);
  expect(await outcome).toEqual(new Error('exceeded its 99ms budget (still running)'));
  expect(warn).toHaveBeenCalledWith(
    `profile-v1 source "source-one" took 7ms for client ${clientId}`,
  );
  expect(warn.mock.contexts[0]).toBe(logger);
  expect(jest.getTimerCount()).toBe(0);
  work.resolve(42);
});
