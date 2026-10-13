import {
  billRow,
  clientId,
  deferred,
  harness,
  installHooks,
  tenantId,
} from '../../test/fixtures/intelligence-bills.js';

const messages = (h: ReturnType<typeof harness>) =>
  h.warnings.mock.calls.map(([message]) => message);

installHooks();

it.each([[[]], [[' ', '\t']]])(
  'returns empty relevant discovery for empty expanded terms %p without any I/O',
  async (terms) => {
    const h = harness();
    await expect(h.subject.findRelevantBills([], terms)).resolves.toEqual({ total: 0, bills: [] });
    expect(h.calls).toEqual([]);
    expect(h.embedding).not.toHaveBeenCalled();
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  },
);

it('uses the real keyword fallback for a short nonempty relevant term without invoking the embedding provider', async () => {
  const h = harness();
  await expect(h.subject.findRelevantBills([], ['tax'])).resolves.toEqual({ total: 0, bills: [] });
  expect(h.embedding).not.toHaveBeenCalled();
  expect(h.callsOf('embeddingCandidates')).toHaveLength(0);
  expect(h.callsOf('keywordCount')).toHaveLength(1);
  expect(h.callsOf('keywordRows')).toHaveLength(1);
  expect(h.callsOf('keywordCount')[0]!.query!.values).toContainEqual(['tax']);
});

it('resolves issue names first and sends the stable expanded term input to real embedding retrieval', async () => {
  const row = billRow({ id: 'research-one' });
  const h = harness({
    embedding: [0.1, 0.2],
    rows: {
      issueNames: [{ name: ' Defense ' }, { name: 'defense' }],
      embeddingCandidates: [{ source_id: row.id, score: 0.9 }],
      billRows: [row],
    },
  });
  const read = jest.spyOn(h.subject, 'findRelevantBillsByEmbeddings');
  const payload = await h.subject.findRelevantBills(['DEF', 'ENV'], ['AI', 'Quantum', ' Defense ']);
  expect(h.callsOf('issueNames')[0]!.query!.values).toEqual([['DEF', 'ENV']]);
  expect(h.embedding).toHaveBeenCalledWith('Defense. AI. artificial intelligence. Quantum');
  expect(h.calls.map((call) => call.operation)).toEqual([
    'issueNames',
    'embed',
    'embeddingCandidates',
    'billRows',
  ]);
  expect(payload.total).toBe(1);
  expect(payload.bills).toEqual([expect.objectContaining({ id: row.id, title: row.title })]);
  expect(payload).toBe(await read.mock.results[0]!.value);
  expect(h.callsOf('keywordCount')).toHaveLength(0);
  expect(h.prisma.$transaction).not.toHaveBeenCalled();
});

it.each([
  'no-candidates',
  'no-hydrated-rows',
  'provider',
  'candidate-query',
  'hydration-query',
] as const)(
  'runs actual keyword discovery after embedding %s rather than accepting a failed/empty candidate rail',
  async (failure) => {
    const error = new Error(`${failure} unavailable`);
    const row = billRow({ id: 'keyword-one' });
    const candidates =
      failure === 'no-candidates' ? [] : [{ source_id: 'embedding-one', score: 0.9 }];
    const h = harness({
      embedding: failure === 'provider' ? error : [0.1, 0.2],
      errors:
        failure === 'candidate-query'
          ? { embeddingCandidates: error }
          : failure === 'hydration-query'
            ? { billRows: error }
            : {},
      rows: {
        embeddingCandidates: candidates,
        billRows: [],
        keywordCount: [{ total: 37n }],
        keywordRows: [row],
      },
    });
    const result = await h.subject.findRelevantBills([], ['Research policy']);
    expect(result.total).toBe(37);
    expect(result.bills).toEqual([
      expect.objectContaining({ id: 'keyword-one', title: row.title }),
    ]);
    expect(h.callsOf('keywordCount')).toHaveLength(1);
    expect(h.callsOf('keywordRows')).toHaveLength(1);
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    const failed = ['provider', 'candidate-query', 'hydration-query'].includes(failure);
    expect(messages(h)).toEqual(
      failed
        ? [
            `Issue-bill embeddings lookup failed, falling back to keyword matcher: ${failure} unavailable`,
          ]
        : [],
    );
    const operations = h.calls.map((call) => call.operation);
    expect(operations.indexOf('embed')).toBeLessThan(operations.indexOf('keywordCount'));
  },
);

it('propagates an issue-name lookup failure before either matching source starts', async () => {
  const error = new Error('issue dictionary unavailable');
  const h = harness({ errors: { issueNames: error } });
  await expect(h.subject.findRelevantBills(['DEF'], ['Research policy'])).rejects.toBe(error);
  expect(h.calls.map((call) => call.operation)).toEqual(['issueNames']);
  expect(h.embedding).not.toHaveBeenCalled();
  expect(h.prisma.$transaction).not.toHaveBeenCalled();
  expect(messages(h)).toEqual([]);
});

it('preserves a keyword transaction failure after an embedding provider failure', async () => {
  const provider = new Error('embedding provider unavailable');
  const cancelled = Object.assign(new Error('statement cancelled'), { code: 'P2010' });
  const h = harness({ embedding: provider, errors: { keywordCount: cancelled } });
  await expect(h.subject.findRelevantBills([], ['Research policy'])).rejects.toBe(cancelled);
  expect(h.callsOf('keywordRows')).toHaveLength(0);
  expect(h.transactions).toEqual([expect.objectContaining({ outcome: 'rollback' })]);
  expect(messages(h)).toEqual([
    'Issue-bill embeddings lookup failed, falling back to keyword matcher: embedding provider unavailable',
  ]);
});

it('getClientBills reads the complete confirmed LDA set under tenant scope before real global discovery', async () => {
  const row = billRow({ id: 'relevant-one' });
  const h = harness({
    embedding: [0.1, 0.2],
    rows: {
      mappings: [
        { externalId: '11' },
        { externalId: '22' },
        { externalId: '22' },
        { externalId: 'invalid' },
      ],
      issueCodes: [{ code: 'DEF' }, { code: 'ENV' }, { code: '' }],
      issueNames: [{ name: 'Research policy' }],
      embeddingCandidates: [{ source_id: row.id, score: 0.9 }],
      billRows: [row],
    },
  });
  const result = await h.service.getClientBills(clientId, tenantId);
  expect(h.callsOf('mappings')[0]).toMatchObject({
    scope: 'tenant',
    tenantId,
    args: [{ where: { clientId, source: 'lda', confirmed: true }, select: { externalId: true } }],
  });
  expect(h.callsOf('issueCodes')[0]!.query!.values).toEqual([[11, 22]]);
  expect(h.callsOf('issueNames')[0]!.query!.values).toEqual([['DEF', 'ENV']]);
  expect(h.calls.map((call) => call.operation)).toEqual([
    'withTenant',
    'mappings',
    'issueCodes',
    'issueNames',
    'embed',
    'embeddingCandidates',
    'billRows',
  ]);
  expect(h.callsOf('billRows')[0]).toMatchObject({ scope: 'global' });
  expect(result.total).toBe(1);
  expect(result.bills).toEqual([expect.objectContaining({ id: row.id })]);
});

it('getClientBills with no confirmed LDA IDs returns empty after only its tenant mapping read', async () => {
  const h = harness();
  await expect(h.service.getClientBills(clientId, tenantId)).resolves.toEqual({
    total: 0,
    bills: [],
  });
  expect(h.calls.map((call) => call.operation)).toEqual(['withTenant', 'mappings']);
  expect(h.embedding).not.toHaveBeenCalled();
  expect(h.prisma.$transaction).not.toHaveBeenCalled();
});

it('looks up embedding overrides installed after construction and after an in-flight issue-name read', async () => {
  const names = deferred<unknown>();
  const h = harness({ results: { issueNames: names.promise } });
  const read = h.subject.findRelevantBills(['DEF']);
  await h.started('issueNames');
  const sentinel = { total: 17, bills: [] };
  const selected = h.override('findRelevantBillsByEmbeddings', sentinel);
  names.resolve([{ name: 'Research policy' }]);
  await expect(read).resolves.toBe(sentinel);
  expect(selected).toHaveBeenCalledWith(['Research policy']);
  expect(h.embedding).not.toHaveBeenCalled();
  expect(h.callsOf('keywordCount')).toHaveLength(0);
});

it('looks up the keyword override after the pending embedding matcher returns null', async () => {
  const embedding = deferred<unknown>();
  const h = harness();
  const first = h.override('findRelevantBillsByEmbeddings', () => embedding.promise);
  const read = h.subject.findRelevantBills([], ['Research policy']);
  expect(first).toHaveBeenCalledTimes(1);
  const sentinel = { total: 23, bills: [] };
  const second = h.override('findRelevantBillsByKeyword', sentinel);
  embedding.resolve(null);
  await expect(read).resolves.toBe(sentinel);
  expect(second).toHaveBeenCalledWith(['Research policy']);
  expect(h.calls.filter((call) => call.scope !== 'override')).toEqual([]);
});
