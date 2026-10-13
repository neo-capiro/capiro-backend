import { deferred, harness, installHooks } from '../../test/fixtures/intelligence-identity.js';

installHooks();

it('identity competitors refuses empty issue codes without any global read', async () => {
  const h = harness();
  expect(await h.subject.findCompetitors('Acme', [], [7])).toEqual({
    topBySpend: [],
    newEntrants: [],
  });
  expect(h.calls).toEqual([]);
});

it.each([
  { label: 'resolved full IDs', ids: [7, 2] },
  { label: 'unresolved names', ids: [] },
])('identity competitors preserves parameterized self-exclusion for $label', async (example) => {
  const codes = ['SCI', 'SCI'];
  const h = harness();
  await h.subject.findCompetitors(' Acme ', codes, example.ids);
  expect(h.calls.map((call) => call.operation)).toEqual(['competitorTop', 'competitorEntrants']);
  expect(h.callsOf('competitorTop')[0]!.query).toMatchObject({
    sql: 'SELECT c.name, c.total_spending::float as total_spending, c.issue_codes as shared_issues FROM lda_client c WHERE c.issue_codes && $1::text[] AND ( (cardinality($2::int[]) > 0 AND c.id <> ALL($3::int[])) OR (cardinality($4::int[]) = 0 AND similarity(c.name, $5) < 0.6) ) AND c.total_spending IS NOT NULL ORDER BY c.total_spending DESC LIMIT 10',
    values: [codes, example.ids, example.ids, example.ids, ' Acme '],
  });
  expect(h.callsOf('competitorEntrants')[0]!.query).toMatchObject({
    sql: 'SELECT c.name, MIN(f.dt_posted)::text as first_filing_date, c.issue_codes as issues FROM lda_client c JOIN lda_filing f ON f.client_id = c.id WHERE c.issue_codes && $1::text[] AND ( (cardinality($2::int[]) > 0 AND c.id <> ALL($3::int[])) OR (cardinality($4::int[]) = 0 AND similarity(c.name, $5) < 0.6) ) GROUP BY c.id, c.name, c.issue_codes HAVING MIN(f.dt_posted) >= $6 ORDER BY MIN(f.dt_posted) DESC LIMIT 5',
    values: [
      codes,
      example.ids,
      example.ids,
      example.ids,
      ' Acme ',
      new Date('2026-07-15T12:00:00.000Z'),
    ],
  });
  expect(h.callsOf('competitorTop')[0]!.query!.values[0]).toBe(codes);
  expect(h.callsOf('competitorTop')[0]!.query!.values[1]).toBe(example.ids);
  expect(h.calls.every((call) => call.scope === 'global' && call.tenantId === undefined)).toBe(
    true,
  );
});

it('identity competitors applies the default unresolved ID array without name trimming', async () => {
  const h = harness();
  await h.subject.findCompetitors(' Acme ', ['SCI']);
  expect(h.callsOf('competitorTop')[0]!.query!.values).toEqual([['SCI'], [], [], [], ' Acme ']);
});

it('identity competitors awaits top spend before capturing the entrant cutoff clock', async () => {
  const held = deferred<unknown>();
  const h = harness({ results: { competitorTop: held.promise } });
  const pending = h.subject.findCompetitors('Acme', ['SCI']);
  await h.started('competitorTop');
  expect(h.callsOf('competitorEntrants')).toEqual([]);
  jest.setSystemTime(new Date('2026-12-31T00:00:00.000Z'));
  held.resolve([]);
  expect(await pending).toEqual({ topBySpend: [], newEntrants: [] });
  expect(h.callsOf('competitorEntrants')[0]!.query!.values[5]).toEqual(
    new Date('2026-10-02T00:00:00.000Z'),
  );
});

it('identity competitors preserves row order, raw catalog scalars and issue-array references', async () => {
  const issues = ['SCI', 'DEF'];
  const rows = [
    { name: 'Second catalog result', total_spending: '-3', shared_issues: issues },
    { name: 'First catalog result', total_spending: 99, shared_issues: null },
  ];
  const h = harness({
    rows: {
      competitorTop: rows,
      competitorEntrants: [
        { name: 'New competitor', first_filing_date: 'raw timestamp text', issues },
      ],
    },
  });
  const result = await h.subject.findCompetitors('Acme', ['SCI'], [7]);
  expect(result).toEqual({
    topBySpend: [
      { name: 'Second catalog result', totalSpending: '-3', sharedIssues: issues },
      { name: 'First catalog result', totalSpending: 99, sharedIssues: null },
    ],
    newEntrants: [{ name: 'New competitor', firstFilingDate: 'raw timestamp text', issues }],
  });
  expect(result.topBySpend[0]!.sharedIssues).toBe(issues);
  expect(result.newEntrants[0]!.issues).toBe(issues);
  expect(rows[0]!.shared_issues).toBe(issues);
});

it.each(['competitorTop', 'competitorEntrants'])(
  'identity competitors propagates %s failure without a partial result',
  async (operation) => {
    const failure = new Error(`failed:${operation}`);
    const h = harness({ errors: { [operation]: failure } });
    await expect(h.subject.findCompetitors('Acme', ['SCI'])).rejects.toBe(failure);
    expect(h.callsOf(operation)).toHaveLength(1);
    if (operation === 'competitorTop') expect(h.callsOf('competitorEntrants')).toEqual([]);
  },
);
