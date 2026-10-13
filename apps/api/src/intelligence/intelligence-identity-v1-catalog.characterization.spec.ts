import {
  catalogId,
  contractorRow,
  deferred,
  filingRow,
  harness,
  installHooks,
} from '../../test/fixtures/intelligence-identity.js';

installHooks();

it.each([
  { id: ` ${catalogId.toUpperCase()} `, valid: true },
  { id: '00000000-0000-0000-0000-000000000000', valid: true },
  { id: '{abcdefab-1234-5678-90ab-abcdefabcdef}', valid: false },
  { id: 'award-name:Catalog Contractor', valid: false },
  { id: 'abcdefab-1234-5678-90ab-abcdefabcdeg', valid: false },
])('identity UUID guard accepts only its trimmed hexadecimal shape for $id', (example) => {
  const h = harness();
  expect(h.subject.isUuid(example.id)).toBe(example.valid);
  expect(h.calls).toEqual([]);
});

it('identity UUID guard preserves malformed-input failure while confirmed lookups guard nullish IDs', async () => {
  const h = harness();
  expect(() => h.subject.isUuid(null as unknown as string)).toThrow(TypeError);
  expect(await h.subject.fetchContractorById(null as unknown as string)).toBeNull();
  expect(await h.subject.fetchContractorById(' ')).toBeNull();
  expect(await h.subject.fetchLobbyIntelById(null as unknown as string)).toBeNull();
  expect(await h.subject.fetchLobbyIntelById('award-name:Name')).toBeNull();
  expect(h.calls).toEqual([]);
});

it.each([
  {
    id: ` ${catalogId.toUpperCase()} `,
    operation: 'contractorId',
    value: catalogId.toUpperCase(),
    predicate: 'id = $1::uuid',
    uuidCalls: 2,
  },
  {
    id: ' award-name: Catalog Contractor ',
    operation: 'contractorName',
    value: 'Catalog Contractor',
    predicate: 'name = $1',
    uuidCalls: 1,
  },
  {
    id: ' Exact Name ',
    operation: 'contractorName',
    value: 'Exact Name',
    predicate: 'name = $1',
    uuidCalls: 2,
  },
  {
    id: 'award-name: ',
    operation: 'contractorName',
    value: 'award-name:',
    predicate: 'name = $1',
    uuidCalls: 2,
  },
])('identity confirmed contractor uses safe exact catalog binding for $id', async (example) => {
  const row = contractorRow({ rank_by_contracts: '8' });
  const h = harness({ rows: { [example.operation]: [row] } });
  const uuid = jest.spyOn(h.subject, 'isUuid');
  const result = await h.subject.fetchContractorById(example.id);
  expect(result).toEqual({
    matched: true,
    contractorName: 'Catalog Contractor',
    totalContracts: 120,
    rankByContracts: '8',
    noBidTotal: 30,
    topAgencies: row.top_agencies_jsonb,
    yearlySpend: row.yearly_spend_jsonb,
  });
  expect(result!.topAgencies).toBe(row.top_agencies_jsonb);
  expect(result!.yearlySpend).toBe(row.yearly_spend_jsonb);
  expect(uuid).toHaveBeenCalledTimes(example.uuidCalls);
  expect(uuid).toHaveBeenCalledWith(example.id.trim());
  expect(h.calls.map((call) => call.operation)).toEqual([example.operation]);
  expect(h.calls[0]).toMatchObject({
    scope: 'global',
    query: {
      sql: `SELECT id, name, total_contracts, rank_by_contracts, no_bid_total, COALESCE(yearly_spend_jsonb, '[]')::jsonb as yearly_spend_jsonb, COALESCE(top_agencies_jsonb, '[]')::jsonb as top_agencies_jsonb FROM federal_contractor WHERE ${example.predicate} LIMIT 1`,
      values: [example.value],
    },
  });
});

it('identity confirmed contractor leaves an unknown identity unmatched after one exact query', async () => {
  const h = harness();
  expect(await h.subject.fetchContractorById(catalogId)).toBeNull();
  expect(h.calls.map((call) => call.operation)).toEqual(['contractorId']);
});

it('identity confirmed lobby lookup trims its UUID and preserves catalog scalars without number coercion', async () => {
  const h = harness({
    rows: { lobbyId: [{ trajectory: 'declining', growth_rate: '1.5', total_spending: '-10' }] },
  });
  expect(await h.subject.fetchLobbyIntelById(` ${catalogId} `)).toEqual({
    matched: true,
    trajectory: 'declining',
    growthRate: '1.5',
    totalSpending: '-10',
  });
  expect(h.calls[0]).toMatchObject({
    scope: 'global',
    query: {
      sql: 'SELECT id, name, trajectory, growth_rate, total_spending FROM lobby_intel_mv WHERE id = $1::uuid',
      values: [catalogId],
    },
  });
});

it('identity confirmed lobby lookup returns null for a valid missing UUID without name fallback', async () => {
  const h = harness();
  expect(await h.subject.fetchLobbyIntelById(catalogId)).toBeNull();
  expect(h.calls.map((call) => call.operation)).toEqual(['lobbyId']);
});

it('identity fuzzy LDA uses raw name bindings then sequential scalar filing and yearly reads', async () => {
  const codes = ['SCI', 'SCI'];
  const filings = [filingRow()];
  const yearly = [{ year: 2026, amount: -7 }];
  const h = harness({
    rows: {
      fuzzyLda: [
        {
          id: 7,
          name: 'Catalog name',
          total_filings: 2,
          total_spending: '80',
          issue_codes: codes,
          similarity: '0.7',
        },
      ],
      ldaRecentOne: filings,
      ldaYearlyOne: yearly,
    },
  });
  const result = await h.subject.fuzzyMatchLda(' Acme ');
  expect(result).toEqual({
    matched: true,
    ldaClientId: 7,
    ldaClientIds: [7],
    confidence: '0.7',
    totalFilings: 2,
    totalSpending: '80',
    issueCodes: codes,
    recentFilings: filings,
    yearlySpend: yearly,
  });
  expect(result!.issueCodes).toBe(codes);
  expect(result!.recentFilings).toBe(filings);
  expect(result!.yearlySpend).toBe(yearly);
  expect(h.calls.map((call) => call.operation)).toEqual([
    'fuzzyLda',
    'ldaRecentOne',
    'ldaYearlyOne',
  ]);
  expect(h.callsOf('fuzzyLda')[0]!.query).toMatchObject({
    sql: "SELECT c.id, c.name, c.total_filings, c.total_spending, COALESCE(c.issue_codes, '{}') as issue_codes, similarity(c.name, $1) as similarity FROM lda_client c WHERE similarity(c.name, $2) > 0.3 ORDER BY similarity DESC LIMIT 1",
    values: [' Acme ', ' Acme '],
  });
  expect(h.callsOf('ldaRecentOne')[0]!.args).toEqual([
    {
      where: { clientId: 7 },
      orderBy: { dtPosted: 'desc' },
      take: 10,
    },
  ]);
  expect(h.callsOf('ldaYearlyOne')[0]!.query).toMatchObject({
    sql: 'SELECT filing_year as year, COALESCE(SUM(income), 0)::float as amount FROM lda_filing WHERE client_id = $1 GROUP BY filing_year ORDER BY filing_year',
    values: [7],
  });
});

it('identity fuzzy LDA no-match stops before filing and yearly sources', async () => {
  const h = harness();
  expect(await h.subject.fuzzyMatchLda('Acme')).toBeNull();
  expect(h.calls.map((call) => call.operation)).toEqual(['fuzzyLda']);
});

it('identity fuzzy LDA waits for recent filings before launching its yearly catalog', async () => {
  const held = deferred<unknown>();
  const h = harness({
    rows: { fuzzyLda: [{ id: 7, issue_codes: [], similarity: 0.6 }] },
    results: { ldaRecentOne: held.promise },
  });
  const pending = h.subject.fuzzyMatchLda('Acme');
  await h.started('ldaRecentOne');
  expect(h.callsOf('ldaYearlyOne')).toEqual([]);
  held.resolve([]);
  expect((await pending)!.ldaClientId).toBe(7);
  expect(h.events.indexOf('done:ldaRecentOne')).toBeLessThan(
    h.events.indexOf('start:ldaYearlyOne'),
  );
});

it('identity fuzzy contractor and lobby sources retain raw name thresholds and catalog projection', async () => {
  const row = contractorRow({ top_agencies_jsonb: null, yearly_spend_jsonb: null });
  const h = harness({
    rows: {
      fuzzyContractor: [row],
      fuzzyLobby: [{ trajectory: null, growth_rate: 'bad', total_spending: null }],
    },
  });
  expect(await h.subject.fuzzyMatchContractor(' Acme ')).toEqual({
    matched: true,
    contractorName: 'Catalog Contractor',
    totalContracts: 120,
    rankByContracts: 8,
    noBidTotal: 30,
    topAgencies: null,
    yearlySpend: null,
  });
  expect(await h.subject.fuzzyMatchLobbyIntel(' Acme ')).toEqual({
    matched: true,
    trajectory: null,
    growthRate: 'bad',
    totalSpending: null,
  });
  expect(h.callsOf('fuzzyContractor')[0]!.query).toMatchObject({
    sql: "SELECT id, name, total_contracts, rank_by_contracts, no_bid_total, COALESCE(yearly_spend_jsonb, '[]')::jsonb as yearly_spend_jsonb, COALESCE(top_agencies_jsonb, '[]')::jsonb as top_agencies_jsonb, similarity(name, $1) as similarity FROM federal_contractor WHERE similarity(name, $2) > 0.3 ORDER BY similarity DESC LIMIT 1",
    values: [' Acme ', ' Acme '],
  });
  expect(h.callsOf('fuzzyLobby')[0]!.query).toMatchObject({
    sql: 'SELECT id, name, trajectory, growth_rate, total_spending, similarity(name, $1) as similarity FROM lobby_intel_mv WHERE similarity(name, $2) > 0.3 ORDER BY similarity DESC LIMIT 1',
    values: [' Acme ', ' Acme '],
  });
});

it('identity fuzzy contractor and lobby no-matches remain null', async () => {
  const h = harness();
  expect(await h.subject.fuzzyMatchContractor('Acme')).toBeNull();
  expect(await h.subject.fuzzyMatchLobbyIntel('Acme')).toBeNull();
  expect(h.calls.map((call) => call.operation)).toEqual(['fuzzyContractor', 'fuzzyLobby']);
});

it.each([
  'contractorId',
  'contractorName',
  'lobbyId',
  'fuzzyContractor',
  'fuzzyLobby',
  'fuzzyLda',
  'ldaRecentOne',
  'ldaYearlyOne',
])('identity catalog propagates %s source errors without fallback recovery', async (operation) => {
  const failure = new Error(`failed:${operation}`);
  const h = harness({ rows: { fuzzyLda: [{ id: 7 }] }, errors: { [operation]: failure } });
  const work =
    operation === 'contractorId'
      ? h.subject.fetchContractorById(catalogId)
      : operation === 'contractorName'
        ? h.subject.fetchContractorById('Name')
        : operation === 'lobbyId'
          ? h.subject.fetchLobbyIntelById(catalogId)
          : operation === 'fuzzyContractor'
            ? h.subject.fuzzyMatchContractor('Name')
            : operation === 'fuzzyLobby'
              ? h.subject.fuzzyMatchLobbyIntel('Name')
              : h.subject.fuzzyMatchLda('Name');
  await expect(work).rejects.toBe(failure);
  expect(h.callsOf(operation)).toHaveLength(1);
  if (operation === 'ldaRecentOne') expect(h.callsOf('ldaYearlyOne')).toEqual([]);
});
