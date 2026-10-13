import { EMBEDDING_MODEL } from '../embeddings/embedder.js';
import { billRow, harness, installHooks } from '../../test/fixtures/intelligence-bills.js';

const methods = ['findRelevantBillsByEmbeddings', 'findTrackedBillsByEmbeddings'] as const;
function candidateSql(limit: number) {
  return `SELECT ce.source_id,
                (1 - (ce.embedding <=> $1::vector))::float8 AS score
           FROM context_embeddings ce
          WHERE ce.source_type = 'bill'
            AND ce.model = $2
            AND ce.embedding IS NOT NULL
            AND (1 - (ce.embedding <=> $1::vector)) >= $3
          ORDER BY ce.embedding <=> $1::vector
          LIMIT ${limit}`;
}
const compactSql = (sql?: string) => (sql ?? '').replace(/\s+/g, ' ').trim();

const messages = (h: ReturnType<typeof harness>) =>
  h.warnings.mock.calls.map(([message]) => message);

function assertRelevantRows(
  result: { total: number; bills: unknown[] } | null,
  introduced: Date,
  latest: Date,
  subjects: string[],
) {
  expect(result).toStrictEqual({
    total: 3,
    bills: [
      {
        id: 'bill-B',
        congress: 119,
        billType: 'hr',
        billNumber: '2',
        title: 'Research B',
        introducedDate: introduced,
        sponsorName: 'Sponsor B',
        sponsorParty: 'I',
        sponsorState: 'VA',
        latestActionText: 'Reported',
        latestActionDate: latest,
        policyArea: 'Science',
        subjects,
      },
      {
        id: 'bill-A',
        congress: 119,
        billType: 's',
        billNumber: '1',
        title: 'Research A',
        introducedDate: null,
        sponsorName: null,
        sponsorParty: null,
        sponsorState: null,
        latestActionText: null,
        latestActionDate: null,
        policyArea: null,
        subjects: [],
      },
    ],
  });
  const first = result!.bills[0]! as Record<string, unknown>;
  expect(first.introducedDate).toBe(introduced);
  expect(first.latestActionDate).toBe(latest);
  expect(first.subjects).toBe(subjects);
}

function assertTrackedRows(
  result: { total: number; bills: unknown[] } | null,
  latest: Date,
  subjects: string[],
  actions: string[],
) {
  expect(result).toStrictEqual({
    total: 3,
    bills: [
      {
        identifier: 'bill-B',
        title: 'Research B',
        latestActionDate: latest,
        latestActionText: 'Reported',
        status: 'reported',
        actionTexts: actions,
        sponsorName: 'Sponsor B',
        sponsorParty: 'I',
        subjectNames: subjects,
      },
      {
        identifier: 'bill-A',
        title: 'Research A',
        latestActionDate: null,
        latestActionText: null,
        status: undefined,
        actionTexts: undefined,
        sponsorName: null,
        sponsorParty: null,
        subjectNames: [],
      },
    ],
  });
  const first = result!.bills[0]! as Record<string, unknown>;
  expect(first.latestActionDate).toBe(latest);
  expect(first.actionTexts).toBe(actions);
  expect(first.subjectNames).toBe(subjects);
}

installHooks();

it.each(methods)(
  '%s skips empty, blank and normalized nine-character queries without provider or database I/O',
  async (method) => {
    const h = harness();
    for (const terms of [[], [' \t '], ['123456789']]) {
      await expect(h.subject[method](terms)).resolves.toBeNull();
    }
    expect(h.calls).toEqual([]);
    expect(h.embedding).not.toHaveBeenCalled();
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
    expect(messages(h)).toEqual([]);
  },
);

it.each(methods)(
  '%s starts retrieval at the ten-character boundary and normalizes whitespace without changing term order',
  async (method) => {
    const h = harness({ embedding: [0.1, 0.2] });
    await expect(h.subject[method](['1234567890'])).resolves.toBeNull();
    await expect(h.subject[method](['  Research   ', '\tPolicy '])).resolves.toBeNull();
    expect(h.embedding.mock.calls.map((call) => call[0])).toEqual([
      '1234567890',
      'Research . Policy',
    ]);
    expect(h.callsOf('embeddingCandidates')).toHaveLength(2);
    expect(h.callsOf('billRows')).toHaveLength(0);
  },
);

it.each(methods)(
  '%s refuses an all-invalid candidate set without a hydration query',
  async (method) => {
    const h = harness({
      embedding: [0.1, 0.2],
      rows: {
        embeddingCandidates: [
          { source_id: null, score: 0.9 },
          { source_id: 17, score: 0.9 },
          { source_id: '', score: 0.9 },
          { source_id: '  ', score: 0.9 },
        ],
      },
    });
    await expect(h.subject[method](['Research policy'])).resolves.toBeNull();
    expect(h.callsOf('embed')).toHaveLength(1);
    expect(h.callsOf('embeddingCandidates')).toHaveLength(1);
    expect(h.callsOf('billRows')).toHaveLength(0);
    expect(messages(h)).toEqual([]);
  },
);

it('relevant embeddings use the fixed .65/150/25 SQL contracts and retain hydrated order, dates and array references', async () => {
  const subjects = ['Research'];
  const introduced = new Date('2026-01-02T00:00:00.000Z');
  const latest = new Date('2026-02-03T00:00:00.000Z');
  const first = billRow({
    id: 'bill-B',
    congress: 119,
    bill_type: 'hr',
    bill_number: '2',
    title: 'Research B',
    introduced_date: introduced,
    sponsor_name: 'Sponsor B',
    sponsor_party: 'I',
    sponsor_state: 'VA',
    latest_action_text: 'Reported',
    latest_action_date: latest,
    policy_area: 'Science',
    subjects,
  });
  const second = billRow({
    id: 'bill-A',
    congress: 119,
    bill_type: 's',
    bill_number: '1',
    title: 'Research A',
    introduced_date: null,
    sponsor_name: null,
    sponsor_party: null,
    sponsor_state: null,
    latest_action_text: null,
    latest_action_date: null,
    policy_area: null,
    subjects: null,
  });
  const h = harness({
    embedding: [0.1, 0.2],
    rows: {
      embeddingCandidates: [
        { source_id: ' bill-A ', score: 0.99 },
        { source_id: 'bill-B', score: 0.8 },
        { source_id: 'bill-A', score: 0.7 },
        { source_id: 'bill-C', score: 0.01 },
        { source_id: null, score: 1 },
      ],
      billRows: [first, second],
    },
  });
  const result = await h.subject.findRelevantBillsByEmbeddings(['Research policy']);
  expect(h.callsOf('embeddingCandidates')[0]!.query!.sql).toBe(candidateSql(150));
  expect(h.callsOf('embeddingCandidates')[0]!.query!.values).toEqual([
    '[0.1,0.2]',
    EMBEDDING_MODEL,
    0.65,
  ]);
  expect(h.callsOf('billRows')[0]!.query!.values).toEqual([['bill-A', 'bill-B', 'bill-C']]);
  expect(compactSql(h.callsOf('billRows')[0]!.query!.sql)).toContain(
    'ORDER BY cb.latest_action_date DESC NULLS LAST LIMIT 25',
  );
  assertRelevantRows(result, introduced, latest, subjects);
  expect(h.events).toEqual(['embed', 'embeddingCandidates', 'billRows']);
  expect(h.prisma.$transaction).not.toHaveBeenCalled();
});

it('tracked embeddings preserve .65/200/50 and their distinct optional status/action/reference shape', async () => {
  const latest = new Date('2026-02-03T00:00:00.000Z');
  const subjects = ['Research'];
  const actions = ['Reported'];
  const first = billRow({
    id: 'bill-B',
    title: 'Research B',
    latest_action_date: latest,
    latest_action_text: 'Reported',
    status: 'reported',
    action_texts: actions,
    sponsor_name: 'Sponsor B',
    sponsor_party: 'I',
    subjects,
  });
  const second = billRow({
    id: 'bill-A',
    title: 'Research A',
    latest_action_date: null,
    latest_action_text: null,
    status: undefined,
    action_texts: undefined,
    sponsor_name: null,
    sponsor_party: null,
    subjects: null,
  });
  const h = harness({
    embedding: [0.1, 0.2],
    rows: {
      embeddingCandidates: [
        { source_id: ' bill-A ', score: 0.99 },
        { source_id: 'bill-B', score: 0.8 },
        { source_id: 'bill-A', score: 0.7 },
        { source_id: 'bill-C', score: 0.01 },
      ],
      billRows: [first, second],
    },
  });
  const result = await h.subject.findTrackedBillsByEmbeddings(['Research policy']);
  expect(h.callsOf('embeddingCandidates')[0]!.query!.sql).toBe(candidateSql(200));
  expect(h.callsOf('embeddingCandidates')[0]!.query!.values).toEqual([
    '[0.1,0.2]',
    EMBEDDING_MODEL,
    0.65,
  ]);
  expect(h.callsOf('billRows')[0]!.query!.values).toEqual([['bill-A', 'bill-B', 'bill-C']]);
  expect(compactSql(h.callsOf('billRows')[0]!.query!.sql)).toContain(
    'ORDER BY cb.latest_action_date DESC NULLS LAST LIMIT 50',
  );
  expect(compactSql(h.callsOf('billRows')[0]!.query!.sql)).toContain(
    'ARRAY(SELECT a.text FROM congress_bill_action a WHERE a.bill_id = cb.id) AS action_texts',
  );
  assertTrackedRows(result, latest, subjects, actions);
  expect(h.events).toEqual(['embed', 'embeddingCandidates', 'billRows']);
});

it.each([0, 0.81])(
  'tracked embeddings bind the supplied floor %s without changing its value',
  async (floor) => {
    const h = harness({ embedding: [0.1, 0.2] });
    await expect(
      h.subject.findTrackedBillsByEmbeddings(['Research policy'], floor),
    ).resolves.toBeNull();
    expect(h.callsOf('embeddingCandidates')[0]!.query!.values[2]).toBe(floor);
  },
);

it.each(methods)(
  '%s returns null without warning when valid candidates hydrate to no bill rows',
  async (method) => {
    const h = harness({
      embedding: [0.1, 0.2],
      rows: { embeddingCandidates: [{ source_id: 'bill-A', score: 0.9 }], billRows: [] },
    });
    await expect(h.subject[method](['Research policy'])).resolves.toBeNull();
    expect(h.events).toEqual(['embed', 'embeddingCandidates', 'billRows']);
    expect(messages(h)).toEqual([]);
  },
);

it.each(methods)(
  '%s isolates provider, candidate-query and hydration failures without running keyword itself',
  async (method) => {
    for (const operation of ['embed', 'embeddingCandidates', 'billRows']) {
      const error = new Error(`${operation} failed`);
      const h = harness({
        embedding: operation === 'embed' ? error : [0.1, 0.2],
        errors: operation === 'embed' ? {} : { [operation]: error },
        rows: { embeddingCandidates: [{ source_id: 'bill-A', score: 0.9 }] },
      });
      await expect(h.subject[method](['Research policy'])).resolves.toBeNull();
      const prefix = method === 'findRelevantBillsByEmbeddings' ? 'Issue-bill' : 'Tracked-bills';
      expect(messages(h)).toEqual([
        `${prefix} embeddings lookup failed, falling back to keyword matcher: ${operation} failed`,
      ]);
      expect(h.callsOf('keywordCount')).toHaveLength(0);
      expect(h.callsOf('keywordRows')).toHaveLength(0);
      expect(h.events).toEqual(
        operation === 'embed'
          ? ['embed']
          : operation === 'embeddingCandidates'
            ? ['embed', 'embeddingCandidates']
            : ['embed', 'embeddingCandidates', 'billRows'],
      );
    }
  },
);
