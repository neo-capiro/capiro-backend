import { EngagementTaskStatus } from '@prisma/client';
import {
  clientId,
  day,
  deferred,
  harness,
  healthOperations,
  installHooks,
  now,
  tenantId,
} from '../../test/fixtures/intelligence-context.js';

installHooks();

it('returns the original zero-activity health default through ten separate tenant transactions', async () => {
  const h = harness();
  await expect(h.service.computeEngagementHealth(clientId, tenantId)).resolves.toEqual({
    score: 0,
    breakdown: { meetings: 0, emails: 0, tasksCompleted: 0, debriefs: 0, outreachSent: 0 },
    trend: 'stable',
    period: '7d',
  });
  expect(h.calls.map((call) => call.operation)).toEqual([...healthOperations, ...healthOperations]);
  expect(h.transactions).toHaveLength(10);
  expect(h.transactions.map((tx) => [tx.tenantId, tx.options, tx.outcome])).toEqual(
    Array.from({ length: 10 }, () => [tenantId, undefined, 'commit']),
  );
  expect(h.calls.map((call) => [call.scope, call.tenantId, call.transaction])).toEqual(
    Array.from({ length: 10 }, (_, index) => ['tenant', tenantId, index + 1]),
  );
});

it('pins current inclusive and prior half-open seven-day windows with done tasks and shared Date objects', async () => {
  const h = harness();
  await h.service.computeEngagementHealth(clientId, tenantId);
  const seven = new Date(now.getTime() - 7 * day);
  const fourteen = new Date(now.getTime() - 14 * day);
  expect(h.calls.map((call) => call.args)).toEqual([
    [{ where: { clientId, startsAt: { gte: seven } } }],
    [{ where: { clientId, lastMessageAt: { gte: seven } } }],
    [{ where: { clientId, status: EngagementTaskStatus.done, updatedAt: { gte: seven } } }],
    [{ where: { clientId, createdAt: { gte: seven } } }],
    [{ where: { clientId, sentAt: { gte: seven } } }],
    [{ where: { clientId, startsAt: { gte: fourteen, lt: seven } } }],
    [{ where: { clientId, lastMessageAt: { gte: fourteen, lt: seven } } }],
    [
      {
        where: {
          clientId,
          status: EngagementTaskStatus.done,
          updatedAt: { gte: fourteen, lt: seven },
        },
      },
    ],
    [{ where: { clientId, createdAt: { gte: fourteen, lt: seven } } }],
    [{ where: { clientId, sentAt: { gte: fourteen, lt: seven } } }],
  ]);
  const windows = h.calls.map((call, index) => {
    const where = (call.args[0] as { where: Record<string, unknown> }).where;
    return where[['startsAt', 'lastMessageAt', 'updatedAt', 'createdAt', 'sentAt'][index % 5]!] as {
      gte: Date;
      lt?: Date;
    };
  });
  for (const window of windows.slice(0, 5)) expect(window.gte).toBe(windows[0]!.gte);
  for (const window of windows.slice(5)) {
    expect(window.gte).toBe(windows[5]!.gte);
    expect(window.lt).toBe(windows[0]!.gte);
  }
});

it('launches all ten count promises in the original order before any result settles', async () => {
  const gate = deferred<number>();
  const h = harness({
    results: {
      meetings: gate.promise,
      emails: gate.promise,
      tasks: gate.promise,
      debriefs: gate.promise,
      outreach: gate.promise,
    },
  });
  const pending = h.service.computeEngagementHealth(clientId, tenantId);
  expect(h.calls.map((call) => call.operation)).toEqual([...healthOperations, ...healthOperations]);
  expect(h.transactions.every((tx) => tx.outcome === undefined)).toBe(true);
  gate.resolve(0);
  expect((await pending).score).toBe(0);
  expect(h.transactions.every((tx) => tx.outcome === 'commit')).toBe(true);
});

it.each([
  ['meetings', 15, { meetings: 1, emails: 0, tasksCompleted: 0, debriefs: 0, outreachSent: 0 }],
  ['emails', 2, { meetings: 0, emails: 1, tasksCompleted: 0, debriefs: 0, outreachSent: 0 }],
  ['tasks', 10, { meetings: 0, emails: 0, tasksCompleted: 1, debriefs: 0, outreachSent: 0 }],
  ['debriefs', 20, { meetings: 0, emails: 0, tasksCompleted: 0, debriefs: 1, outreachSent: 0 }],
  ['outreach', 5, { meetings: 0, emails: 0, tasksCompleted: 0, debriefs: 0, outreachSent: 1 }],
] as const)(
  'preserves the %s unit weight of %s and the original breakdown',
  async (operation, score, breakdown) => {
    const h = harness({ queues: { [operation]: [1, 0] } });
    expect(await h.service.computeEngagementHealth(clientId, tenantId)).toEqual({
      score,
      breakdown,
      trend: score === 2 || score === 5 ? 'stable' : 'improving',
      period: '7d',
    });
  },
);

it('combines all five weighted counts and caps the score without capping raw breakdown counts', async () => {
  const h = harness({
    queues: { meetings: [2, 0], emails: [4, 0], tasks: [3, 0], debriefs: [2, 0], outreach: [5, 0] },
  });
  expect(await h.service.computeEngagementHealth(clientId, tenantId)).toEqual({
    score: 100,
    breakdown: { meetings: 2, emails: 4, tasksCompleted: 3, debriefs: 2, outreachSent: 5 },
    trend: 'improving',
    period: '7d',
  });
});

it.each([
  [0, 0, 1, 0, 5, 'stable'],
  [0, 0, 0, 1, 0, 'stable'],
  [3, 0, 0, 0, 6, 'improving'],
  [0, 3, 0, 0, 0, 'declining'],
  [5, 0, 0, 1, 10, 'stable'],
  [0, 5, 1, 0, 5, 'stable'],
] as const)(
  'preserves trend threshold for emails %s/%s and outreach %s/%s',
  async (currentMail, priorMail, currentOutreach, priorOutreach, score, trend) => {
    const h = harness({
      queues: { emails: [currentMail, priorMail], outreach: [currentOutreach, priorOutreach] },
    });
    const result = await h.service.computeEngagementHealth(clientId, tenantId);
    expect(result.score).toBe(score);
    expect(result.trend).toBe(trend);
  },
);

it('compares capped current and prior scores rather than uncapped activity totals', async () => {
  const h = harness({ queues: { meetings: [10, 0], emails: [0, 100] } });
  const result = await h.service.computeEngagementHealth(clientId, tenantId);
  expect(result.score).toBe(100);
  expect(result.trend).toBe('stable');
});

it.each([
  [-2, -30, 'declining'],
  [0.5, 8, 'improving'],
  [null, 0, 'stable'],
  ['2', 30, 'improving'],
  [Infinity, 100, 'improving'],
  [-Infinity, -Infinity, 'declining'],
  [NaN, NaN, 'stable'],
  ['invalid', NaN, 'stable'],
] as const)(
  'retains raw meeting count %s and JavaScript score behavior',
  async (count, score, trend) => {
    const h = harness({ queues: { meetings: [count, 0] } });
    const result = await h.service.computeEngagementHealth(clientId, tenantId);
    expect(result.breakdown.meetings).toBe(count);
    expect(result.score).toBe(score);
    expect(result.trend).toBe(trend);
  },
);

it.each(healthOperations)(
  'keeps current %s count failures fatal after launching all ten reads',
  async (operation) => {
    const error = new Error(`${operation} current unavailable`);
    const h = harness({ queues: { [operation]: [error, 0] } });
    await expect(h.service.computeEngagementHealth(clientId, tenantId)).rejects.toBe(error);
    expect(h.calls.map((call) => call.operation)).toEqual([
      ...healthOperations,
      ...healthOperations,
    ]);
    expect(
      h.transactions.find((tx) => tx.id === h.callsOf(operation)[0]!.transaction)?.outcome,
    ).toBe('rollback');
  },
);

it.each(healthOperations)(
  'keeps prior %s count failures fatal rather than substituting an empty prior period',
  async (operation) => {
    const error = new Error(`${operation} prior unavailable`);
    const h = harness({ queues: { [operation]: [0, error] } });
    await expect(h.service.computeEngagementHealth(clientId, tenantId)).rejects.toBe(error);
    expect(h.calls.map((call) => call.operation)).toEqual([
      ...healthOperations,
      ...healthOperations,
    ]);
    expect(
      h.transactions.find((tx) => tx.id === h.callsOf(operation)[1]!.transaction)?.outcome,
    ).toBe('rollback');
  },
);
