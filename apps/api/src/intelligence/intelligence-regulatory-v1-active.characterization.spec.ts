import {
  deferred,
  harness,
  installHooks,
  rawRegulationRow,
} from '../../test/fixtures/intelligence-alerts.js';

installHooks();

it('regulatory active search refuses an empty name and fallback-term set without FR queries', async () => {
  const h = harness();
  expect(await h.subject.findActiveRegulations([])).toEqual({ total: 0, documents: [] });
  expect(h.calls).toEqual([]);
  expect(await h.subject.findActiveRegulations(['UNKNOWN'])).toEqual({ total: 0, documents: [] });
  expect(h.calls.map((call) => call.operation)).toEqual(['issueNames']);
  expect(h.callsOf('issueNames')[0]!.query).toMatchObject({
    sql: 'SELECT name FROM lda_issue_code WHERE code = ANY($1::text[])',
    values: [['UNKNOWN']],
  });
});

it('regulatory active search preserves regex escaping, untrimmed duplicates and full-count projection', async () => {
  const codes = ['HCR', 'HCR'];
  const agencies = ['FDA'];
  const topics = ['health'];
  const row = rawRegulationRow({ agency_names: agencies, topics });
  const h = harness({
    rows: {
      issueNames: [{ name: 'Health+Care' }],
      regulationCount: [{ total: 9007199254740993n }],
      activeDocuments: [row],
    },
  });
  const result = await h.subject.findActiveRegulations(codes, ['Health+Care', ' R&D ', '']);
  const patterns = ['\\mhealth\\+care\\M', '\\mhealth\\+care\\M', '\\m r&d \\M', '\\m\\M'];
  expect(result.total).toBe(9007199254740992);
  expect(result.documents).toEqual([
    {
      id: 'doc-one',
      documentNumber: '2026-100',
      type: 'PROPOSED_RULE',
      title: 'Rule title',
      agencyNames: agencies,
      topics,
      commentEndDate: row.comment_end_date,
      publicationDate: row.publication_date,
      significantRule: false,
      htmlUrl: null,
    },
  ]);
  expect(result.documents[0]!.agencyNames).toBe(agencies);
  expect(result.documents[0]!.publicationDate).toBe(row.publication_date);
  expect(h.calls.map((call) => call.operation)).toEqual([
    'issueNames',
    'regulationCount',
    'activeDocuments',
  ]);
  expect(h.callsOf('issueNames')[0]!.query!.values[0]).toBe(codes);
  expect(h.callsOf('regulationCount')[0]!.query).toMatchObject({
    sql: 'SELECT COUNT(*)::bigint AS total FROM federal_register_document WHERE comment_end_date > NOW() AND ( EXISTS ( SELECT 1 FROM unnest(topics) t WHERE LOWER(t) ~ ANY($1::text[]) ) OR LOWER(title) ~ ANY($2::text[]) )',
    values: [patterns, patterns],
  });
  expect(h.callsOf('activeDocuments')[0]!.query).toMatchObject({
    sql: 'SELECT id, document_number, type, title, agency_names, topics, comment_end_date, publication_date, significant_rule, html_url FROM federal_register_document WHERE comment_end_date > NOW() AND ( EXISTS ( SELECT 1 FROM unnest(topics) t WHERE LOWER(t) ~ ANY($1::text[]) ) OR LOWER(title) ~ ANY($2::text[]) ) ORDER BY comment_end_date ASC LIMIT 50',
    values: [patterns, patterns],
  });
  expect(h.callsOf('activeDocuments')[0]!.query!.values[0]).toBe(
    h.callsOf('regulationCount')[0]!.query!.values[0],
  );
  expect(h.calls.every((call) => call.scope === 'global')).toBe(true);
});

it('regulatory active search awaits names and count before launching the next global query', async () => {
  const names = deferred<unknown>();
  const count = deferred<unknown>();
  const h = harness({ results: { issueNames: names.promise, regulationCount: count.promise } });
  const pending = h.subject.findActiveRegulations(['HCR'], ['fallback']);
  await h.started('issueNames');
  expect(h.callsOf('regulationCount')).toEqual([]);
  names.resolve([{ name: 'Health' }]);
  await h.started('regulationCount');
  expect(h.callsOf('activeDocuments')).toEqual([]);
  count.resolve([{ total: 80n }]);
  expect(await pending).toEqual({ total: 80, documents: [] });
});

it.each<{ label: string; rows: unknown; total: number }>([
  { label: 'missing count', rows: [], total: 0 },
  { label: 'null count', rows: [{ total: null }], total: 0 },
  { label: 'numeric string count', rows: [{ total: '-3' }], total: -3 },
  { label: 'invalid count', rows: [{ total: 'bad' }], total: NaN },
])('regulatory active search preserves $label numeric behavior', async (example) => {
  const h = harness({ rows: { regulationCount: example.rows } });
  expect((await h.subject.findActiveRegulations([], ['hypersonic'])).total).toBe(example.total);
  expect(h.callsOf('issueNames')).toEqual([]);
});

it('regulatory active search keeps malformed term conversion fatal before count or document I/O', async () => {
  const h = harness({ rows: { issueNames: [{ name: null }] } });
  await expect(h.subject.findActiveRegulations(['BAD'])).rejects.toThrow(TypeError);
  expect(h.calls.map((call) => call.operation)).toEqual(['issueNames']);
});

it.each(['issueNames', 'regulationCount', 'activeDocuments'])(
  'regulatory active search propagates %s read failure',
  async (operation) => {
    const failure = new Error(`failed:${operation}`);
    const h = harness({
      rows: { issueNames: [{ name: 'Health' }] },
      errors: { [operation]: failure },
    });
    await expect(h.subject.findActiveRegulations(['HCR'])).rejects.toBe(failure);
    expect(h.callsOf(operation)).toHaveLength(1);
    if (operation !== 'activeDocuments') expect(h.callsOf('activeDocuments')).toEqual([]);
  },
);
