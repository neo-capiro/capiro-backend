import { gateSqlStatement, nearestNames, SqlQueryError } from './sql-statement-gate.js';

const gate = (sql: string, parameters: unknown[] = [], rowLimit?: number) =>
  gateSqlStatement({ sql, parameters, ...(rowLimit ? { rowLimit } : {}) }, 'public');
const refusal = (sql: string, parameters: unknown[] = []) => {
  try {
    gate(sql, parameters);
  } catch (error) {
    if (error instanceof SqlQueryError) return error;
    throw error;
  }
  throw new Error(`expected a refusal for ${sql}`);
};

describe('statement gate', () => {
  it('passes the statement through verbatim inside the LIMIT wrapper with a sentinel bound', () => {
    const sql = "SELECT b.id, b.title FROM congress_bills b WHERE b.title ILIKE $1 -- find\n  AND b.congress = $2;";
    const gated = gate(sql, ['%drone%', 119], 12);
    expect(gated.sql).toBe(`SELECT * FROM (\n${sql.slice(0, -1)}\n) AS q LIMIT $3`);
    expect(gated.params).toEqual(['%drone%', 119, 13]);
    expect(gated).toMatchObject({ rowLimit: 12, sqlLimit: null, relationsUsed: ['congress_bills'], prefixLength: 16 });
    expect(gate('SELECT 1;; ').sql).toBe(['SELECT * FROM (', 'SELECT 1', ') AS q LIMIT $1'].join('\n'));
  });
  it('reads the model LIMIT for coverage only; the wrapper still caps the result', () => {
    expect(gate('SELECT b.id FROM congress_bills b LIMIT 1').sqlLimit).toBe(1);
    expect(gate('SELECT b.id FROM congress_bills b LIMIT 5 OFFSET 2').sqlLimit).toBe(5);
    expect(gate('SELECT b.id FROM congress_bills b LIMIT 5000', [], 10)).toMatchObject({ sqlLimit: 5000, rowLimit: 10 });
    expect(gate('SELECT b.id FROM congress_bills b LIMIT ALL').sqlLimit).toBeNull();
    expect(gate('WITH x AS (SELECT b.id FROM congress_bills b LIMIT 3) SELECT id FROM x').sqlLimit).toBeNull();
  });
  it('lists published relations in published order, through quoting and case', () => {
    expect(gate('SELECT 1 FROM "program_element_projects" p, CONGRESS_BILLS b').relationsUsed).toEqual(['congress_bills', 'program_element_projects']);
    expect(gate('SELECT $1::text AS congress_bills', ['x']).relationsUsed).toEqual(['congress_bills']);
  });
  it.each([
    ['SELECT 1; SELECT 2', 'UNSUPPORTED_SQL', 'Exactly one SELECT statement is required.'],
    ['DELETE FROM congress_bills', 'UNSUPPORTED_SQL', 'Only SELECT and WITH ... SELECT statements are supported.'],
    ['BEGIN', 'UNSUPPORTED_SQL', 'Only SELECT and WITH ... SELECT statements are supported.'],
    ['SET search_path = public', 'UNSUPPORTED_SQL', 'Only SELECT and WITH ... SELECT statements are supported.'],
    ['SHOW search_path', 'UNSUPPORTED_SQL', 'Only SELECT and WITH ... SELECT statements are supported.'],
    ['COPY (SELECT 1) TO STDOUT', 'UNSUPPORTED_SQL', 'Only SELECT and WITH ... SELECT statements are supported.'],
    ['LISTEN x', 'UNSUPPORTED_SQL', 'Only SELECT and WITH ... SELECT statements are supported.'],
    ['EXPLAIN ANALYZE SELECT 1', 'UNSUPPORTED_SQL', 'Only SELECT and WITH ... SELECT statements are supported.'],
    ['TABLE congress_bills', 'UNSUPPORTED_SQL', 'Only SELECT and WITH ... SELECT statements are supported.'],
    ['VALUES (1)', 'UNSUPPORTED_SQL', 'Only SELECT and WITH ... SELECT statements are supported.'],
    ['WITH gone AS (DELETE FROM congress_bills RETURNING id) SELECT id FROM gone', 'UNSUPPORTED_SQL', 'DELETE is not part of a read-only SELECT.'],
    ["WITH w AS (INSERT INTO congress_bills (id) VALUES ('x') RETURNING id) SELECT id FROM w", 'UNSUPPORTED_SQL', 'INSERT is not part of a read-only SELECT.'],
    ['SELECT b.id INTO TEMP copied FROM congress_bills b', 'UNSUPPORTED_SQL', 'INTO is not part of a read-only SELECT.'],
    ['SELECT pg_sleep(20)', 'UNSUPPORTED_SQL', 'pg_sleep is not available to query_capiro_data.'],
    ['SELECT pg_catalog."PG_SLEEP"(20)', 'UNSUPPORTED_SQL', 'PG_SLEEP is not available to query_capiro_data.'],
    ["SELECT set_config('app.current_tenant', 'x', true)", 'UNSUPPORTED_SQL', 'set_config is not available to query_capiro_data.'],
    ['SELECT pg_advisory_lock(1)', 'UNSUPPORTED_SQL', 'pg_advisory_lock is not available to query_capiro_data.'],
    ['SELECT pg_terminate_backend(1)', 'UNSUPPORTED_SQL', 'pg_terminate_backend is not available to query_capiro_data.'],
    ["SELECT lo_import('/etc/passwd')", 'UNSUPPORTED_SQL', 'lo_import is not available to query_capiro_data.'],
    ["SELECT 'unterminated", 'UNSUPPORTED_SQL', 'Unterminated string literal.'],
    ['SELECT (1', 'UNSUPPORTED_SQL', 'Unbalanced parentheses.'],
    ['SELECT o.id FROM client_objectives o', 'UNKNOWN_RELATION', 'client_objectives belongs to the client_records source; one query reads one source.'],
    ['SELECT a.id FROM meri_private.client_activity a', 'UNKNOWN_RELATION', 'meri_private belongs to the client_records source; one query reads one source.'],
  ])('refuses %s with %s', (sql, code, message) => {
    expect(refusal(sql)).toMatchObject({ code, message });
  });
  it('refuses the public source from the client-record side and the private vocabulary stays fixed', () => {
    expect(() => gateSqlStatement({ sql: 'SELECT b.id FROM congress_bills b', parameters: [] }, 'client_records')).toThrow(
      'congress_bills belongs to the public source; one query reads one source.',
    );
    expect(() => gateSqlStatement({ sql: 'SELECT 1 FROM meri_public.congress_bills', parameters: [] }, 'client_records')).toThrow(SqlQueryError);
    expect(gateSqlStatement({ sql: 'SELECT o.id FROM client_objectives o', parameters: [] }, 'client_records').relationsUsed).toEqual(['client_objectives']);
  });
  it('does not mistake words inside strings, comments or quoted identifiers for statements or functions', () => {
    expect(gate("SELECT 'DELETE; pg_sleep(1)' AS literal, $$ INSERT $$ AS dollar, E'\\'; UPDATE' AS escaped /* DELETE */ -- INSERT\n FROM congress_bills").relationsUsed).toEqual(['congress_bills']);
    expect(gate('SELECT b.id AS "pg_sleep" FROM congress_bills b').sql).toContain('"pg_sleep"');
    expect(gate('SELECT b.id AS pg_sleep FROM congress_bills b').relationsUsed).toEqual(['congress_bills']);
  });
  it.each([
    ['SELECT b.id FROM congress_bills b WHERE b.id=$1', []],
    ['SELECT b.id FROM congress_bills b', ['unused']],
    ['SELECT b.id FROM congress_bills b WHERE b.id=$2', ['unused', 'id']],
    ['SELECT b.id FROM congress_bills b WHERE b.id=$1', [{}]],
    ['SELECT b.id FROM congress_bills b WHERE b.id=$1', [Infinity]],
    ['SELECT b.id FROM congress_bills b WHERE b.id=$1', [9007199254740992]],
    ["SELECT b.id FROM congress_bills b WHERE b.id='$1'", ['quoted-is-literal']],
  ])('rejects parameter mismatch: %s %j', (sql, parameters) => {
    expect(refusal(sql, parameters).code).toBe('PARAMETER_MISMATCH');
  });
  it('keeps SQL punctuation inside the separately bound value', () => {
    const attack = "x'; SELECT pg_sleep(100);--";
    const gated = gate('SELECT b.id FROM congress_bills b WHERE b.title=$1', [attack]);
    expect(gated.sql).not.toContain(attack);
    expect(gated.params).toEqual([attack, 201]);
  });
  it.each([
    [{ sql: 'SELECT 1', parameters: [], rowLimit: 0 }, 'INVALID_QUERY'],
    [{ sql: 'SELECT 1', parameters: [], rowLimit: 1001 }, 'INVALID_QUERY'],
    [{ sql: 'SELECT 1', parameters: [], extra: true }, 'INVALID_QUERY'],
    [{ sql: '   ', parameters: [] }, 'INVALID_QUERY'],
    [{ sql: `SELECT 1 /* ${'字'.repeat(6000)} */`, parameters: [] }, 'INVALID_QUERY'],
    [{ sql: 'SELECT $1', parameters: ['字'.repeat(11000)] }, 'PARAMETER_MISMATCH'],
    [{ sql: 'SELECT 1', parameters: Array(65).fill(null) }, 'PARAMETER_MISMATCH'],
  ])('bounds request shape %j', (input, code) => {
    expect(() => gateSqlStatement(input, 'public')).toThrow(expect.objectContaining({ code }));
  });
  it('suggests nearest published names cheaply', () => {
    expect(nearestNames('congress_bill', ['congress_bills', 'congress_members', 'program_elements'])).toEqual(['congress_bills', 'congress_members']);
    expect(nearestNames('zzz', ['congress_bills'])).toEqual([]);
  });
});
