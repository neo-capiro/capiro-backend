import {
  committeeRow,
  employerRow,
  harness,
  installHooks,
  ldaRow,
  now,
} from '../../test/fixtures/intelligence-mapping.js';

installHooks();

describe('Mapping discovery input and I/O gates', () => {
  test.each([
    { method: 'searchLdaClients' as const, result: [] },
    { method: 'searchFecEmployers' as const, result: [] },
    { method: 'searchFecCommittees' as const, result: [] },
    { method: 'searchContractors' as const, result: { results: [], unsupportedIdentifier: null } },
    { method: 'searchAssistanceRecipients' as const, result: [] },
  ])('$method returns its empty contract before any I/O', async ({ method, result }) => {
    const h = harness();
    expect(await h.service[method](' \n ')).toEqual(result);
    expect(h.calls).toEqual([]);
  });
  test.each([
    { method: 'searchLdaClients' as const, operation: 'lda' },
    { method: 'searchFecEmployers' as const, operation: 'employers' },
    { method: 'searchFecCommittees' as const, operation: 'committees' },
    { method: 'searchContractors' as const, operation: 'contractors' },
    { method: 'searchAssistanceRecipients' as const, operation: 'assistance' },
  ])('$method propagates the catalog failure', async ({ method, operation }) => {
    const error = new Error('Catalog unavailable');
    const h = harness({ errors: { [operation]: error } });
    await expect(h.service[method]('Research')).rejects.toBe(error);
    expect(h.callsOf(operation)[0]!.scope).toBe('global');
    expect(h.transactions).toEqual([]);
  });
});

describe('LDA manual catalog search', () => {
  test.each([
    { query: ' 12 ', id: 12 },
    { query: '1e2', id: 100 },
    { query: '0x10', id: 16 },
    { query: '1.0', id: 1 },
    { query: '0', id: -1 },
    { query: '-2', id: -1 },
    { query: '1.5', id: -1 },
    { query: 'Acme', id: -1 },
  ])('uses the original numeric interpretation for $query', async ({ query, id }) => {
    const h = harness();
    await h.service.searchLdaClients(query);
    expect(h.callsOf('lda')[0]!.query!.values).toEqual([query.trim(), id, query.trim(), id]);
  });
  test('keeps trigram or exact-ID matching, descending footprint and the 25-row SQL cap', async () => {
    const h = harness({ rows: { lda: [ldaRow()] } });
    expect(await h.service.searchLdaClients('Acme')).toEqual([
      {
        id: '12',
        name: 'Acme Research',
        state: 'VA',
        totalFilings: 2,
        latestFilingYear: 2026,
        totalSpending: 1500,
        issueCodes: ['DEF'],
        similarity: 0.9,
      },
    ]);
    const sql = h.callsOf('lda')[0]!.query!.sql;
    expect(sql).toContain('similarity(name, ?) > 0.2 OR id = ?');
    expect(sql).toContain('ORDER BY similarity DESC, total_filings DESC');
    expect(sql).toContain('LIMIT 25');
  });
  test('coerces count and similarity only, retaining spend and issue-code array identity', async () => {
    const codes = ['DEF', 'DEF'];
    const h = harness({
      rows: {
        lda: [
          ldaRow({
            id: 0,
            total_filings: null,
            total_spending: '12.5',
            similarity: null,
            issue_codes: codes,
          }),
          ldaRow({ id: 1, issue_codes: null, total_filings: '4', similarity: '0.7' }),
        ],
      },
    });
    const result = await h.service.searchLdaClients('Research');
    expect(result[0]).toMatchObject({
      id: '0',
      totalFilings: 0,
      totalSpending: '12.5',
      similarity: 0,
    });
    expect(result[0]!.issueCodes).toBe(codes);
    expect(result[1]).toMatchObject({ totalFilings: 4, similarity: 0.7, issueCodes: [] });
  });
});

describe('FEC employer manual catalog search', () => {
  test('uses trimmed free text, grouped contribution footprint and the 25-row SQL cap', async () => {
    const h = harness({
      rows: {
        employers: [
          employerRow({ contribution_count: '4', similarity: '0.8', total_amount: '12.5' }),
        ],
      },
    });
    expect(await h.service.searchFecEmployers(' Acme ')).toEqual([
      {
        id: 'Acme Research',
        name: 'Acme Research',
        contributionCount: 4,
        totalAmount: '12.5',
        latestYear: 2026,
        similarity: 0.8,
      },
    ]);
    const query = h.callsOf('employers')[0]!.query!;
    expect(query.values).toEqual(['Acme', 'Acme']);
    expect(query.sql).toContain('contributor_employer IS NOT NULL');
    expect(query.sql).toContain('GROUP BY contributor_employer');
    expect(query.sql).toContain('ORDER BY similarity DESC, total_amount DESC');
    expect(query.sql).toContain('LIMIT 25');
  });
  test('keeps null totals/year and zero defaults without normalizing employer text', async () => {
    const h = harness({
      rows: {
        employers: [
          employerRow({
            employer: ' Acme ',
            contribution_count: null,
            total_amount: null,
            latest_year: null,
            similarity: null,
          }),
        ],
      },
    });
    expect(await h.service.searchFecEmployers('Acme')).toEqual([
      {
        id: ' Acme ',
        name: ' Acme ',
        contributionCount: 0,
        totalAmount: null,
        latestYear: null,
        similarity: 0,
      },
    ]);
  });
});

describe('FEC committee manual catalog search', () => {
  test('normalizes only exact committee-ID bindings and retains catalog PAC filters/order/cap', async () => {
    const h = harness({ rows: { committees: [committeeRow()] } });
    expect(await h.service.searchFecCommittees(' c12345678 ')).toEqual([
      {
        id: 'C12345678',
        name: 'Research PAC',
        committeeType: 'Q',
        active: null,
        cycle: 2026,
        sourceSyncedAt: now.toISOString(),
      },
    ]);
    const query = h.callsOf('committees')[0]!.query!;
    expect(query.values).toEqual(['C12345678', 'c12345678', 'C12345678', 'c12345678']);
    expect(query.sql).toContain("committee_type IN ('Q', 'N', 'O', 'V', 'W')");
    expect(query.sql).toContain('ORDER BY (id = ?) DESC, similarity(name, ?) DESC, name');
    expect(query.sql).toContain('LIMIT 25');
  });
  test('returns latest raw cycle and null official status while retaining missing-sync defaults', async () => {
    const h = harness({
      rows: {
        committees: [
          committeeRow({ cycles: [2026, 2022, 2026], active: true }),
          committeeRow({ id: 'C00000001', cycles: [], last_synced_at: null, committee_type: null }),
        ],
      },
    });
    const result = await h.service.searchFecCommittees('Research');
    expect(result[0]).toMatchObject({ cycle: 2026, active: null });
    expect(result[1]).toMatchObject({
      cycle: null,
      active: null,
      sourceSyncedAt: null,
      committeeType: null,
    });
  });
  test('keeps nonfinite catalog cycle behavior', async () => {
    const h = harness({ rows: { committees: [committeeRow({ cycles: [2026, NaN] })] } });
    expect((await h.service.searchFecCommittees('Research'))[0]!.cycle).toBeNaN();
  });
  test('propagates invalid catalog Date conversion', async () => {
    const h = harness({
      rows: { committees: [committeeRow({ last_synced_at: new Date('invalid') })] },
    });
    await expect(h.service.searchFecCommittees('Research')).rejects.toBeInstanceOf(RangeError);
  });
});
