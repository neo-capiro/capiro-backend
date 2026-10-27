import { compilePublicSql, compileScopedSql, PublicSqlError, type SqlCompilerRelation } from './sql-query-compiler.js';

describe('authored PostgreSQL SELECT compiler', () => {
  const compile = (sql: string, parameters: unknown[] = [], rowLimit?: number) => compilePublicSql({ sql, parameters, ...(rowLimit ? { rowLimit } : {}) });
  it('regenerates a real CTE/join/aggregate, binds parameters, and projects only public fields', () => {
    const query = compile(`WITH matched AS (SELECT DISTINCT p.pe_code FROM program_element_projects p WHERE p.mission ILIKE $1)
      SELECT SUM(b.amount) AS parent_total FROM matched m INNER JOIN program_element_budget_positions b ON b.pe_code = m.pe_code
      WHERE b.position_cycle = $2 AND b.asserted_fy = $3 AND b.value_kind = $4`, ['%drone%', 'pb_fy2026', 2026, 'total'], 12);
    expect(query.params).toEqual(['%drone%', 'pb_fy2026', 2026, 'total']);
    expect(query.sql).toContain('SUM("b".amount)');
    expect(query.sql).toContain('"public"."program_element_project"');
    expect(query.sql).toContain('"parent_total"::text');
    expect(query.sql).toContain('LIMIT 13');
    expect(query.sql).not.toContain('%drone%');
    expect(query.sql).not.toContain('metadata_jsonb');
    expect(query.columns).toEqual([{ name: 'parent_total', type: 'decimal', nullable: true, unit: 'value_kind dependent' }]);
    expect(query.relationsUsed).toEqual(['program_element_projects', 'program_element_budget_positions']);
  });
  it('preserves canonical ID lineage through a CTE and left join nullability', () => {
    const query = compile(`WITH bills AS (SELECT DISTINCT b.id FROM congress_bills b INNER JOIN congress_bill_subjects s ON s.bill_id=b.id WHERE s.name=$1)
      SELECT c.bill_id, c.bioguide_id, m.full_name AS canonical_name FROM bills b INNER JOIN congress_bill_cosponsors c ON c.bill_id=b.id
      LEFT JOIN congress_members m ON m.bioguide_id=c.bioguide_id WHERE c.withdrawn_date IS NULL`, ['Drones']);
    expect(query.columns).toEqual([{ name: 'bill_id', type: 'string', nullable: false }, { name: 'bioguide_id', type: 'string', nullable: false }, { name: 'canonical_name', type: 'string', nullable: true }]);
  });
  it('preserves explicit LIMIT as query coverage and adds a separate sentinel bound', () => {
    const query = compile('SELECT b.id FROM congress_bills b LIMIT 1', [], 20);
    expect(query.sqlLimit).toBe(1); expect(query.sql).toContain('LIMIT 1)'); expect(query.sql).toMatch(/LIMIT 21$/);
  });
  it('supports COUNT(*) and grouped counts with exact integer output', () => {
    const query = compile('SELECT b.congress, COUNT(*) AS total FROM congress_bills b GROUP BY b.congress ORDER BY total DESC');
    expect(query.columns).toEqual([{ name: 'congress', type: 'integer', nullable: false }, { name: 'total', type: 'integer', nullable: false }]);
    expect(query.sql).toContain('"total"::text');
  });
  it('filters retired PEs in the fixed physical projection', () => {
    expect(compile('SELECT p.pe_code FROM program_elements p').sql).toContain('retired_at IS NULL');
  });
  it.each([
    'SELECT b.id FROM congress_bills b; SELECT b.id FROM congress_bills b',
    'WITH gone AS (DELETE FROM congress_bills RETURNING id) SELECT id FROM gone',
    'WITH RECURSIVE bills AS (SELECT id FROM congress_bills) SELECT id FROM bills',
    'SELECT b.id INTO copied FROM congress_bills b',
    'SELECT b.id FROM congress_bills b FOR UPDATE',
    'SELECT c.id FROM clients c', 'SELECT b.id FROM public.congress_bill b', 'SELECT c.relname FROM pg_catalog.pg_class c',
    "SELECT set_config('role', 'capiro_app', false) AS value FROM congress_bills b",
    'SELECT pg_sleep(10) AS value FROM congress_bills b',
    'SELECT g.value FROM generate_series(1,3) AS g(value)',
    'SELECT p.metadata_jsonb FROM program_elements p',
    'WITH congress_bills AS (SELECT b.id FROM congress_bills b) SELECT id FROM congress_bills',
    'WITH limited AS (SELECT b.id FROM congress_bills b) SELECT title FROM limited',
    'SELECT b.id AS same, b.title AS same FROM congress_bills b',
    'SELECT b.id AS __proto__ FROM congress_bills b',
    'WITH limited AS (SELECT b.id FROM congress_bills b LIMIT 1) SELECT id FROM limited',
    'SELECT * FROM congress_bills', 'SELECT b.* FROM congress_bills b',
    'SELECT b.id FROM congress_bills b UNION SELECT b.id FROM congress_bills b',
    'SELECT b.id FROM congress_bills b CROSS JOIN congress_members m',
    'SELECT b.id FROM congress_bills b INNER JOIN congress_members m ON b.sponsor_name=m.full_name',
    'SELECT p.id FROM program_element_projects p INNER JOIN program_element_project_budget_positions b ON p.project_code=b.project_code',
    'SELECT b.id FROM congress_bills b WHERE b.id IN (SELECT id FROM congress_bills)',
    'SELECT b.id FROM congress_bills b WHERE b.title COLLATE "C" = $1',
    'SELECT b.id FROM congress_bills b ORDER BY random()',
    'SELECT b.id FROM congress_bills b LIMIT 1001', 'SELECT b.id FROM congress_bills b OFFSET 1',
    'SELECT COUNT(*) OVER () AS n FROM congress_bills b',
    'SELECT b.id::text AS id FROM congress_bills b',
  ])('rejects unsupported syntax before execution: %s', (sql) => expect(() => compile(sql)).toThrow(PublicSqlError));
  it.each([
    ['SELECT b.id FROM congress_bills b WHERE b.id=$1', []],
    ['SELECT b.id FROM congress_bills b', ['unused']],
    ['SELECT b.id FROM congress_bills b WHERE b.id=$2', ['unused', 'id']],
    ['SELECT b.id FROM congress_bills b WHERE b.id=$1', [{}]],
    ['SELECT b.id FROM congress_bills b WHERE b.id=$1', [Infinity]],
    ['SELECT b.id FROM congress_bills b WHERE b.id=$1', [9007199254740992]],
  ])('rejects parameter mismatch', (sql, parameters) => expect(() => compile(String(sql), parameters as unknown[])).toThrow(PublicSqlError));
  it('keeps SQL punctuation and exact decimals inside the separately bound value', () => {
    const attack = "x'; SELECT pg_sleep(100);--";
    const query = compile('SELECT b.id FROM congress_bills b WHERE b.title=$1', [attack]);
    expect(query.sql).not.toContain(attack); expect(query.params).toEqual([attack]);
    expect(compile('SELECT b.amount FROM program_element_budget_positions b WHERE b.amount=$1', ['9007199254740993.01']).params).toEqual(['9007199254740993.01']);
  });
  it.each([
    ['SELECT b.amount FROM program_element_budget_positions b WHERE b.amount=$1', '100.10', 'NUMERIC'],
    ['SELECT p.id FROM program_element_projects p WHERE p.id=$1', '10000000-0000-4000-8000-000000000001', 'UUID'],
    ['WITH projects AS (SELECT p.id AS project_id FROM program_element_projects p) SELECT project_id FROM projects WHERE project_id=$1', '10000000-0000-4000-8000-000000000001', 'UUID'],
    ['SELECT b.congress FROM congress_bills b WHERE b.congress=$1', '119', 'BIGINT'],
    ['SELECT b.introduced_date FROM congress_bills b WHERE b.introduced_date=$1', '2026-01-01', 'DATE'],
    ['SELECT b.last_synced_at FROM congress_bills b WHERE b.last_synced_at>$1', '2026-01-01T00:00:00Z', 'TIMESTAMPTZ'],
  ])('casts bound values using canonical field storage without coercing them', (sql, parameter, type) => {
    const result = compile(sql, [parameter]);
    expect(result.sql).toContain(`CAST($1 AS ${type})`); expect(result.params).toEqual([parameter]);
    expect(result.sql).not.toContain(parameter);
  });
  it('bounds input by UTF-8 bytes and parameter count', () => {
    expect(() => compile(`SELECT b.id FROM congress_bills b /* ${'字'.repeat(6000)} */`)).toThrow(PublicSqlError);
    expect(() => compile('SELECT b.id FROM congress_bills b WHERE b.id=$1', ['字'.repeat(11000)])).toThrow(PublicSqlError);
    expect(() => compile('SELECT b.id FROM congress_bills b', Array(65).fill(null))).toThrow(PublicSqlError);
  });
});

describe('server-selected private relation set', () => {
  // Synthetic projection metadata, not the unallocated client-owner production registry.
  const fields = (names: string[]) => names.map((name) => ({ name, type: 'string' as const, nullable: false, description: name, parameterType: 'UUID' as const }));
  const registry: readonly SqlCompilerRelation[] = [
    { name: 'client_objectives', schema: 'meri_private', table: 'client_objectives', fields: fields(['id', 'client_id']), primaryKey: ['client_id', 'id'], relationships: [] },
    { name: 'client_activity', schema: 'meri_private', table: 'client_activity', fields: fields(['id', 'client_id', 'objective_id']), primaryKey: ['id'],
      relationships: [{ fields: ['client_id', 'objective_id'], referencedRelation: 'client_objectives', referencedFields: ['client_id', 'id'], cardinality: 'many_to_one', integrity: 'soft' }] },
  ];
  it('uses the same SELECT/CTE/join/bind compiler with private physical views', () => {
    const query = compileScopedSql({ sql: `WITH linked AS (SELECT a.id, a.client_id, a.objective_id FROM client_activity a)
      SELECT a.id FROM linked a INNER JOIN client_objectives o ON a.objective_id=o.id AND a.client_id=o.client_id
      WHERE o.client_id=$1 AND a.id>$2 ORDER BY a.id LIMIT 25`, parameters: ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002'] }, registry);
    expect(query.sql).toContain('"meri_private"."client_activity"');
    expect(query.sql).toContain('CAST($2 AS UUID)');
    expect(query.sql).not.toContain('FROM "public"');
    expect(query.relationsUsed).toEqual(['client_objectives', 'client_activity']);
    expect(query.sqlLimit).toBe(25);
  });
  it.each(['a.objective_id=o.id', 'a.client_id=o.client_id'])('requires the whole private relationship: %s', (on) => {
    expect(() => compileScopedSql({ sql: `SELECT a.id FROM client_activity a LEFT JOIN client_objectives o ON ${on}`, parameters: [] }, registry))
      .toThrow('Join on every field of the published composite relationship.');
  });
  it('keeps the public wrapper fixed and refuses public/private mixing in either direction', () => {
    const input = { sql: 'SELECT o.id FROM client_objectives o', parameters: [] };
    expect(() => compilePublicSql(input)).toThrow(PublicSqlError);
    expect(() => compileScopedSql({ sql: 'SELECT b.id FROM congress_bills b', parameters: [] }, registry)).toThrow(PublicSqlError);
    expect(() => compileScopedSql({ sql: 'SELECT o.id FROM client_objectives o INNER JOIN congress_bills b ON o.id=b.id', parameters: [] }, registry)).toThrow(PublicSqlError);
    expect(() => compilePublicSql({ ...input, registry })).toThrow(PublicSqlError);
  });
  it.each([
    'SELECT a.metadata_jsonb FROM client_activity a',
    'SELECT a.id FROM meri_private.client_activity a',
    "SELECT set_config('app.current_user', $1, true) AS id FROM client_activity",
    'SET ROLE capiro_app; SELECT a.id FROM client_activity a',
    'SELECT a.id FROM client_activity a FOR UPDATE',
  ])('retains the closed grammar for private input: %s', (sql) => {
    expect(() => compileScopedSql({ sql, parameters: [] }, registry)).toThrow(PublicSqlError);
  });
});
