import {
  clientId,
  deferred,
  harness,
  installHooks,
  now,
  since,
  tenantId,
} from '../../test/fixtures/intelligence-alerts.js';

installHooks();

function filing(overrides: Record<string, unknown> = {}) {
  return {
    id: 'filing-one',
    registrantName: 'Firm One',
    clientName: 'Other Client',
    issueCodes: ['DEF'],
    dtPosted: now,
    ...overrides,
  };
}

it('competitor issue lineage awaits confirmed IDs then forwards the same full array through late Root ports', async () => {
  const held = deferred<unknown>();
  const codes = ['DEF', 'DEF'];
  const ids = [7, 2, 7];
  const h = harness({ results: { 'port:confirmed': held.promise }, rows: { 'port:codes': codes } });
  const pending = h.subject.getClientIssueCodes(clientId, tenantId);
  await h.started('port:confirmed');
  expect(h.ports.codes).not.toHaveBeenCalled();
  held.resolve(ids);
  expect(await pending).toBe(codes);
  expect(h.ports.confirmed).toHaveBeenCalledWith(clientId, tenantId);
  expect(h.ports.codes).toHaveBeenCalledWith(ids);
  expect(h.ports.codes.mock.calls[0]![0]).toBe(ids);
  expect(h.ports.confirmed.mock.contexts[0]).toBe(h.service);
  expect(h.ports.codes.mock.contexts[0]).toBe(h.service);
});

it('competitor alerts keep empty-code guard after the issue lineage call without client or filing I/O', async () => {
  const h = harness();
  const lineage = jest.spyOn(h.subject, 'getClientIssueCodes');
  expect(await h.service.getCompetitorLdaAlerts(clientId, tenantId, since)).toEqual([]);
  expect(lineage).toHaveBeenCalledWith(clientId, tenantId);
  expect(h.calls.map((call) => call.operation)).toEqual(['port:confirmed', 'port:codes']);
});

it('competitor alerts pin tenant own-name and global issue/window predicates with pair-level dedupe', async () => {
  const h = harness({
    rows: {
      'port:codes': ['DEF', 'AER'],
      filings: [
        filing({ id: 'own', clientName: ' ACME DEFENSE ' }),
        filing({
          id: 'missing-date',
          registrantName: ' Firm ',
          clientName: ' Other ',
          dtPosted: null,
        }),
        filing({ id: 'poisoned-duplicate', registrantName: 'firm', clientName: 'other' }),
        filing({
          id: 'different-client',
          registrantName: 'firm',
          clientName: 'Second Client',
          issueCodes: ['DEF', 'ZZ', 'DEF'],
        }),
        filing({ id: 'unknown', registrantName: null, clientName: null, issueCodes: [] }),
      ],
    },
  });
  const result = await h.service.getCompetitorLdaAlerts(clientId, tenantId, since);
  expect(result.map((alert) => alert.id)).toEqual([
    'competitor:different-client',
    'competitor:unknown',
  ]);
  expect(result[0]).toEqual({
    id: 'competitor:different-client',
    type: 'competitor_filing',
    severity: 'info',
    title: 'New lobbying filing: firm',
    subtitle: 'Second Client · issues DEF, DEF',
    when: now.toISOString(),
    countdownDays: null,
    countdownLabel: null,
    href: `/intelligence/issues/DEF?clientId=${clientId}`,
    _urgencyScore: 10,
    _typeRank: 1,
  });
  expect(result[1]).toMatchObject({
    title: 'New lobbying filing: Unknown firm',
    subtitle: 'Undisclosed client · issues ',
    href: `/intelligence/issues/DEF?clientId=${clientId}`,
  });
  expect(h.callsOf('client')[0]).toMatchObject({
    scope: 'tenant',
    tenantId,
    transaction: 1,
    args: [{ where: { id: clientId }, select: { name: true } }],
  });
  expect(h.callsOf('filings')[0]).toMatchObject({
    scope: 'global',
    args: [
      {
        where: {
          dtPosted: { gte: since },
          issueCodes: { hasSome: ['DEF', 'AER'] },
        },
        orderBy: { dtPosted: 'desc' },
        take: 25,
      },
    ],
  });
});

it('competitor alerts keep the missing-client name fallback and stop after five emitted rows', async () => {
  const h = harness({
    rows: {
      client: null,
      'port:codes': ['D/F'],
      filings: [
        ...Array.from({ length: 5 }, (_, index) =>
          filing({
            id: `filing-${index}`,
            registrantName: `Firm ${index}`,
            clientName: 'Acme Defense',
            issueCodes: ['D/F'],
          }),
        ),
        filing({ registrantName: 42 }),
      ],
    },
  });
  const result = await h.service.getCompetitorLdaAlerts('client/one', tenantId, since);
  expect(result).toHaveLength(5);
  expect(result[0]!.href).toBe('/intelligence/issues/D%2FF?clientId=client%2Fone');
  expect(h.warnings).toEqual([]);
});

it.each(['port:confirmed', 'port:codes', 'client', 'filings'])(
  'competitor alerts warn and return empty after %s failures',
  async (operation) => {
    const h = harness({
      rows: { 'port:codes': ['DEF'] },
      errors: { [operation]: new Error(`failed:${operation}`) },
    });
    expect(await h.service.getCompetitorLdaAlerts(clientId, tenantId, since)).toEqual([]);
    expect(h.warnings).toEqual([
      `getCompetitorLdaAlerts failed for ${clientId}: failed:${operation}`,
    ]);
  },
);

it('competitor issue lineage itself propagates errors while the alert source catches them', async () => {
  const failure = new Error('lineage unavailable');
  const h = harness({ errors: { 'port:codes': failure } });
  await expect(h.subject.getClientIssueCodes(clientId, tenantId)).rejects.toBe(failure);
  expect(h.warnings).toEqual([]);
});
