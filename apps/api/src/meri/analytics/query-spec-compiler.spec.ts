import { compileQuerySpec, QuerySpecError, type QuerySpec } from './query-spec-compiler.js';

describe('compileQuerySpec', () => {
  it('rejects an unlisted dataset', () => {
    expect(() =>
      compileQuerySpec({ dataset: 'tenants', select: [{ field: 'id' }] } as QuerySpec),
    ).toThrow(QuerySpecError);
  });

  it('rejects an unlisted field on a real dataset', () => {
    expect(() =>
      compileQuerySpec({
        dataset: 'lda_registrations',
        select: [{ field: 'ssn' }],
      }),
    ).toThrow(/Unknown field/);
  });

  it('rejects an unknown filter op', () => {
    expect(() =>
      compileQuerySpec({
        dataset: 'lda_registrations',
        select: [{ field: 'registrant_name' }],
        filters: [{ field: 'status', op: 'drop_table' as never, value: 'active' }],
      }),
    ).toThrow(/Unknown filter op/);
  });

  it('rejects filtering on a non-filterable field', () => {
    expect(() =>
      compileQuerySpec({
        dataset: 'news_articles',
        select: [{ field: 'source' }],
        filters: [{ field: 'categories', op: 'contains', value: 'x' }],
      }),
    ).toThrow(/cannot be filtered/);
  });

  it('always injects a LIMIT, clamped to the dataset max even when the caller asks for more', () => {
    const { sql } = compileQuerySpec({
      dataset: 'lda_registrations',
      select: [{ field: 'registrant_name' }],
      limit: 999999,
    });
    expect(sql).toMatch(/LIMIT 2000$/);
  });

  it('uses the dataset default limit when omitted', () => {
    const { sql } = compileQuerySpec({
      dataset: 'lda_registrations',
      select: [{ field: 'registrant_name' }],
    });
    expect(sql).toMatch(/LIMIT 200$/);
  });

  it('rejects a non-positive limit', () => {
    expect(() =>
      compileQuerySpec({
        dataset: 'lda_registrations',
        select: [{ field: 'registrant_name' }],
        limit: 0,
      }),
    ).toThrow(/positive number/);
  });

  it('compiles a known-good raw-column select to expected SQL + no params, with asOfDate defaulted', () => {
    const { sql, params, datasetKey } = compileQuerySpec({
      dataset: 'lda_registrations',
      select: [{ field: 'registrant_name' }, { field: 'client_name' }],
      limit: 10,
    });
    expect(datasetKey).toBe('lda_registrations');
    expect(sql).toContain('SELECT registrant_name AS registrant_name, client_name AS client_name FROM (');
    expect(sql).toContain('dt_posted <= $1');
    expect(sql).toMatch(/LIMIT 10$/);
    expect(params).toHaveLength(1);
    expect(params[0]).toBeInstanceOf(Date);
  });

  it('binds an explicit asOfDate as the first parameter', () => {
    const { sql, params } = compileQuerySpec({
      dataset: 'lda_registrations',
      select: [{ field: 'registrant_id' }],
      asOfDate: '2025-12-31T23:59:59Z',
    });
    expect(sql).toContain('dt_posted <= $1');
    expect(params[0]).toEqual(new Date('2025-12-31T23:59:59Z'));
  });

  it('rejects asOfDate on a dataset that does not support it', () => {
    expect(() =>
      compileQuerySpec({
        dataset: 'news_articles',
        select: [{ field: 'source' }],
        asOfDate: '2025-01-01',
      }),
    ).toThrow(/does not support asOfDate/);
  });

  it('rejects an invalid asOfDate', () => {
    expect(() =>
      compileQuerySpec({
        dataset: 'lda_registrations',
        select: [{ field: 'registrant_id' }],
        asOfDate: 'not-a-date',
      }),
    ).toThrow(/not a valid date/);
  });

  it('compiles the derived `status` field via its CASE expression, not a caller-supplied one', () => {
    const { sql } = compileQuerySpec({
      dataset: 'lda_registrations',
      select: [{ field: 'status' }],
    });
    expect(sql).toContain("CASE WHEN filing_type = ANY(ARRAY[");
    expect(sql).toContain('AS status');
  });

  it('compiles a bare COUNT(*) with no field', () => {
    const { sql } = compileQuerySpec({
      dataset: 'lda_registrations',
      select: [{ agg: 'count' }],
    });
    expect(sql).toBe(
      compileQuerySpec({ dataset: 'lda_registrations', select: [{ agg: 'count' }] }).sql,
    );
    expect(sql).toContain('COUNT(*) AS count_all');
  });

  it('compiles a grouped aggregate: registrant_name, count(*) group by registrant_name', () => {
    const { sql } = compileQuerySpec({
      dataset: 'lda_registrations',
      select: [{ field: 'registrant_name' }, { agg: 'count' }],
      groupBy: ['registrant_name'],
      filters: [{ field: 'status', op: 'eq', value: 'active' }],
      orderBy: [{ field: 'count_all', direction: 'desc' }],
      limit: 15,
    });
    expect(sql).toBe(
      "SELECT registrant_name AS registrant_name, COUNT(*) AS count_all FROM (" +
        `
      SELECT DISTINCT ON (registrant_id, client_id)
        registrant_id, client_id, registrant_name, client_name, client_state, filing_type, filing_year, dt_posted
      FROM lda_filing
      WHERE registrant_id IS NOT NULL AND client_id IS NOT NULL
        AND dt_posted <= $1
      ORDER BY registrant_id, client_id, dt_posted DESC
    ) lda_reg` +
        " WHERE (CASE WHEN filing_type = ANY(ARRAY[\n  '1T','1TY','1@','1@Y',\n  '2T','2TY','2@','2@Y',\n  '3T','3TY','3@','3@Y',\n  '4T','4TY','4@','4@Y',\n  'MT','MTY','M@','M@Y',\n  'YT','YTY','Y@','Y@Y'\n]) THEN 'terminated' ELSE 'active' END) = $2" +
        ' GROUP BY registrant_name ORDER BY count_all DESC LIMIT 15',
    );
  });

  it('rejects a select mixing an aggregate with a non-grouped raw field', () => {
    expect(() =>
      compileQuerySpec({
        dataset: 'lda_registrations',
        select: [{ field: 'registrant_name' }, { agg: 'count' }],
      }),
    ).toThrow(/not in groupBy/);
  });

  it('rejects grouping by a field absent from select', () => {
    expect(() =>
      compileQuerySpec({
        dataset: 'lda_registrations',
        select: [{ agg: 'count' }],
        groupBy: ['registrant_name'],
      }),
    ).toThrow(/must also appear as a non-aggregated select entry/);
  });

  it('rejects orderBy on a field that is not a select alias', () => {
    expect(() =>
      compileQuerySpec({
        dataset: 'lda_registrations',
        select: [{ field: 'registrant_name' }],
        orderBy: [{ field: 'client_name' }],
      }),
    ).toThrow(/must be one of the select aliases/);
  });

  it('rejects sum/avg on a non-numeric field', () => {
    expect(() =>
      compileQuerySpec({
        dataset: 'lda_registrations',
        select: [{ agg: 'sum', field: 'registrant_name' }],
      }),
    ).toThrow(/requires a numeric field/);
  });

  it('rejects an in-filter with a non-array value', () => {
    expect(() =>
      compileQuerySpec({
        dataset: 'lda_registrations',
        select: [{ field: 'registrant_name' }],
        filters: [{ field: 'client_state', op: 'in', value: 'VA' }],
      }),
    ).toThrow(/non-empty array/);
  });

  it('rejects a between-filter without exactly two values', () => {
    expect(() =>
      compileQuerySpec({
        dataset: 'federal_grants',
        select: [{ field: 'agency' }],
        filters: [{ field: 'award_ceiling', op: 'between', value: [1000] }],
      }),
    ).toThrow(/\[min, max\]/);
  });

  it('rejects a duplicate select alias', () => {
    expect(() =>
      compileQuerySpec({
        dataset: 'lda_registrations',
        select: [{ field: 'registrant_name' }, { field: 'registrant_name' }],
      }),
    ).toThrow(/Duplicate select alias/);
  });

  it('rejects more than 12 select entries', () => {
    const select = Array.from({ length: 13 }, () => ({ field: 'registrant_name' as const }));
    expect(() => compileQuerySpec({ dataset: 'lda_registrations', select })).toThrow(
      /at most 12 entries/,
    );
  });

  it('coerces and binds a contains filter as an ILIKE wildcard param, not interpolated text', () => {
    const { sql, params } = compileQuerySpec({
      dataset: 'lda_registrations',
      select: [{ field: 'registrant_name' }],
      filters: [{ field: 'registrant_name', op: 'contains', value: "'; DROP TABLE lda_filing; --" }],
    });
    expect(sql).not.toContain('DROP TABLE');
    expect(sql).toContain('ILIKE $2');
    expect(params[1]).toBe("%'; DROP TABLE lda_filing; --%");
  });

  it('rejects a non-string value for a string-typed filter', () => {
    expect(() =>
      compileQuerySpec({
        dataset: 'lda_registrations',
        select: [{ field: 'registrant_name' }],
        filters: [{ field: 'registrant_name', op: 'eq', value: 12345 }],
      }),
    ).toThrow(/expects a string/);
  });

  it('never emits a caller-supplied identifier: select alias is always the fixed field/agg name', () => {
    const { sql } = compileQuerySpec({
      dataset: 'lda_registrations',
      select: [{ agg: 'count', field: 'client_id' }],
    });
    expect(sql).toContain('AS count_client_id');
  });
});
