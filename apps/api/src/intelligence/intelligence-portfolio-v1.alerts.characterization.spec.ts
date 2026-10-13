import {
  alert,
  client,
  clientId,
  emptyAlerts,
  harness,
  inputOf,
  installHooks,
  now,
  profile,
  tenantId,
  userId,
} from '../../test/fixtures/intelligence-portfolio.js';

installHooks();

describe('Portfolio alert original empty and option decisions', () => {
  test('creates fresh empty payloads using the current clock', () => {
    const h = harness();
    const first = h.runtime.emptyPortfolioAlerts();
    jest.setSystemTime(now.getTime() + 1000);
    const second = h.runtime.emptyPortfolioAlerts();
    expect(first).toEqual(emptyAlerts());
    expect(second).toEqual(emptyAlerts(new Date(now.getTime() + 1000).toISOString()));
    expect(second).not.toBe(first);
  });
  test.each([
    { opts: undefined, limit: 12, maxClients: 40, returned: 2 },
    { opts: { limit: 0, maxClients: 0 }, limit: 1, maxClients: 1, returned: 1 },
    { opts: { limit: 999, maxClients: 999 }, limit: 50, maxClients: 200, returned: 2 },
    { opts: { limit: 1.5, maxClients: 2.5 }, limit: 1.5, maxClients: 2.5, returned: 1 },
  ])(
    'uses original defaults/clamps $limit and $maxClients',
    async ({ opts, limit, maxClients, returned }) => {
      const h = harness({
        rows: {
          clients: [client()],
          [`profile:${clientId}`]: profile([alert(), alert({ id: 'two' })]),
        },
      });
      const compute = jest.spyOn(h.runtime, 'computePortfolioAlerts');
      const result = await h.service.getPortfolioAlerts(tenantId, userId, opts);
      expect(compute).toHaveBeenCalledWith(tenantId, userId, limit, maxClients);
      expect(inputOf(h, 'clients')).toEqual({
        where: { status: { not: 'archived' } },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
        take: maxClients,
      });
      expect(result.alerts).toHaveLength(returned);
      expect(result.total).toBe(2);
      expect(result.clientCount).toBe(1);
    },
  );
});

describe('Portfolio alert global sorting and canonical sidecar', () => {
  test('ranks severity case-insensitively then numeric countdown then latest event, before the return cap', async () => {
    const h = harness({
      rows: {
        clients: [client(), client({ id: 'second', name: 'Second' })],
        [`profile:${clientId}`]: profile([
          alert({ id: 'info', severity: 'info', countdownDays: 1 }),
          alert({ id: 'no-countdown', severity: 'critical', countdownDays: undefined }),
          alert({ id: 'old', severity: 'critical', countdownDays: 3, when: '2026-10-16' }),
          alert({ id: 'notable' }),
        ]),
        'profile:second': profile([
          alert({ id: 'soon', severity: 'CRITICAL', countdownDays: 0 }),
          alert({ id: 'new', severity: 'critical', countdownDays: 3, when: '2026-10-20' }),
          alert({ id: 'unknown', severity: 'unknown' }),
        ]),
      },
    });
    const value = await h.runtime.computePortfolioAlerts(tenantId, userId, 4, 40);
    expect(value.alerts.map((row) => row.id)).toEqual([
      'second:soon',
      'second:new',
      `${clientId}:old`,
      `${clientId}:no-countdown`,
    ]);
    expect(value).toMatchObject({ total: 7, clientCount: 2, generatedAt: now.toISOString() });
    expect(h.source.mock.calls).toEqual([
      [clientId, tenantId, userId],
      ['second', tenantId, userId],
    ]);
  });
  test('namespaces null/numeric IDs, overwrites foreign client tags, retains nested references and never hides incomplete alerts', async () => {
    const nested = { marker: 'original' };
    const h = harness({
      rows: {
        clients: [client()],
        [`profile:${clientId}`]: profile([
          alert({ id: 5, clientId: 'foreign', clientName: 'Wrong', extra: nested }),
          alert({ id: null, title: ' ', subtitle: null }),
        ]),
      },
    });
    const value = await h.runtime.computePortfolioAlerts(tenantId, userId, 12, 40);
    expect(value.alerts[0]).toMatchObject({
      id: `${clientId}:5`,
      clientId,
      clientName: 'Acme Research',
      canonicalComplete: false,
      canonicalMissingFields: ['issueId', 'whoActs'],
    });
    expect(value.alerts[0]!.extra).toBe(nested);
    expect(value.alerts[1]).toMatchObject({
      id: `${clientId}:`,
      canonicalComplete: false,
      canonicalMissingFields: ['whatChanged', 'whyItMatters', 'issueId', 'whoActs'],
    });
    expect(value.total).toBe(2);
  });
});

describe('Portfolio alert profile failure boundaries', () => {
  test('continues after one profile rejects and counts the full queried roster', async () => {
    const h = harness({
      rows: {
        clients: [client(), client({ id: 'second', name: 'Second' })],
        'profile:second': profile([alert()]),
      },
      errors: { [`profile:${clientId}`]: new Error('Profile unavailable') },
    });
    const value = await h.runtime.computePortfolioAlerts(tenantId, userId, 12, 40);
    expect(value).toMatchObject({ total: 1, clientCount: 2 });
    expect(value.alerts[0]!.clientId).toBe('second');
    expect(h.warnings).toHaveBeenCalledWith(
      `portfolio-alerts: profile-v1 failed for client ${clientId}: Profile unavailable`,
    );
  });
  test('retains already appended rows if a later malformed alert fails the same client loop', async () => {
    const bad = null as unknown as Record<string, unknown>;
    const h = harness({
      rows: {
        clients: [client(), client({ id: 'second', name: 'Second' })],
        [`profile:${clientId}`]: profile([alert({ id: 'kept' }), bad, alert({ id: 'skipped' })]),
        'profile:second': profile([alert()]),
      },
    });
    const value = await h.runtime.computePortfolioAlerts(tenantId, userId, 12, 40);
    expect(value.alerts.map((row) => row.id)).toEqual([`${clientId}:kept`, 'second:alert-one']);
    expect(h.warnings).toHaveBeenCalledTimes(1);
  });
  test.each([null, {}, { sections: { snapshot: {} } }])(
    'keeps missing profile snapshot %p empty without a warning',
    async (result) => {
      const h = harness({ rows: { clients: [client()], [`profile:${clientId}`]: result } });
      expect(await h.runtime.computePortfolioAlerts(tenantId, userId, 12, 40)).toEqual({
        alerts: [],
        total: 0,
        clientCount: 1,
        generatedAt: now.toISOString(),
      });
      expect(h.warnings).not.toHaveBeenCalled();
    },
  );
});
