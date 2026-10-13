import {
  clientId,
  graphOptions,
  harness,
  installHooks,
  now,
  tenantId,
  walkRow,
} from '../../test/fixtures/intelligence-context.js';

installHooks();

it.each([
  ['client', 'client'],
  ['lda_client', 'registrant'],
  ['lda_registrant', 'registrant'],
  ['registrant', 'registrant'],
  ['lda_lobbyist', 'lobbyist'],
  ['lobbyist', 'lobbyist'],
  ['member', 'lobbyist'],
  ['candidate', 'lobbyist'],
  ['federal_contractor', 'contractor'],
  ['contractor', 'contractor'],
  ['bill', 'bill'],
  ['congress_bill', 'bill'],
  ['subject', 'bill'],
  ['policy_area', 'bill'],
  ['lda_issue_code', 'bill'],
  ['fec_committee', 'pac'],
  ['fec_contribution', 'pac'],
  ['employer', 'pac'],
  ['pac', 'pac'],
  ['capability', 'agency'],
  ['program_element', 'agency'],
  ['committee', 'agency'],
  ['hearing', 'agency'],
  ['agency', 'agency'],
  ['docket', 'agency'],
  ['fr_document', 'agency'],
  ['unknown_kind', 'agency'],
])('projects %s nodes with the original %s UI type', async (kind, type) => {
  const h = harness({ results: { walk: [walkRow({ dst_kind: kind, dst_id: 'node-one' })] } });
  const result = await h.service.getKnowledgeGraph(clientId, tenantId, graphOptions);
  expect(result.nodes[1]).toMatchObject({
    id: `${kind}:node-one`,
    type,
    metadata: { kind, rawId: 'node-one' },
  });
  expect(result.nodes[1]!.metadata.observedAt).toBe(now);
});

it.each([
  'bill',
  'subject',
  'policy_area',
  'committee',
  'agency',
  'employer',
  'candidate',
  'member',
  'program_element',
  'foreign_principal',
  'sec_company',
])('preserves meaningful %s raw labels and their 96-character truncation', async (kind) => {
  const h = harness({ results: { walk: [walkRow({ dst_kind: kind, dst_id: 'x'.repeat(97) })] } });
  expect(
    (await h.service.getKnowledgeGraph(clientId, tenantId, graphOptions)).nodes[1]!.label,
  ).toBe(`${'x'.repeat(96)}…`);
});

it.each([24, 25])(
  'applies the opaque raw ID limit at %s characters and replaces kind underscores',
  async (length) => {
    const h = harness({
      results: { walk: [walkRow({ dst_kind: 'unknown_kind', dst_id: 'x'.repeat(length) })] },
    });
    expect(
      (await h.service.getKnowledgeGraph(clientId, tenantId, graphOptions)).nodes[1]!.label,
    ).toBe(`(unknown kind) ${'x'.repeat(24)}${length === 25 ? '…' : ''}`);
  },
);

it('retains insertion order, the first node metadata and directed edge keys without leaking walk-only fields', async () => {
  const later = new Date('2026-10-14T02:00:00.000Z');
  const first = walkRow({ source: null, confidence: 0.1, observed_at: now });
  const h = harness({
    results: {
      walk: [
        first,
        walkRow({ source: 'manual', observed_at: later }),
        walkRow({ edge_type: 'backs_bill', observed_at: later }),
        walkRow({ src_kind: 'bill', src_id: 'HR 1', dst_kind: 'client', dst_id: clientId }),
      ],
    },
  });
  const result = await h.service.getKnowledgeGraph(clientId, tenantId, graphOptions);
  expect(result.nodes).toEqual([
    { id: `client:${clientId}`, type: 'client', label: 'Acme', metadata: { sectorTag: 'energy' } },
    {
      id: 'bill:HR 1',
      type: 'bill',
      label: 'HR 1',
      metadata: { kind: 'bill', rawId: 'HR 1', source: null, observedAt: now },
    },
  ]);
  expect(result.nodes[1]!.metadata.observedAt).toBe(now);
  expect(result.edges).toEqual([
    {
      source: `client:${clientId}`,
      target: 'bill:HR 1',
      type: 'tracks_bill',
      label: 'tracks bill',
    },
    { source: `client:${clientId}`, target: 'bill:HR 1', type: 'backs_bill', label: 'backs bill' },
    {
      source: 'bill:HR 1',
      target: `client:${clientId}`,
      type: 'tracks_bill',
      label: 'tracks bill',
    },
  ]);
  expect(Object.keys(result.nodes[1]!.metadata)).toEqual(['kind', 'rawId', 'source', 'observedAt']);
});

it('labels every walked client with the center client name while leaving the center metadata authoritative', async () => {
  const h = harness({
    results: { walk: [walkRow({ dst_kind: 'client', dst_id: 'other-client' })] },
  });
  const result = await h.service.getKnowledgeGraph(clientId, tenantId, graphOptions);
  expect(result.nodes.map((node) => node.label)).toEqual(['Acme', 'Acme']);
  expect(result.nodes[0]!.metadata).toEqual({ sectorTag: 'energy' });
  expect(result.nodes[1]!.metadata).toMatchObject({ kind: 'client', rawId: 'other-client' });
});

it('keeps empty client names and null sectors without substituting the client ID', async () => {
  const h = harness({ results: { client: { name: '', sectorTag: null } } });
  const result = await h.service.getKnowledgeGraph(clientId, tenantId, graphOptions);
  expect(result.nodes[0]).toEqual({
    id: `client:${clientId}`,
    type: 'client',
    label: '',
    metadata: { sectorTag: null },
  });
});

it.each([
  [[], { avgConfidence: 0, confirmedCount: 0, unconfirmedCount: 0 }],
  [
    [
      { confirmed: true, confidence: 0.725 },
      { confirmed: false, confidence: 1 },
    ],
    { avgConfidence: 73, confirmedCount: 1, unconfirmedCount: 1 },
  ],
  [
    [
      { confirmed: true, confidence: null },
      { confirmed: true, confidence: 0.8 },
    ],
    { avgConfidence: 40, confirmedCount: 2, unconfirmedCount: 0 },
  ],
  [
    [
      { confirmed: true, confidence: 2 },
      { confirmed: true, confidence: -0.2 },
      { confirmed: null, confidence: 1 },
    ],
    { avgConfidence: 90, confirmedCount: 2, unconfirmedCount: 1 },
  ],
])('retains raw resolution confidence averaging for mappings %j', async (mappings, expected) => {
  const h = harness({ results: { mappings } });
  expect(
    (await h.service.getKnowledgeGraph(clientId, tenantId, graphOptions)).resolutionQuality,
  ).toEqual(expected);
});

it('does not clamp resolution percentages to the display score range', async () => {
  const h = harness({ results: { mappings: [{ confirmed: true, confidence: 2 }] } });
  expect(
    (await h.service.getKnowledgeGraph(clientId, tenantId, graphOptions)).resolutionQuality
      .avgConfidence,
  ).toBe(200);
});
