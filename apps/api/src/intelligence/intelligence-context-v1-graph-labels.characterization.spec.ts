import {
  clientId,
  deferred,
  graphOptions,
  harness,
  installHooks,
  tenantId,
  walkRow,
} from '../../test/fixtures/intelligence-context.js';

installHooks();

const labelRows = [
  walkRow({ dst_kind: 'lda_client', dst_id: '1' }),
  walkRow({ dst_kind: 'lda_registrant', dst_id: '2' }),
  walkRow({ dst_kind: 'lda_lobbyist', dst_id: '3' }),
  walkRow({ dst_kind: 'federal_contractor', dst_id: 'contractor-one' }),
  walkRow({ dst_kind: 'fec_committee', dst_id: 'C001' }),
  walkRow({ dst_kind: 'capability', dst_id: 'capability-one' }),
];
const labelOperations = [
  'ldaClientLabels',
  'ldaRegistrantLabels',
  'ldaLobbyistLabels',
  'contractorLabels',
  'fecLabels',
  'capabilityLabels',
] as const;

it('starts all six label lookups before awaiting any label response with global and tenant scopes intact', async () => {
  const gate = deferred<unknown>();
  const h = harness({
    results: {
      walk: labelRows,
      ldaClientLabels: gate.promise,
      ldaRegistrantLabels: gate.promise,
      ldaLobbyistLabels: gate.promise,
      contractorLabels: gate.promise,
      fecLabels: gate.promise,
      capabilityLabels: gate.promise,
    },
  });
  const pending = h.service.getKnowledgeGraph(clientId, tenantId, graphOptions);
  await h.started('capabilityLabels');
  const calls = h.calls.filter((call) =>
    labelOperations.includes(call.operation as (typeof labelOperations)[number]),
  );
  expect(calls.map((call) => call.operation)).toEqual(labelOperations);
  expect(calls.slice(0, 5).map((call) => [call.scope, call.tenantId, call.transaction])).toEqual([
    ['global', undefined, undefined],
    ['global', undefined, undefined],
    ['global', undefined, undefined],
    ['global', undefined, undefined],
    ['global', undefined, undefined],
  ]);
  expect(calls[5]).toMatchObject({
    scope: 'tenant',
    tenantId,
    args: [
      { where: { id: { in: ['capability-one'] }, tenantId }, select: { id: true, name: true } },
    ],
  });
  expect(calls.slice(0, 5).map((call) => call.query!.values)).toEqual([
    [[1]],
    [[2]],
    [[3]],
    [['contractor-one']],
    [['C001']],
  ]);
  expect(calls.slice(0, 5).map((call) => call.query!.sql.replace(/\s+/g, ' ').trim())).toEqual([
    'SELECT id, name FROM lda_client WHERE id = ANY(?::int[])',
    'SELECT id, name FROM lda_registrant WHERE id = ANY(?::int[])',
    'SELECT id, first_name, last_name FROM lda_lobbyist WHERE id = ANY(?::int[])',
    'SELECT id, name FROM federal_contractor WHERE id::text = ANY(?::text[])',
    'SELECT DISTINCT committee_id, committee_name FROM fec_contribution WHERE committee_id = ANY(?::text[]) AND committee_name IS NOT NULL',
  ]);
  gate.resolve([]);
  expect((await pending).nodes).toHaveLength(7);
});

it('resolves all six names while retaining their graph kinds and UI types', async () => {
  const h = harness({
    results: {
      walk: labelRows,
      ldaClientLabels: [{ id: 1, name: 'Client One' }],
      ldaRegistrantLabels: [{ id: 2, name: 'Firm Two' }],
      ldaLobbyistLabels: [{ id: 3, first_name: ' Ada ', last_name: 'Lovelace ' }],
      contractorLabels: [{ id: 'contractor-one', name: 'Contractor' }],
      fecLabels: [{ committee_id: 'C001', committee_name: 'Committee' }],
      capabilityLabels: [{ id: 'capability-one', name: 'Capability' }],
    },
  });
  const result = await h.service.getKnowledgeGraph(clientId, tenantId, graphOptions);
  expect(result.nodes.slice(1).map((node) => [node.id, node.type, node.label])).toEqual([
    ['lda_client:1', 'registrant', 'Client One'],
    ['lda_registrant:2', 'registrant', 'Firm Two'],
    ['lda_lobbyist:3', 'lobbyist', 'Ada  Lovelace'],
    ['federal_contractor:contractor-one', 'contractor', 'Contractor'],
    ['fec_committee:C001', 'pac', 'Committee'],
    ['capability:capability-one', 'agency', 'Capability'],
  ]);
});

it('deduplicates raw IDs before numeric conversion without deduplicating equal converted numbers', async () => {
  const h = harness({
    results: {
      walk: [
        walkRow({ dst_kind: 'lda_client', dst_id: '1' }),
        walkRow({ dst_kind: 'lda_client', dst_id: '1' }),
        walkRow({ dst_kind: 'lda_client', dst_id: '01' }),
        walkRow({ dst_kind: 'lda_client', dst_id: '' }),
        walkRow({ dst_kind: 'lda_client', dst_id: 'NaN' }),
        walkRow({ dst_kind: 'lda_client', dst_id: 'Infinity' }),
      ],
      ldaClientLabels: [
        { id: 1, name: 'One' },
        { id: 0, name: 'Zero' },
      ],
    },
  });
  const result = await h.service.getKnowledgeGraph(clientId, tenantId, graphOptions);
  expect(h.callsOf('ldaClientLabels')[0]!.query!.values).toEqual([[1, 1, 0]]);
  expect(result.nodes.slice(1).map((node) => node.label)).toEqual([
    'One',
    '(lda client) 01',
    '(lda client) ',
    '(lda client) NaN',
    '(lda client) Infinity',
  ]);
});

it('filters auto-matched rows before ID collection and never requests their labels', async () => {
  const h = harness({
    results: { walk: [walkRow({ dst_kind: 'lda_client', dst_id: '7', source: 'auto_matched' })] },
  });
  const result = await h.service.getKnowledgeGraph(clientId, tenantId, graphOptions);
  expect(result.nodes).toHaveLength(1);
  expect(result.edges).toEqual([]);
  for (const operation of labelOperations) expect(h.callsOf(operation)).toHaveLength(0);
});

it('does not launch numeric label queries when every collected numeric ID is nonfinite', async () => {
  const h = harness({
    results: {
      walk: [
        walkRow({ dst_kind: 'lda_client', dst_id: 'NaN' }),
        walkRow({ dst_kind: 'lda_registrant', dst_id: 'Infinity' }),
        walkRow({ dst_kind: 'lda_lobbyist', dst_id: 'invalid' }),
      ],
    },
  });
  await h.service.getKnowledgeGraph(clientId, tenantId, graphOptions);
  expect(h.callsOf('ldaClientLabels')).toHaveLength(0);
  expect(h.callsOf('ldaRegistrantLabels')).toHaveLength(0);
  expect(h.callsOf('ldaLobbyistLabels')).toHaveLength(0);
});

it('keeps blank lobbyist names meaningful and ignores blank or null FEC names', async () => {
  const h = harness({
    results: {
      walk: [
        walkRow({ dst_kind: 'lda_lobbyist', dst_id: '3' }),
        walkRow({ dst_kind: 'fec_committee', dst_id: 'C001' }),
      ],
      ldaLobbyistLabels: [{ id: 3, first_name: null, last_name: null }],
      fecLabels: [
        { committee_id: 'C001', committee_name: null },
        { committee_id: 'C001', committee_name: '' },
      ],
    },
  });
  const result = await h.service.getKnowledgeGraph(clientId, tenantId, graphOptions);
  expect(result.nodes.slice(1).map((node) => node.label)).toEqual([
    'Lobbyist 3',
    '(fec committee) C001',
  ]);
});

it('uses the last returned truthy label for duplicate resolved keys', async () => {
  const h = harness({
    results: {
      walk: [walkRow({ dst_kind: 'fec_committee', dst_id: 'C001' })],
      fecLabels: [
        { committee_id: 'C001', committee_name: 'First' },
        { committee_id: 'C001', committee_name: 'Last' },
        { committee_id: 'C001', committee_name: null },
      ],
    },
  });
  expect(
    (await h.service.getKnowledgeGraph(clientId, tenantId, graphOptions)).nodes[1]!.label,
  ).toBe('Last');
});

it.each([96, 97])('applies the resolved-label limit to %s characters', async (length) => {
  const h = harness({
    results: {
      walk: [walkRow({ dst_kind: 'lda_client', dst_id: '1' })],
      ldaClientLabels: [{ id: 1, name: 'x'.repeat(length) }],
    },
  });
  expect(
    (await h.service.getKnowledgeGraph(clientId, tenantId, graphOptions)).nodes[1]!.label,
  ).toBe(length === 96 ? 'x'.repeat(96) : `${'x'.repeat(96)}…`);
});

it.each(labelOperations)(
  'keeps %s lookup errors fatal after a successful walk',
  async (operation) => {
    const error = new Error(`${operation} failed`);
    const h = harness({ results: { walk: labelRows }, errors: { [operation]: error } });
    await expect(h.service.getKnowledgeGraph(clientId, tenantId, graphOptions)).rejects.toBe(error);
    expect(h.warnings).toEqual([]);
    expect(h.callsOf('walk')).toHaveLength(1);
    expect(h.callsOf('capabilityLabels')).toHaveLength(1);
  },
);
