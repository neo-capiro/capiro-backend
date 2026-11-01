import { AnalyticsDbService } from './analytics-db.service.js';
import { prepareReaderFixture } from './capiro-data-reader.fixture.js';
import { queryCapiroData } from './public-sql-query.js';
import { gateSqlStatement, SqlQueryError, type SqlQueryErrorCode } from './sql-statement-gate.js';

/**
 * The 58-statement audit corpus. Every statement records which layer decides
 * it: `gate` (the statement gate's own refusal, with its code), `postgres`
 * (admitted by the gate, refused by PostgreSQL under the reader role, with the
 * SQLSTATE) or `executes` (admitted and runs). The gate column always runs;
 * the PostgreSQL column runs against CAPIRO_DATA_TEST_DATABASE_URL when set.
 */
type Outcome = { layer: 'executes' } | { layer: 'gate'; code: SqlQueryErrorCode } | { layer: 'postgres'; sqlstate: string };
interface Case {
  sql: string;
  parameters?: (string | number | boolean | null)[];
  outcome: Outcome;
}
const executes: Outcome = { layer: 'executes' };
const gate = (code: SqlQueryErrorCode): Outcome => ({ layer: 'gate', code });
const postgres = (sqlstate: string): Outcome => ({ layer: 'postgres', sqlstate });

export const AUDIT_CORPUS: readonly Case[] = [
  // Accepted before and now.
  { sql: 'SELECT b.id, b.title FROM congress_bills b', outcome: executes },
  { sql: 'WITH recent AS (SELECT b.id FROM congress_bills b WHERE b.congress = $1) SELECT r.id FROM recent r', parameters: [119], outcome: executes },
  { sql: 'SELECT c.bill_id, m.full_name FROM congress_bill_cosponsors c INNER JOIN congress_members m ON m.bioguide_id = c.bioguide_id', outcome: executes },
  { sql: 'SELECT b.id FROM congress_bills b WHERE b.congress >= $1 AND b.title ILIKE $2 AND b.policy_area IS NULL', parameters: [118, '%act%'], outcome: executes },
  { sql: 'SELECT COUNT(*) AS bills, MAX(b.introduced_date) AS latest FROM congress_bills b', outcome: executes },
  { sql: 'SELECT b.congress, COUNT(*) AS n FROM congress_bills b GROUP BY b.congress HAVING COUNT(*) > 0 ORDER BY n DESC', outcome: executes },
  { sql: 'SELECT b.id FROM congress_bills b ORDER BY b.id LIMIT 2', outcome: executes },
  { sql: 'SELECT b.id FROM congress_bills b WHERE b.id = $1', parameters: ['119-hr-1'], outcome: executes },
  { sql: 'SELECT p.pe_code, SUM(x.amount) AS total FROM program_elements p INNER JOIN program_element_budget_positions x ON x.pe_code = p.pe_code GROUP BY p.pe_code', outcome: executes },
  { sql: 'SELECT s.name FROM congress_bill_subjects s LEFT JOIN congress_bills b ON b.id = s.bill_id WHERE b.status IS NOT NULL', outcome: executes },
  // Legitimate read-only SQL the old compiler refused; all execute now.
  { sql: "SELECT b.id FROM congress_bills b WHERE b.status = 'enacted'", outcome: executes },
  { sql: 'SELECT * FROM congress_bills', outcome: executes },
  { sql: 'SELECT b.* FROM congress_bills b', outcome: executes },
  { sql: "SELECT b.id FROM congress_bills b WHERE b.bill_type IN ('hr', 's')", outcome: executes },
  { sql: 'SELECT b.id FROM congress_bills b WHERE b.congress BETWEEN 117 AND 119', outcome: executes },
  { sql: "SELECT b.id FROM congress_bills b WHERE NOT b.status = 'enacted'", outcome: executes },
  { sql: "SELECT b.id FROM congress_bills b WHERE b.title LIKE '%Act%'", outcome: executes },
  { sql: "SELECT CASE WHEN b.status = 'enacted' THEN 1 ELSE 0 END AS enacted FROM congress_bills b", outcome: executes },
  { sql: "SELECT COALESCE(b.policy_area, 'none') AS area FROM congress_bills b", outcome: executes },
  { sql: 'SELECT b.congress::text AS congress FROM congress_bills b', outcome: executes },
  { sql: 'SELECT CAST(b.congress AS text) AS congress FROM congress_bills b', outcome: executes },
  { sql: 'SELECT b.congress + 1 AS next_congress, x.amount * 2 AS doubled FROM congress_bills b, program_element_budget_positions x', outcome: executes },
  { sql: 'SELECT lower(b.title) AS title FROM congress_bills b', outcome: executes },
  { sql: "SELECT date_trunc('month', b.introduced_date) AS month FROM congress_bills b", outcome: executes },
  { sql: 'SELECT EXTRACT(YEAR FROM b.introduced_date) AS year FROM congress_bills b', outcome: executes },
  { sql: 'SELECT b.id, COUNT(*) OVER () AS total FROM congress_bills b', outcome: executes },
  { sql: "SELECT COUNT(*) FILTER (WHERE b.status = 'enacted') AS enacted FROM congress_bills b", outcome: executes },
  { sql: 'SELECT b.id FROM congress_bills b WHERE b.id IN (SELECT s.bill_id FROM congress_bill_subjects s)', outcome: executes },
  { sql: 'SELECT b.id FROM congress_bills b ORDER BY b.id OFFSET 1', outcome: executes },
  { sql: 'SELECT b.id FROM congress_bills b UNION SELECT s.bill_id FROM congress_bill_subjects s', outcome: executes },
  { sql: 'SELECT b.id FROM congress_bills b ORDER BY b.introduced_date DESC NULLS LAST', outcome: executes },
  { sql: 'SELECT c.bill_id FROM congress_bill_cosponsors c WHERE c.is_original IS TRUE', outcome: executes },
  { sql: 'SELECT "b"."id" FROM "congress_bills" "b"', outcome: executes },
  { sql: 'SELECT B.ID FROM CONGRESS_BILLS B', outcome: executes },
  { sql: 'SELECT b.id FROM congress_bills b, congress_bill_subjects s WHERE s.bill_id = b.id', outcome: executes },
  { sql: 'SELECT COUNT(*) FROM congress_bills', outcome: executes },
  { sql: 'SELECT 1.5 AS ratio, x.amount / 2.0 AS half FROM program_element_budget_positions x', outcome: executes },
  { sql: 'SELECT DISTINCT ON (b.congress) b.congress, b.id FROM congress_bills b ORDER BY b.congress, b.id', outcome: executes },
  { sql: "SELECT string_agg(b.title, ', ' ORDER BY b.id) AS titles FROM congress_bills b", outcome: executes },
  { sql: "SELECT b.id FROM congress_bills b WHERE b.introduced_date >= CURRENT_DATE - INTERVAL '10 years'", outcome: executes },
  { sql: 'SELECT b.id FROM congress_bills b LEFT JOIN LATERAL (SELECT s.name FROM congress_bill_subjects s WHERE s.bill_id = b.id LIMIT 1) first_subject ON true', outcome: executes },
  // Unsafe or out of contract: refused by the gate (b/c) or by PostgreSQL (a).
  { sql: 'SELECT b.id FROM congress_bills b; SELECT 1', outcome: gate('UNSUPPORTED_SQL') },
  { sql: 'DELETE FROM congress_bills', outcome: gate('UNSUPPORTED_SQL') },
  { sql: 'WITH gone AS (DELETE FROM congress_bills RETURNING id) SELECT id FROM gone', outcome: gate('UNSUPPORTED_SQL') },
  { sql: 'SELECT b.id INTO copied FROM congress_bills b', outcome: gate('UNSUPPORTED_SQL') },
  { sql: 'SET ROLE capiro_app', outcome: gate('UNSUPPORTED_SQL') },
  { sql: 'SHOW search_path', outcome: gate('UNSUPPORTED_SQL') },
  { sql: 'EXPLAIN ANALYZE SELECT b.id FROM congress_bills b', outcome: gate('UNSUPPORTED_SQL') },
  { sql: 'COPY (SELECT 1) TO STDOUT', outcome: gate('UNSUPPORTED_SQL') },
  { sql: 'SELECT pg_sleep(20)', outcome: gate('UNSUPPORTED_SQL') },
  { sql: "SELECT set_config('app.current_tenant', $1, true)", parameters: ['a0000000-0000-4000-8000-000000000002'], outcome: gate('UNSUPPORTED_SQL') },
  { sql: 'SELECT b.id FROM congress_bills b WHERE b.id = $1', parameters: [], outcome: gate('PARAMETER_MISMATCH') },
  { sql: 'SELECT o.id FROM client_objectives o', outcome: gate('UNKNOWN_RELATION') },
  // FOR UPDATE: the gate's keyword rule answers first; PostgreSQL would refuse it too (42501, no UPDATE privilege on the view).
  { sql: 'SELECT b.id FROM congress_bills b FOR UPDATE', outcome: gate('UNSUPPORTED_SQL') },
  { sql: 'SELECT c.id FROM public.clients c', outcome: postgres('42501') },
  { sql: 'SELECT p.metadata_jsonb FROM program_elements p', outcome: postgres('42703') },
  { sql: 'SELECT c.relname FROM pg_catalog.pg_class c WHERE c.relname = $1', parameters: ['congress_bills'], outcome: executes },
  { sql: 'SELECT a.id FROM meri_private.client_activity a', outcome: gate('UNKNOWN_RELATION') },
];

describe('query_capiro_data audit corpus (statement gate)', () => {
  it('holds 58 statements', () => {
    expect(AUDIT_CORPUS).toHaveLength(58);
  });
  it.each(AUDIT_CORPUS.map((entry) => [entry.outcome.layer === 'gate' ? `gate:${entry.outcome.code}` : entry.outcome.layer, entry] as const))(
    '%s <- %j',
    (_label, entry) => {
      const run = () => gateSqlStatement({ sql: entry.sql, parameters: entry.parameters ?? [] }, 'public');
      if (entry.outcome.layer === 'gate') {
        const code = entry.outcome.code;
        expect(run).toThrow(SqlQueryError);
        try {
          run();
        } catch (error) {
          expect((error as SqlQueryError).code).toBe(code);
        }
      } else {
        const gated = run();
        expect(gated.sql).toContain(entry.sql.replace(/;\s*$/, ''));
        expect(gated.sql).toMatch(/\) AS q LIMIT \$\d+$/);
      }
    },
  );
});

const adminUrl = process.env.CAPIRO_DATA_TEST_DATABASE_URL;
(adminUrl ? describe : describe.skip)('query_capiro_data audit corpus (PostgreSQL under capiro_analytics_ro)', () => {
  jest.setTimeout(180_000);
  const analytics = new AnalyticsDbService();
  beforeAll(async () => {
    (await prepareReaderFixture(adminUrl!)).bindServiceEnv();
  });
  afterAll(() => analytics.onModuleDestroy());
  it.each(AUDIT_CORPUS.filter((entry) => entry.outcome.layer !== 'gate').map((entry) => [entry.outcome.layer === 'postgres' ? `postgres:${entry.outcome.sqlstate}` : 'executes', entry] as const))(
    '%s <- %j',
    async (_label, entry) => {
      const result = await queryCapiroData({ sql: entry.sql, parameters: entry.parameters ?? [], rowLimit: 5 }, analytics);
      if (entry.outcome.layer === 'postgres') {
        expect(result).toMatchObject({ ok: false, error: { sqlstate: entry.outcome.sqlstate } });
      } else {
        expect(result).toMatchObject({ ok: true });
        if (result.ok && 'rows' in result) expect(result.rowCount).toBe(result.rows.length);
      }
    },
  );
});
