/**
 * Integration check for Meri's query_global_data against a REAL Postgres.
 *
 *   docker run -d --name x -e POSTGRES_USER=capiro -e POSTGRES_PASSWORD=capiro \
 *     -e POSTGRES_DB=capiro -p 55439:5432 pgvector/pgvector:pg16
 *   DATABASE_URL=postgresql://capiro:capiro@localhost:55439/capiro \
 *     npx prisma migrate deploy --schema=./prisma/schema.prisma
 *   ITEST_DATABASE_URL=postgresql://capiro:capiro@localhost:55439/capiro \
 *     npx tsx scripts/verify-meri-global-analytics-itest.ts
 *
 * What it proves that the unit tests cannot:
 *   1. The migration's role actually exists with SELECT-only grants and the
 *      role-level statement_timeout, after the FULL migration chain.
 *   2. The compiler's SQL — the DISTINCT ON subquery with a bound asOfDate,
 *      the derived CASE status, `= ANY($n)` with a JS array param, Date
 *      params, GROUP BY + ORDER BY alias — executes through Prisma's
 *      $queryRawUnsafe exactly as AnalyticsDbService runs it, as
 *      capiro_analytics_ro, and returns the expected numbers on a fixture.
 *   3. Rows come back JSON-safe (no BigInt) after normalizeRow.
 *   4. capiro_analytics_ro cannot write (INSERT/UPDATE/DDL all denied), and
 *      cannot read a table outside the allowlist.
 *
 * Exits non-zero on the first failed check.
 */
import { Client } from 'pg';
import { AnalyticsDbService } from '../src/meri/analytics/analytics-db.service.js';
import { compileQuerySpec, parseQuerySpecInput } from '../src/meri/analytics/query-spec-compiler.js';

const url = process.env.ITEST_DATABASE_URL;
if (!url) {
  console.error('ITEST_DATABASE_URL (superuser URL to the disposable Postgres) is required');
  process.exit(2);
}
const parsed = new URL(url);
const ANALYTICS_PASSWORD = 'itest-analytics-ro';

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail));
  }
}

async function main() {
  const admin = new Client({ connectionString: url });
  await admin.connect();

  // ---- 1. role shape from the real migration chain ------------------------
  const role = await admin.query(
    `SELECT rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolconfig
       FROM pg_roles WHERE rolname = 'capiro_analytics_ro'`,
  );
  check('role capiro_analytics_ro exists', role.rowCount === 1);
  const r = role.rows[0] ?? {};
  check('role is LOGIN, not super/createrole/createdb/bypassrls',
    r.rolcanlogin === true && !r.rolsuper && !r.rolcreaterole && !r.rolcreatedb && !r.rolbypassrls, r);
  check('role has statement_timeout=10s at the role level',
    Array.isArray(r.rolconfig) && r.rolconfig.includes('statement_timeout=10s'), r.rolconfig);

  const grants = await admin.query(
    `SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
       FROM information_schema.role_table_grants
      WHERE grantee = 'capiro_analytics_ro' GROUP BY table_name ORDER BY table_name`,
  );
  const grantMap = Object.fromEntries(grants.rows.map((x) => [x.table_name, x.privs]));
  const expectedTables = [
    'lda_filing', 'federal_grant', 'sam_opportunity', 'federal_award', 'sec_filing',
    'fara_registration', 'congress_bill', 'state_bill', 'gao_report', 'crs_report',
    'fec_committee', 'intel_article',
  ];
  check('SELECT granted on exactly the 12 allowlisted tables, nothing else',
    expectedTables.every((t) => grantMap[t] === 'SELECT') && Object.keys(grantMap).length === expectedTables.length,
    grantMap);
  check('no grant of any kind on meri_analytics_query_log', grantMap['meri_analytics_query_log'] === undefined);

  await admin.query(`ALTER ROLE capiro_analytics_ro PASSWORD '${ANALYTICS_PASSWORD}'`);

  // ---- 2. fixture: two registrants, four clients, one terminated, one re-filed after cutoff
  await admin.query(`DELETE FROM lda_filing`);
  const rows: Array<[string, string, number, string, number, string, string, string]> = [
    // uuid, type, year, posted, registrant_id, registrant_name, client_id, client_name
    ['f1', 'RR', 2024, '2024-01-15', 101, 'FIRM ALPHA', 1001, 'CLIENT ONE'],
    ['f2', 'Q1', 2025, '2025-04-15', 101, 'FIRM ALPHA', 1001, 'CLIENT ONE'],
    ['f3', 'RR', 2024, '2024-02-01', 101, 'FIRM ALPHA', 1002, 'CLIENT TWO'],
    ['f4', '2T', 2025, '2025-07-20', 101, 'FIRM ALPHA', 1002, 'CLIENT TWO'],       // terminated mid-2025
    ['f5', 'RR', 2025, '2025-03-01', 202, 'ACME CORP', 2001, 'ACME CORP'],           // in-house
    ['f6', 'Q4', 2025, '2026-01-20', 202, 'ACME CORP', 2001, 'ACME CORP'],           // posted AFTER 2025 cutoff
    ['f7', 'RR', 2025, '2025-09-01', 101, 'FIRM ALPHA', 1003, 'CLIENT THREE'],
    ['f8', '4TY', 2025, '2026-01-25', 101, 'FIRM ALPHA', 1003, 'CLIENT THREE'],      // terminated, but only after cutoff
  ];
  for (const [uuid, type, year, posted, rid, rname, cid, cname] of rows) {
    await admin.query(
      `INSERT INTO lda_filing (id, filing_uuid, filing_type, filing_year, dt_posted, registrant_id, registrant_name, client_id, client_name, client_state)
       VALUES (gen_random_uuid(), $1, $2, $3, $4::timestamptz, $5, $6, $7, $8, 'VA')`,
      [uuid, type, year, posted, rid, rname, cid, cname],
    );
  }

  // ---- 3. run through the real service as the analytics role ---------------
  process.env.ANALYTICS_DB_HOST = parsed.hostname;
  process.env.ANALYTICS_DB_PORT = parsed.port || '5432';
  process.env.ANALYTICS_DB_USER = 'capiro_analytics_ro';
  process.env.ANALYTICS_DB_PASSWORD = ANALYTICS_PASSWORD;
  process.env.ANALYTICS_DB_NAME = parsed.pathname.replace(/^\//, '');
  process.env.ANALYTICS_DB_SSLMODE = 'disable';
  const svc = new AnalyticsDbService();

  const run = (input: Record<string, unknown>) => svc.run(compileQuerySpec(parseQuerySpecInput(input)));

  // Active right now: 1001 (Q1), 2001 (Q4 in-house). 1002 terminated (2T), 1003 terminated (4TY).
  const now = await run({
    dataset: 'lda_registrations',
    select: [{ field: 'status' }, { agg: 'count' }],
    groupBy: ['status'],
    orderBy: [{ field: 'status' }],
  });
  check('current status counts: 2 active / 2 terminated',
    JSON.stringify(now) === JSON.stringify([{ status: 'active', count_all: 2 }, { status: 'terminated', count_all: 2 }]), now);
  check('COUNT(*) came back as a plain number, not BigInt', typeof now[0]?.count_all === 'number');
  check('result is JSON-serializable', (() => { try { JSON.stringify(now); return true; } catch { return false; } })());

  // As of 2025-12-31: 1001 active, 1002 terminated, 2001 active (f5 RR only), 1003 active (f7 RR; 4TY not yet posted)
  const eoy = await run({
    dataset: 'lda_registrations',
    select: [{ field: 'status' }, { agg: 'count' }],
    groupBy: ['status'],
    orderBy: [{ field: 'status' }],
    asOfDate: '2025-12-31T23:59:59Z',
  });
  check('as-of 2025-12-31 status counts: 3 active / 1 terminated',
    JSON.stringify(eoy) === JSON.stringify([{ status: 'active', count_all: 3 }, { status: 'terminated', count_all: 1 }]), eoy);

  const perFirm = await run({
    dataset: 'lda_registrations',
    select: [{ field: 'registrant_name' }, { agg: 'count_distinct', field: 'client_id' }],
    filters: [{ field: 'status', op: 'eq', value: 'active' }],
    groupBy: ['registrant_name'],
    orderBy: [{ field: 'count_distinct_client_id', direction: 'desc' }],
  });
  check('active clients per firm (current): ACME 1, FIRM ALPHA 1',
    JSON.stringify(perFirm) === JSON.stringify([{ registrant_name: 'ACME CORP', count_distinct_client_id: 1 }, { registrant_name: 'FIRM ALPHA', count_distinct_client_id: 1 }]) ||
    JSON.stringify(perFirm) === JSON.stringify([{ registrant_name: 'FIRM ALPHA', count_distinct_client_id: 1 }, { registrant_name: 'ACME CORP', count_distinct_client_id: 1 }]), perFirm);

  const inHouse = await run({
    dataset: 'lda_registrations',
    select: [{ field: 'is_in_house' }, { agg: 'count' }],
    groupBy: ['is_in_house'],
    orderBy: [{ field: 'is_in_house' }],
  });
  check('is_in_house derived boolean: 3 outside pairs, 1 in-house pair',
    JSON.stringify(inHouse) === JSON.stringify([{ is_in_house: false, count_all: 3 }, { is_in_house: true, count_all: 1 }]), inHouse);

  const inArr = await run({
    dataset: 'lda_registrations',
    select: [{ field: 'client_id' }],
    filters: [{ field: 'registrant_id', op: 'in', value: [101] }, { field: 'client_state', op: 'in', value: ['VA', 'MD'] }],
    orderBy: [{ field: 'client_id' }],
  });
  check('`in` filters bind JS arrays (number[] and string[]) via = ANY($n)',
    JSON.stringify(inArr) === JSON.stringify([{ client_id: 1001 }, { client_id: 1002 }, { client_id: 1003 }]), inArr);

  const dated = await run({
    dataset: 'lda_registrations',
    select: [{ field: 'client_id' }, { field: 'dt_posted' }],
    filters: [{ field: 'dt_posted', op: 'gte', value: '2026-01-01' }],
    orderBy: [{ field: 'client_id' }],
  });
  check('timestamp filter binds a Date and returns ISO strings',
    dated.length === 2 && dated.every((x) => typeof x.dt_posted === 'string' && (x.dt_posted as string).startsWith('2026-01')), dated);

  const contains = await run({
    dataset: 'lda_registrations',
    select: [{ field: 'client_name' }],
    filters: [{ field: 'client_name', op: 'contains', value: "'; drop table lda_filing; --" }],
  });
  check('hostile contains value is an inert ILIKE param (0 rows, table intact)', contains.length === 0);
  const stillThere = await admin.query(`SELECT count(*)::int AS n FROM lda_filing`);
  check('lda_filing still has all 8 fixture rows', stillThere.rows[0].n === 8);

  // ---- 4. negative: the role cannot write or read outside the allowlist -----
  const ro = new Client({
    host: parsed.hostname, port: Number(parsed.port || 5432), database: parsed.pathname.replace(/^\//, ''),
    user: 'capiro_analytics_ro', password: ANALYTICS_PASSWORD,
  });
  await ro.connect();
  const denied = async (label: string, sql: string) => {
    try {
      await ro.query(sql);
      check(`${label} is DENIED`, false, 'statement succeeded');
    } catch (e) {
      check(`${label} is DENIED`, /permission denied|must be owner/i.test((e as Error).message), (e as Error).message);
    }
  };
  await denied('INSERT into an allowlisted table', `INSERT INTO gao_report (id, title) VALUES ('X', 'x')`);
  await denied('UPDATE of an allowlisted table', `UPDATE lda_filing SET client_name = 'x'`);
  await denied('DELETE from an allowlisted table', `DELETE FROM lda_filing`);
  await denied('DDL on an allowlisted table', `ALTER TABLE lda_filing ADD COLUMN zzz text`);
  await denied('SELECT from tenants (not allowlisted)', `SELECT count(*) FROM tenants`);
  await denied('SELECT from clients (tenant data, not allowlisted)', `SELECT count(*) FROM clients`);
  await denied('INSERT into its own audit table', `INSERT INTO meri_analytics_query_log (id, dataset_key, sql) VALUES (gen_random_uuid(), 'x', 'x')`);
  const timeout = await ro.query(`SHOW statement_timeout`);
  check('session inherits role-level statement_timeout=10s', timeout.rows[0].statement_timeout === '10s', timeout.rows[0]);
  await ro.end();

  // capiro_app (default privileges) CAN write the audit table — that is who records it.
  const appCan = await admin.query(
    `SELECT has_table_privilege('capiro_app', 'meri_analytics_query_log', 'INSERT') AS ins,
            has_table_privilege('capiro_app', 'meri_analytics_query_log', 'SELECT') AS sel`,
  );
  check('capiro_app can INSERT+SELECT meri_analytics_query_log', appCan.rows[0].ins === true && appCan.rows[0].sel === true, appCan.rows[0]);

  await svc.onModuleDestroy();
  await admin.end();

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('\nall checks passed');
}

main().catch((e) => {
  console.error('itest crashed:', e);
  process.exit(1);
});
