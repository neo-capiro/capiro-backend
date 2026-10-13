import {
  catalogId,
  clientId,
  clientRow,
  contractorRow,
  deferred,
  filingRow,
  harness,
  installHooks,
  now,
  tenantId,
} from '../../test/fixtures/intelligence-identity.js';

installHooks();

function fullRows(overrides: Record<string, unknown> = {}) {
  return {
    client: clientRow({ ldaClientIds: [7, 2, 7] }),
    mappings: [
      {
        source: 'contracting',
        externalId: 'unsafe-first',
        confirmed: true,
        reviewStatus: 'pending',
        rollUpAwards: true,
      },
      {
        source: 'contracting',
        externalId: catalogId,
        confirmed: true,
        reviewStatus: 'confirmed',
        rollUpAwards: true,
      },
      {
        source: 'contracting',
        externalId: 'ignored-later',
        confirmed: true,
        reviewStatus: 'confirmed',
        rollUpAwards: true,
      },
      { source: 'lobby_intel', externalId: catalogId, confirmed: true },
      { source: 'lda', externalId: '99', confirmed: true },
    ],
    ldaAggregate: [{ total_filings: 2, total_spending: 100 }],
    ldaRecentSet: [filingRow()],
    issueCodes: [{ code: 'SCI' }],
    ldaYearlySet: [{ year: 2026, amount: 100 }],
    contractorId: [contractorRow()],
    lobbyId: [{ trajectory: 'rising', growth_rate: 2, total_spending: 50 }],
    competitorTop: [{ name: 'Other company', total_spending: 80, shared_issues: ['SCI'] }],
    competitorEntrants: [],
    ...overrides,
  };
}

it.each(['missing', 'archived'])(
  'identity full profile refuses the %s client before mappings or catalog I/O',
  async (kind) => {
    const h = harness({
      rows: { client: kind === 'missing' ? null : clientRow({ status: 'archived' }) },
    });
    await expect(h.service.getClientProfile(clientId, tenantId)).rejects.toMatchObject({
      status: 404,
      message: 'Client not found',
    });
    expect(h.calls.map((call) => call.operation)).toEqual(['withTenant', 'client']);
    expect(h.callsOf('client')[0]).toMatchObject({
      scope: 'tenant',
      tenantId,
      transaction: 1,
      args: [{ where: { id: clientId }, include: { capabilities: true } }],
    });
  },
);

it('identity full profile runs original source lookups and preserves confirmed mapping authority and result identity', async () => {
  const rows = fullRows();
  const h = harness({ rows });
  const pick = jest.spyOn(h.subject, 'pickLdaClientIds');
  const lda = jest.spyOn(h.subject, 'fetchLdaByIds');
  const contractor = jest.spyOn(h.subject, 'fetchContractorById');
  const lobby = jest.spyOn(h.subject, 'fetchLobbyIntelById');
  const competitors = jest.spyOn(h.subject, 'findCompetitors');
  const result = await h.service.getClientProfile(clientId, tenantId);
  expect(pick).toHaveBeenCalledWith([7, 2, 7], ['99']);
  expect(lda).toHaveBeenCalledWith([7, 2]);
  expect(contractor).toHaveBeenCalledWith(catalogId);
  expect(lobby).toHaveBeenCalledWith(catalogId);
  expect(result.lda).toBe(await lda.mock.results[0]!.value);
  expect(result.contracting).toBe(await contractor.mock.results[0]!.value);
  expect(result.lobbyIntel).toBe(await lobby.mock.results[0]!.value);
  expect(result.competitors).toBe(await competitors.mock.results[0]!.value);
  expect(result.mappings).toBe(rows.mappings);
  expect(result.lda).toMatchObject({
    matched: true,
    ldaClientIds: [7, 2],
    totalFilings: 2,
    totalSpending: 100,
  });
  expect(result.contracting).toMatchObject({
    matched: true,
    contractorName: 'Catalog Contractor',
    totalContracts: 120,
  });
  expect(result.lobbyIntel).toEqual({
    matched: true,
    trajectory: 'rising',
    growthRate: 2,
    totalSpending: 50,
  });
  expect(h.ports.terms).not.toHaveBeenCalled();
  expect(h.ports.bills).toHaveBeenCalledWith(['SCI'], []);
  expect(h.ports.regulations).toHaveBeenCalledWith(['SCI'], []);
  expect(competitors).toHaveBeenCalledWith('Acme Research', ['SCI'], [7, 2]);
  expect(h.callsOf('mappings')[0]).toMatchObject({
    scope: 'tenant',
    tenantId,
    transaction: 2,
    args: [{ where: { clientId }, orderBy: { confidence: 'desc' } }],
  });
  expect(h.callsOf('contractorId')[0]!.query!.values).toEqual([catalogId]);
  expect(h.callsOf('fuzzyContractor')).toEqual([]);
  expect(result.aiSummary).toBeNull();
  expect(result.lastUpdated).toBe(now.toISOString());
});

it('identity full profile keeps unresolved source defaults and exact fallback read-port arguments', async () => {
  const terms = ['Research', 'Hypersonics'];
  const h = harness({ rows: { 'port:terms': terms } });
  const fuzzyLda = jest.spyOn(h.subject, 'fuzzyMatchLda');
  const fuzzyContractor = jest.spyOn(h.subject, 'fuzzyMatchContractor');
  const fuzzyLobby = jest.spyOn(h.subject, 'fuzzyMatchLobbyIntel');
  const result = await h.service.getClientProfile(clientId, tenantId);
  expect(result).toEqual({
    client: {
      id: clientId,
      name: 'Acme Research',
      description: 'Research client',
      sectorTag: 'SCIENCE',
      submissionTracks: [],
      capabilities: [],
    },
    mappings: [],
    lda: {
      matched: false,
      ldaClientId: null,
      ldaClientIds: [],
      confidence: 0,
      totalFilings: 0,
      totalSpending: null,
      issueCodes: [],
      recentFilings: [],
      yearlySpend: [],
    },
    contracting: {
      matched: false,
      contractorName: null,
      totalContracts: null,
      rankByContracts: null,
      noBidTotal: null,
      topAgencies: [],
      yearlySpend: [],
    },
    lobbyIntel: { matched: false, trajectory: null, growthRate: null, totalSpending: null },
    relevantBills: { total: 0, bills: [] },
    activeRegulations: { total: 0, documents: [] },
    competitors: { topBySpend: [], newEntrants: [] },
    aiSummary: null,
    lastUpdated: now.toISOString(),
  });
  for (const source of [fuzzyLda, fuzzyContractor, fuzzyLobby]) {
    expect(source).toHaveBeenCalledWith('Acme Research');
    expect(source.mock.contexts[0]).toBe(h.service);
  }
  expect(h.ports.terms).toHaveBeenCalledWith(tenantId, clientId);
  expect(h.ports.bills).toHaveBeenCalledWith([], terms);
  expect(h.ports.regulations).toHaveBeenCalledWith([], terms);
  expect(h.calls.map((call) => call.operation)).toEqual([
    'withTenant',
    'client',
    'withTenant',
    'mappings',
    'fuzzyLda',
    'fuzzyContractor',
    'fuzzyLobby',
    'port:terms',
    'port:bills',
    'port:regulations',
  ]);
});

it('identity full profile unions all confirmed LDA mappings when its cached values are invalid', async () => {
  const h = harness({
    rows: fullRows({
      client: clientRow({ ldaClientIds: ['7', 1.5] }),
      mappings: [
        { source: 'lda', externalId: '4', confirmed: true },
        { source: 'lda', externalId: '9', confirmed: true },
        { source: 'lda', externalId: '4', confirmed: true },
        { source: 'lda', externalId: '88', confirmed: false },
      ],
    }),
  });
  const result = await h.service.getClientProfile(clientId, tenantId);
  expect(result.lda.ldaClientIds).toEqual([4, 9]);
  expect(h.callsOf('ldaAggregate')[0]!.query!.values).toEqual([[4, 9]]);
  expect(h.callsOf('fuzzyLda')).toEqual([]);
});

it('identity full profile treats unreviewed or non-rollup contracting mappings as fuzzy-only candidates', async () => {
  const h = harness({
    rows: fullRows({
      mappings: [
        {
          source: 'contracting',
          externalId: catalogId,
          confirmed: true,
          reviewStatus: 'confirmed',
          rollUpAwards: false,
        },
        {
          source: 'contracting',
          externalId: catalogId,
          confirmed: true,
          reviewStatus: 'candidate',
          rollUpAwards: true,
        },
        { source: 'lobby_intel', externalId: catalogId, confirmed: false },
      ],
      fuzzyContractor: [contractorRow()],
    }),
  });
  const result = await h.service.getClientProfile(clientId, tenantId);
  expect(result.contracting.matched).toBe(true);
  expect(h.callsOf('fuzzyContractor')).toHaveLength(1);
  expect(h.callsOf('contractorId')).toEqual([]);
  expect(h.callsOf('fuzzyLobby')).toHaveLength(1);
});

it('identity full profile filters only capability tag types and retains scalar and track projections', async () => {
  const tracks = ['FEDERAL', 'FEDERAL'];
  const h = harness({
    rows: {
      client: clientRow({
        submissionTracks: tracks,
        capabilities: [
          { name: 'Capability', tags: ['hypersonic', '', ' ', 42, null, 'hypersonic'] },
          { name: 'Other', sector: 0, tags: { invalid: true } },
        ],
      }),
    },
  });
  const result = await h.service.getClientProfile(clientId, tenantId);
  expect(result.client).toEqual({
    id: clientId,
    name: 'Acme Research',
    description: 'Research client',
    sectorTag: 'SCIENCE',
    submissionTracks: tracks,
    capabilities: [
      { name: 'Capability', sector: null, tags: ['hypersonic', '', ' ', 'hypersonic'] },
      { name: 'Other', sector: 0, tags: [] },
    ],
  });
  expect(result.client.submissionTracks).toBe(tracks);
});

it('identity full profile launches each source phase together and timestamps only after the final stage', async () => {
  const aggregate = deferred<unknown>();
  const top = deferred<unknown>();
  const h = harness({
    rows: fullRows(),
    results: { ldaAggregate: aggregate.promise, competitorTop: top.promise },
  });
  const pending = h.service.getClientProfile(clientId, tenantId);
  await h.started('lobbyId');
  expect(h.callsOf('ldaAggregate')).toHaveLength(1);
  expect(h.callsOf('contractorId')).toHaveLength(1);
  expect(h.callsOf('port:bills')).toEqual([]);
  aggregate.resolve([{ total_filings: 1, total_spending: 5 }]);
  await h.started('competitorTop');
  expect(h.ports.bills).toHaveBeenCalledTimes(1);
  expect(h.ports.regulations).toHaveBeenCalledTimes(1);
  jest.setSystemTime(new Date('2026-10-14T12:00:00.000Z'));
  top.resolve([]);
  expect((await pending).lastUpdated).toBe('2026-10-14T12:00:00.000Z');
});

it('identity full profile awaits capability fallback before launching bill and regulation ports', async () => {
  const held = deferred<unknown>();
  const h = harness({ results: { 'port:terms': held.promise } });
  const pending = h.service.getClientProfile(clientId, tenantId);
  await h.started('port:terms');
  expect(h.ports.bills).not.toHaveBeenCalled();
  expect(h.ports.regulations).not.toHaveBeenCalled();
  held.resolve(['science']);
  await pending;
  expect(h.ports.bills).toHaveBeenCalledWith([], ['science']);
});

it('identity full profile preserves malformed capability projection errors before reading mappings', async () => {
  const h = harness({ rows: { client: clientRow({ capabilities: [null] }) } });
  await expect(h.service.getClientProfile(clientId, tenantId)).rejects.toThrow(TypeError);
  expect(h.calls.map((call) => call.operation)).toEqual(['withTenant', 'client']);
});

it.each([
  'client',
  'mappings',
  'ldaAggregate',
  'contractorId',
  'lobbyId',
  'port:bills',
  'port:regulations',
  'competitorTop',
])(
  'identity full profile propagates %s failure without replacing failed source data',
  async (operation) => {
    const failure = new Error(`failed:${operation}`);
    const h = harness({ rows: fullRows(), errors: { [operation]: failure } });
    await expect(h.service.getClientProfile(clientId, tenantId)).rejects.toBe(failure);
    expect(h.callsOf(operation)).toHaveLength(1);
    if (operation === 'client') expect(h.callsOf('mappings')).toEqual([]);
    if (operation === 'mappings') expect(h.callsOf('ldaAggregate')).toEqual([]);
    if (['ldaAggregate', 'contractorId', 'lobbyId'].includes(operation)) {
      expect(h.ports.bills).not.toHaveBeenCalled();
    }
  },
);
