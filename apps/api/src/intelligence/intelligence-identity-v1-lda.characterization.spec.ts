import {
  clientId,
  clientRow,
  deferred,
  filingRow,
  harness,
  installHooks,
  tenantId,
} from '../../test/fixtures/intelligence-identity.js';

installHooks();

it.each([
  { cached: [8, 4, 8], confirmed: ['99'], expected: [8, 4] },
  { cached: [0, -3, 0], confirmed: ['99'], expected: [0, -3] },
  { cached: [], confirmed: ['9', '2', '9', 'bad', '1.2'], expected: [9, 2] },
  { cached: null, confirmed: [' ', '0', '-3'], expected: [0, -3] },
  { cached: undefined, confirmed: [], expected: [] },
  { cached: ['8', 1.5, null], confirmed: ['7'], expected: [7] },
])(
  'identity LDA selection retains authority and stable integer conversion for $expected',
  (example) => {
    const h = harness();
    const cached = example.cached as unknown as number[] | null | undefined;
    expect(h.subject.pickLdaClientIds(cached, example.confirmed)).toEqual(example.expected);
    expect(h.calls).toEqual([]);
  },
);

it('identity LDA selection does not mutate its cached or confirmed arrays', () => {
  const cached = [4, 4, 8];
  const confirmed = ['7', '9'];
  const h = harness();
  const result = h.subject.pickLdaClientIds(cached, confirmed);
  expect(result).toEqual([4, 8]);
  expect(result).not.toBe(cached);
  expect(cached).toEqual([4, 4, 8]);
  expect(confirmed).toEqual(['7', '9']);
});

it('identity LDA resolver refuses missing tenant clients before reading mappings', async () => {
  const h = harness({ rows: { client: null } });
  expect(await h.subject.resolveLdaClientIds(clientId, tenantId)).toEqual([]);
  expect(h.calls.map((call) => call.operation)).toEqual(['withTenant', 'client']);
  expect(h.callsOf('client')[0]).toMatchObject({
    tenantId,
    transaction: 1,
    args: [{ where: { id: clientId }, select: { ldaClientIds: true } }],
  });
});

it('identity LDA resolver retains populated invalid-cache early return without confirmed fallback', async () => {
  const h = harness({
    rows: { client: clientRow({ ldaClientIds: ['7', 2.5] }), ldaMappings: [{ externalId: '9' }] },
  });
  expect(await h.subject.resolveLdaClientIds(clientId, tenantId)).toEqual([]);
  expect(h.calls.map((call) => call.operation)).toEqual(['withTenant', 'client']);
});

it('identity LDA resolver reads empty-cache confirmed mappings inside the same tenant transaction', async () => {
  const h = harness({
    rows: { ldaMappings: [{ externalId: '9' }, { externalId: '3' }, { externalId: '9' }] },
  });
  const pick = jest.spyOn(h.subject, 'pickLdaClientIds');
  expect(await h.subject.resolveLdaClientIds(clientId, tenantId)).toEqual([9, 3]);
  expect(pick).toHaveBeenCalledWith([], ['9', '3', '9']);
  expect(pick.mock.contexts[0]).toBe(h.service);
  expect(h.calls.map((call) => call.operation)).toEqual(['withTenant', 'client', 'ldaMappings']);
  expect(h.callsOf('ldaMappings')[0]).toMatchObject({
    tenantId,
    transaction: 1,
    scope: 'tenant',
    args: [{ where: { clientId, source: 'lda', confirmed: true }, select: { externalId: true } }],
  });
});

it('identity LDA resolver preserves archived-cache behavior without adding a profile archive guard', async () => {
  const h = harness({ rows: { client: clientRow({ status: 'archived', ldaClientIds: [7] }) } });
  expect(await h.subject.resolveLdaClientIds(clientId, tenantId)).toEqual([7]);
  expect(h.callsOf('ldaMappings')).toEqual([]);
});

it('identity confirmed LDA IDs use mapping scope alone and retain the real late-bound selector', async () => {
  const h = harness({
    rows: {
      client: null,
      ldaMappings: [
        { externalId: '8' },
        { externalId: '8' },
        { externalId: '' },
        { externalId: 'bad' },
      ],
    },
  });
  const pick = jest.spyOn(h.subject, 'pickLdaClientIds');
  expect(await h.subject.confirmedLdaIds(clientId, tenantId)).toEqual([8, 0]);
  expect(pick).toHaveBeenCalledWith([], ['8', '8', '', 'bad']);
  expect(h.calls.map((call) => call.operation)).toEqual(['withTenant', 'ldaMappings']);
  expect(h.callsOf('ldaMappings')[0]!.args).toEqual([
    {
      where: { clientId, source: 'lda', confirmed: true },
      select: { externalId: true },
    },
  ]);
});

it('identity issue union refuses empty IDs without global I/O', async () => {
  const h = harness();
  expect(await h.subject.issueCodesForLdaIds([])).toEqual([]);
  expect(h.calls).toEqual([]);
});

it('identity issue union preserves raw truthy values and SQL ID-array identity', async () => {
  const ids = [7, 2, 7];
  const h = harness({
    rows: {
      issueCodes: [
        { code: 'SCI' },
        { code: '' },
        { code: null },
        { code: ' ' },
        { code: 'SCI' },
        { code: 42 },
      ],
    },
  });
  expect(await h.subject.issueCodesForLdaIds(ids)).toEqual(['SCI', ' ', 'SCI', 42]);
  expect(h.callsOf('issueCodes')[0]).toMatchObject({
    scope: 'global',
    query: {
      sql: 'SELECT DISTINCT unnest(issue_codes) AS code FROM lda_client WHERE id = ANY($1::int[]) AND issue_codes IS NOT NULL',
      values: [[7, 2, 7]],
    },
  });
  expect(h.callsOf('issueCodes')[0]!.query!.values[0]).toBe(ids);
});

it('identity LDA aggregate refuses empty IDs and stale zero-filing identities at their actual boundaries', async () => {
  const h = harness({ rows: { ldaAggregate: [{ total_filings: 0, total_spending: 99 }] } });
  expect(await h.subject.fetchLdaByIds([])).toBeNull();
  expect(h.calls).toEqual([]);
  expect(await h.subject.fetchLdaByIds([7])).toBeNull();
  expect(h.calls.map((call) => call.operation)).toEqual(['ldaAggregate', 'ldaRecentSet']);
});

it('identity LDA aggregate pins full-set query order and raw projection references', async () => {
  const ids = [7, 2];
  const filings = [filingRow()];
  const yearly = [{ year: 2026, amount: -25 }];
  const h = harness({
    rows: {
      ldaAggregate: [{ total_filings: 3, total_spending: '125' }],
      ldaRecentSet: filings,
      issueCodes: [{ code: 'SCI' }, { code: '' }, { code: 'SCI' }],
      ldaYearlySet: yearly,
    },
  });
  const result = await h.subject.fetchLdaByIds(ids);
  expect(result).toEqual({
    matched: true,
    ldaClientId: 7,
    ldaClientIds: [7, 2],
    confidence: 1,
    totalFilings: 3,
    totalSpending: '125',
    issueCodes: ['SCI', 'SCI'],
    recentFilings: filings,
    yearlySpend: yearly,
  });
  expect(result!.ldaClientIds).toBe(ids);
  expect(result!.recentFilings).toBe(filings);
  expect(result!.yearlySpend).toBe(yearly);
  expect(h.calls.map((call) => call.operation)).toEqual([
    'ldaAggregate',
    'ldaRecentSet',
    'issueCodes',
    'ldaYearlySet',
  ]);
  expect(h.callsOf('ldaAggregate')[0]!.query).toMatchObject({
    sql: 'SELECT COALESCE(SUM(total_filings), 0)::int AS total_filings, SUM(total_spending)::float AS total_spending FROM lda_client WHERE id = ANY($1::int[])',
    values: [ids],
  });
  expect(h.callsOf('ldaRecentSet')[0]!.args).toEqual([
    {
      where: { clientId: { in: ids } },
      orderBy: { dtPosted: 'desc' },
      take: 10,
    },
  ]);
  expect(h.callsOf('ldaYearlySet')[0]!.query).toMatchObject({
    sql: 'SELECT filing_year as year, COALESCE(SUM(income), 0)::float as amount FROM lda_filing WHERE client_id = ANY($1::int[]) GROUP BY filing_year ORDER BY filing_year',
    values: [ids],
  });
  expect(h.calls.every((call) => call.scope === 'global' && call.tenantId === undefined)).toBe(
    true,
  );
});

it('identity LDA aggregate retains matched filings when aggregate data is absent', async () => {
  const h = harness({ rows: { ldaRecentSet: [filingRow()] } });
  expect(await h.subject.fetchLdaByIds([7])).toMatchObject({
    matched: true,
    totalFilings: 0,
    totalSpending: null,
  });
  expect(h.callsOf('issueCodes')).toHaveLength(1);
});

it('identity LDA aggregate retains nonzero negative counts instead of treating them as stale', async () => {
  const h = harness({ rows: { ldaAggregate: [{ total_filings: -1, total_spending: -20 }] } });
  expect(await h.subject.fetchLdaByIds([7])).toMatchObject({
    matched: true,
    totalFilings: -1,
    totalSpending: -20,
  });
});

it('identity LDA aggregate awaits filings and issue codes before launching the yearly catalog', async () => {
  const held = deferred<unknown>();
  const h = harness({
    rows: { ldaAggregate: [{ total_filings: 1 }] },
    results: { issueCodes: held.promise },
  });
  const pending = h.subject.fetchLdaByIds([7]);
  await h.started('issueCodes');
  expect(h.callsOf('ldaRecentSet')).toHaveLength(1);
  expect(h.callsOf('ldaYearlySet')).toEqual([]);
  held.resolve([{ code: 'SCI' }]);
  expect((await pending)!.issueCodes).toEqual(['SCI']);
  expect(h.events.indexOf('done:issueCodes')).toBeLessThan(h.events.indexOf('start:ldaYearlySet'));
});

it.each(['ldaAggregate', 'ldaRecentSet', 'issueCodes', 'ldaYearlySet'])(
  'identity LDA aggregate propagates the original %s failure',
  async (operation) => {
    const failure = new Error(`failed:${operation}`);
    const h = harness({
      rows: { ldaAggregate: [{ total_filings: 1 }] },
      errors: { [operation]: failure },
    });
    await expect(h.subject.fetchLdaByIds([7])).rejects.toBe(failure);
    expect(h.callsOf(operation)).toHaveLength(1);
    if (operation !== 'ldaYearlySet') expect(h.callsOf('ldaYearlySet')).toEqual([]);
  },
);

it.each(['client', 'ldaMappings'])(
  'identity LDA resolver propagates %s failures from its tenant transaction',
  async (operation) => {
    const failure = new Error(`failed:${operation}`);
    const h = harness({ errors: { [operation]: failure } });
    await expect(h.subject.resolveLdaClientIds(clientId, tenantId)).rejects.toBe(failure);
    expect(h.events).toContain('tenant:1:rollback');
    expect(h.callsOf('ldaAggregate')).toEqual([]);
  },
);
