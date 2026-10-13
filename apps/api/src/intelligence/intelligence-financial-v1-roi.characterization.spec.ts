import {
  clientId,
  deferred,
  harness,
  installHooks,
  tenantId,
} from '../../test/fixtures/intelligence-financial.js';

installHooks();

it('financial ROI returns the missing-client envelope without mapping or catalog reads', async () => {
  const h = harness({ rows: { client: null } });
  expect(await h.service.getLobbyingRoi(clientId, tenantId)).toEqual({
    clientId,
    clientName: null,
    mappedLdaClientId: null,
    mappedLdaClientIds: [],
    mappedContractorId: null,
    lobbySpend: 0,
    contractWins: 0,
    roi: null,
    gap: 0,
  });
  expect(h.calls.map((call) => call.operation)).toEqual(['withTenant', 'client']);
  expect(h.callsOf('client')[0]!.args).toEqual([
    {
      where: { id: clientId },
      select: { id: true, name: true, ldaClientIds: true },
    },
  ]);
  expect(h.calls.every((call) => call.tenantId === tenantId && call.transaction === 1)).toBe(true);
});

it('financial ROI pins reviewed mappings, full cached LDA IDs and global dollar SQL', async () => {
  const h = harness({
    rows: {
      client: { id: clientId, name: 'Acme Research', ldaClientIds: [9, 4, 9] },
      ldaMappings: [{ externalId: '77' }],
      contractingMapping: { externalId: 'contractor-id' },
      lobbySpend: [{ total: 40 }],
      contractWins: [{ total: 150 }],
    },
  });
  expect(await h.service.getLobbyingRoi(clientId, tenantId)).toEqual({
    clientId,
    clientName: 'Acme Research',
    mappedLdaClientId: 9,
    mappedLdaClientIds: [9, 4],
    mappedContractorId: 'contractor-id',
    lobbySpend: 40,
    contractWins: 150,
    roi: 3.75,
    gap: 110,
  });
  expect(h.callsOf('ldaMappings')[0]).toMatchObject({
    tenantId,
    transaction: 2,
    scope: 'tenant',
    args: [
      {
        where: { clientId, source: 'lda', confirmed: true },
        select: { externalId: true },
      },
    ],
  });
  expect(h.callsOf('contractingMapping')[0]).toMatchObject({
    tenantId,
    transaction: 3,
    scope: 'tenant',
    args: [
      {
        where: {
          clientId,
          source: 'contracting',
          confirmed: true,
          reviewStatus: 'confirmed',
          rollUpAwards: true,
        },
      },
    ],
  });
  expect(h.callsOf('lobbySpend')[0]!.query).toMatchObject({
    sql: 'SELECT COALESCE(SUM(income), 0)::float AS total FROM lda_filing WHERE client_id = ANY($1::int[])',
    values: [[9, 4]],
  });
  expect(h.callsOf('contractWins')[0]!.query).toMatchObject({
    sql: 'SELECT COALESCE(total_contracts, 0)::float AS total FROM federal_contractor WHERE id = $1::uuid',
    values: ['contractor-id'],
  });
  expect(h.calls.map((call) => call.operation)).toEqual([
    'withTenant',
    'client',
    'withTenant',
    'ldaMappings',
    'withTenant',
    'contractingMapping',
    'lobbySpend',
    'contractWins',
  ]);
  expect(h.callsOf('lobbySpend')[0]!.scope).toBe('global');
  expect(h.callsOf('contractWins')[0]!.tenantId).toBeUndefined();
});

it('financial ROI resolves confirmed IDs only when cached values contain no integers', async () => {
  const h = harness({
    rows: {
      client: { id: clientId, name: '', ldaClientIds: ['7', 2.5, null] },
      ldaMappings: [
        { externalId: '8' },
        { externalId: '3' },
        { externalId: '8' },
        { externalId: 'bad' },
        { externalId: '1.2' },
      ],
    },
  });
  const result = await h.service.getLobbyingRoi(clientId, tenantId);
  expect(result).toMatchObject({
    clientName: '',
    mappedLdaClientId: 8,
    mappedLdaClientIds: [8, 3],
  });
  expect(h.callsOf('lobbySpend')[0]!.query!.values).toEqual([[8, 3]]);
  expect(h.callsOf('contractWins')).toEqual([]);
});

it('financial ROI retains zero and negative cached integers with stable deduplication', async () => {
  const h = harness({
    rows: {
      client: { id: clientId, name: null, ldaClientIds: [0, -4, 0, 5.5] },
      ldaMappings: [{ externalId: '22' }],
    },
  });
  expect(await h.service.getLobbyingRoi(clientId, tenantId)).toMatchObject({
    clientName: null,
    mappedLdaClientId: 0,
    mappedLdaClientIds: [0, -4],
  });
  expect(h.callsOf('lobbySpend')[0]!.query!.values).toEqual([[0, -4]]);
});

it('financial ROI preserves numeric coercion of confirmed blank and zero identifiers', async () => {
  const h = harness({
    rows: {
      client: { id: clientId, name: 'Fallback', ldaClientIds: null },
      ldaMappings: [{ externalId: ' ' }, { externalId: '0' }, { externalId: '-2' }],
    },
  });
  expect(await h.service.getLobbyingRoi(clientId, tenantId)).toMatchObject({
    mappedLdaClientId: 0,
    mappedLdaClientIds: [0, -2],
  });
});

it('financial ROI performs no global dollar reads when neither mapping exists', async () => {
  const h = harness();
  expect(await h.service.getLobbyingRoi(clientId, tenantId)).toMatchObject({
    mappedLdaClientIds: [],
    mappedLdaClientId: null,
    mappedContractorId: null,
    lobbySpend: 0,
    contractWins: 0,
    roi: null,
    gap: 0,
  });
  expect(h.calls.map((call) => call.operation)).toEqual([
    'withTenant',
    'client',
    'withTenant',
    'ldaMappings',
    'withTenant',
    'contractingMapping',
  ]);
});

it('financial ROI launches both mapping transactions before either result is required', async () => {
  const held = deferred<unknown>();
  const h = harness({
    results: { ldaMappings: held.promise },
    rows: {
      contractingMapping: { externalId: 'contractor-id' },
      contractWins: [{ total: 12 }],
    },
  });
  const pending = h.service.getLobbyingRoi(clientId, tenantId);
  await h.started('contractingMapping');
  expect(h.callsOf('ldaMappings')).toHaveLength(1);
  expect(h.callsOf('contractingMapping')).toHaveLength(1);
  expect(h.callsOf('contractWins')).toEqual([]);
  held.resolve([]);
  expect(await pending).toMatchObject({ lobbySpend: 0, contractWins: 12, roi: null, gap: 12 });
  expect(h.events.indexOf('start:contractingMapping')).toBeLessThan(
    h.events.indexOf('done:ldaMappings'),
  );
});

it('financial ROI waits for global lobbying dollars before reading contractor dollars', async () => {
  const held = deferred<unknown>();
  const h = harness({
    results: { lobbySpend: held.promise },
    rows: {
      ldaMappings: [{ externalId: '7' }],
      contractingMapping: { externalId: 'contractor-id' },
      contractWins: [{ total: 60 }],
    },
  });
  const pending = h.service.getLobbyingRoi(clientId, tenantId);
  await h.started('lobbySpend');
  expect(h.callsOf('contractWins')).toEqual([]);
  held.resolve([{ total: 20 }]);
  expect(await pending).toMatchObject({ lobbySpend: 20, contractWins: 60, roi: 3, gap: 40 });
  expect(h.events.indexOf('done:lobbySpend')).toBeLessThan(h.events.indexOf('start:contractWins'));
});

it.each([
  { spend: 0, wins: 8, roi: null, gap: 8 },
  { spend: -10, wins: 8, roi: null, gap: 18 },
  { spend: 5, wins: -15, roi: -3, gap: -20 },
])('financial ROI retains signed dollars and denominator policy for $spend/$wins', async (row) => {
  const h = harness({
    rows: {
      ldaMappings: [{ externalId: '7' }],
      contractingMapping: { externalId: 'contractor-id' },
      lobbySpend: [{ total: row.spend }],
      contractWins: [{ total: row.wins }],
    },
  });
  expect(await h.service.getLobbyingRoi(clientId, tenantId)).toMatchObject({
    lobbySpend: row.spend,
    contractWins: row.wins,
    roi: row.roi,
    gap: row.gap,
  });
});

it('financial ROI defaults absent and null aggregate totals without losing mapped identities', async () => {
  const h = harness({
    rows: {
      ldaMappings: [{ externalId: '7' }],
      contractingMapping: { externalId: 'contractor-id' },
      lobbySpend: [],
      contractWins: [{ total: null }],
    },
  });
  expect(await h.service.getLobbyingRoi(clientId, tenantId)).toMatchObject({
    mappedLdaClientIds: [7],
    mappedContractorId: 'contractor-id',
    lobbySpend: 0,
    contractWins: 0,
    roi: null,
    gap: 0,
  });
});

it.each(['client', 'ldaMappings', 'contractingMapping', 'lobbySpend', 'contractWins'])(
  'financial ROI propagates the original %s read error',
  async (operation) => {
    const failure = new Error(`failure:${operation}`);
    const h = harness({
      errors: { [operation]: failure },
      rows: {
        ldaMappings: [{ externalId: '7' }],
        contractingMapping: { externalId: 'contractor-id' },
      },
    });
    await expect(h.service.getLobbyingRoi(clientId, tenantId)).rejects.toBe(failure);
    expect(h.callsOf(operation)).toHaveLength(1);
    if (operation !== 'contractWins') expect(h.callsOf('contractWins')).toEqual([]);
    if (operation === 'client') expect(h.callsOf('ldaMappings')).toEqual([]);
    if (operation.endsWith('Mapping') || operation === 'ldaMappings') {
      expect(h.callsOf('lobbySpend')).toEqual([]);
    }
  },
);
