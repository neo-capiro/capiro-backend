/** Rollback-only local proof: synthetic controls plus hash-bound original USAspending captures. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Client } from 'pg';
import type { ProcurementAccountReports } from '@capiro/shared';
import { fetchAccountPage, numericLexemeReviver, projectRows, FUNDING_ENDPOINT } from '../lib/procurement-account-reports.js';

const ROOT = 'C:/dev/defproc-release1-evidence/accounts-backend';
const DIRECTORY = 'C:/ProgramData/Hermes/profiles/kanbanqa/cache/scratch/pg16-fixture/data';
const MIGRATION = 'C:/dev/defproc-release1-backend/apps/api/prisma/migrations/20281104030000_defproc_account_reports/migration.sql';
const KEY = 'usaspending|award|CONT_AWD_0001_2100_-NONE-_-NONE-';
const OTHER = 'usaspending|award|CONT_AWD_0001_9700_-NONE-_-NONE-';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const number = (s: string) => (JSON as unknown as { rawJSON(s: string): unknown }).rawJSON(s);
const row = (obligation: string | null = '-1.50', outlay: string | null = null) => ({
  transaction_obligated_amount: obligation === null ? null : number(obligation),
  gross_outlay_amount: outlay === null ? null : number(outlay),
  federal_account: '017-1804', account_title: 'Synthetic account',
  funding_agency_name: 'Synthetic funding agency', awarding_agency_name: 'Synthetic awarding agency',
  object_class: '25.1', object_class_name: 'Synthetic object class', program_activity_code: '0004',
  program_activity_name: 'Synthetic activity', disaster_emergency_fund_code: 'Q',
  reporting_fiscal_year: 2024, reporting_fiscal_quarter: 4, reporting_fiscal_month: 12,
  is_quarterly_submission: false,
});
const metadata = { page: 1, hasNext: false, next: null, hasPrevious: false, previous: null };
const body = (rows: unknown[]) => JSON.stringify({ results: rows, page_metadata: metadata });

async function main() {
  assert.equal(process.env.DEFPROC_LOCAL_ACCOUNT_TEST, '1', 'explicit local opt-in required');
  assert(!process.env.DATABASE_URL && !process.env.PGPASSWORD, 'unset ambient database credentials');
  const c = new Client({ host: '127.0.0.1', port: 5558, user: 'capiro_master', database: 'capiro_fixture',
    connectionTimeoutMillis: 5000, statement_timeout: 30000, ssl: false });
  const checks: string[] = [];
  const checked = (name: string) => checks.push(name);
  await c.connect();
  const role = (name: 'capiro_master' | 'capiro_app' | 'capiro_defense_job') => c.query(`SET LOCAL ROLE ${name}`);
  const snapshot = async () => {
    const functions = (await c.query(`SELECT p.oid::regprocedure::text signature,
      pg_get_functiondef(p.oid) definition,p.proowner::regrole::text owner,p.proacl::text acl
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='defproc_v2_private' OR (n.nspname='public' AND p.proname LIKE 'defproc_%')
      ORDER BY p.oid::regprocedure::text COLLATE "C"`)).rows;
    const tables: Record<string, unknown> = {};
    const names = (await c.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'
      AND (tablename LIKE 'acquisition_%' OR tablename LIKE 'defproc_%') ORDER BY tablename`)).rows;
    for (const { tablename } of names) {
      assert(/^[a-z0-9_]+$/.test(tablename));
      tables[tablename] = (await c.query(`SELECT count(*)::text count,
        md5(coalesce(string_agg(to_jsonb(t)::text,chr(10) ORDER BY to_jsonb(t)::text COLLATE "C"),'')) hash
        FROM public."${tablename}" t`)).rows[0];
    }
    return { functions, tables };
  };
  const append = async (key: string, raw: string, observed = '2026-11-01T00:00:00.000000Z') => {
    await role('capiro_defense_job');
    return (await c.query('SELECT public.defproc_append_account_report_v1($1,$2,$3,$4) result',
      [key, observed, raw, hash(raw)])).rows[0].result as { snapshotId: string; inserted: boolean };
  };
  const read = async (keys: string[], at: string | null = null) => {
    await role('capiro_app');
    return (await c.query('SELECT public.defproc_account_reports_scope_v1($1,$2) result', [keys, at]))
      .rows[0].result as ProcurementAccountReports;
  };
  const refused = async (name: string, work: () => Promise<unknown>, code: string) => {
    await c.query('RESET ROLE'); await c.query('SAVEPOINT refusal');
    let error: { code?: string; message?: string } | undefined;
    try { await work(); } catch (e) { error = e as typeof error; }
    await c.query('ROLLBACK TO SAVEPOINT refusal'); await c.query('RELEASE SAVEPOINT refusal');
    assert.equal(error?.code, code, `${name}: expected ${code}, got ${error?.code ?? 'admitted'}`);
    checked(name); return error!;
  };
  let before: Awaited<ReturnType<typeof snapshot>> | undefined;
  try {
    const identity = (await c.query(`SELECT current_setting('data_directory') directory,
      current_database() db,current_user role,host(inet_server_addr()) address,inet_server_port() port`)).rows[0];
    assert.equal(identity.directory.replaceAll('\\', '/'), DIRECTORY);
    assert.equal(identity.db, 'capiro_fixture'); assert.equal(identity.role, 'capiro_master');
    assert.equal(identity.address, '127.0.0.1'); assert.equal(identity.port, 5558);
    assert.equal((await c.query("SELECT to_regclass('public.defproc_account_report_observation_v1') value")).rows[0].value, null);
    before = await snapshot();
    await c.query('BEGIN');
    try {
      const sql = readFileSync(MIGRATION, 'utf8');
      assert.equal((sql.match(/^BEGIN;$/gm) ?? []).length, 1);
      assert.equal((sql.match(/^COMMIT;$/gm) ?? []).length, 1);
      await c.query(sql.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, ''));
      const initial = body([row('-1.50'), row(null, '0.00'), row(null, '9007199254740993.123456')]);
      const first = await append(KEY, initial); assert.equal(first.inserted, true);
      assert.deepEqual(await append(KEY, initial), { snapshotId: first.snapshotId, inserted: false });
      const firstRead = await read([KEY, OTHER]);
      assert.equal(firstRead.reports[0]!.rows[0]!.reportedObligationUsd, '-1.50');
      assert.equal(firstRead.reports[0]!.rows[1]!.reportedGrossOutlayUsd, '0.00');
      assert.equal(firstRead.reports[0]!.rows[2]!.reportedGrossOutlayUsd, '9007199254740993.123456');
      assert.equal(firstRead.reports[1]!.state, 'unavailable');
      assert.equal(firstRead.reports[0]!.sourceUrl, `https://www.usaspending.gov/award/${KEY.slice(18)}`);
      checked('job append, exact replay, app read, signed/zero/null/high precision, missing observation and source URL');
      await refused('same-clock changed bytes', () => append(KEY, body([row('5')])), '23505');
      const changed = body([row('-2.25'), row(null, '0.00')]);
      await append(KEY, changed, '2026-11-02T00:00:00.000000Z');
      assert.equal((await read([KEY])).reports[0]!.rows[0]!.reportedObligationUsd, '-2.25');
      assert.equal((await read([KEY], firstRead.knownAt)).reports[0]!.rows[0]!.reportedObligationUsd, '-1.50');
      const integration = await read([KEY, OTHER]);
      mkdirSync(ROOT, { recursive: true });
      writeFileSync(`${ROOT}/native-payload.json`, JSON.stringify(integration, null, 2));
      checked('correction replaces snapshot; older knownAt preserves original; native integration payload captured');

      const integerKey = 'usaspending|award|CONT_AWD_INTEGER_9700_-NONE-_-NONE-';
      await append(integerKey, body([{ ...row(), reporting_fiscal_year: number('2024.0'), reporting_fiscal_quarter: number('4.0'), reporting_fiscal_month: number('12.0') }]));
      assert.equal((await read([integerKey])).reports[0]!.rows[0]!.reportingFiscalYear, 2024);
      checked('integer-valued source period numbers preserve their exact value');

      const valid = JSON.parse(body([row()]));
      const invalid: Array<[string, unknown]> = [
        ['missing results', { page_metadata: metadata }], ['primitive row', { ...valid, results: [7] }],
        ['string page', { ...valid, page_metadata: { ...metadata, page: '1' } }],
        ['string previous flag', { ...valid, page_metadata: { ...metadata, hasPrevious: 'false' } }],
      ];
      for (const field of Object.keys(row())) {
        const v = JSON.parse(body([row()])); delete v.results[0][field]; invalid.push([`missing ${field}`, v]);
      }
      for (const [field, bad] of [['gross_outlay_amount', '17'], ['gross_outlay_amount', { $numericLexeme: '17' }],
        ['funding_agency_name', true], ['account_title', 'bad\nlabel'], ['reporting_fiscal_year', 10000],
        ['reporting_fiscal_month', 13], ['is_quarterly_submission', 'false']] as const) {
        const v = JSON.parse(body([row()])); v.results[0][field] = bad; invalid.push([`wrong ${field}:${JSON.stringify(bad)}`, v]);
      }
      for (const [name, value] of invalid) await refused(name,
        () => append(OTHER, JSON.stringify(value), '2026-11-03T00:00:00.000000Z'), '22023');
      await refused('fractional source year', () => append(OTHER,
        body([{ ...row(), reporting_fiscal_year: number('2024.0000000000000001') }]), '2026-11-03T00:00:00.000000Z'), '22023');
      for (const who of ['capiro_app', 'capiro_defense_job'] as const) {
        await refused(`${who} denied raw read`, async () => { await role(who); return c.query('SELECT * FROM public.defproc_account_report_observation_v1'); }, '42501');
      }
      await refused('app denied writer', async () => { await role('capiro_app'); return c.query('SELECT public.defproc_append_account_report_v1($1,$2,$3,$4)', [OTHER, '2026-11-03T00:00:00.000000Z', initial, hash(initial)]); }, '42501');
      for (const command of ['UPDATE public.defproc_account_report_observation_v1 SET response_sha256=response_sha256', 'DELETE FROM public.defproc_account_report_observation_v1', 'TRUNCATE public.defproc_account_report_observation_v1']) {
        await refused(command.split(' ')[0] + ' blocked', async () => { await role('capiro_master'); return c.query(command); }, 'P0001');
      }
      await append(OTHER, body([]), '2026-11-03T00:00:00.000000Z');
      const empty = (await read([OTHER])).reports[0]!;
      assert.equal(empty.state, 'reported'); assert.equal(empty.rows.length, 0); assert(empty.snapshotId);
      checked('reported empty page differs from missing observation');

      await role('capiro_master');
      const ownerRights = (await c.query(`SELECT e.privilege_type FROM pg_class c,
        LATERAL aclexplode(c.relacl) e WHERE c.oid='public.defproc_account_report_observation_v1'::regclass
        AND e.grantee=c.relowner`)).rows.map(r => r.privilege_type);
      assert(ownerRights.includes('SELECT') && ownerRights.includes('INSERT')); checked('explicit non-superuser-owner data rights retained');
      const tieKey = 'usaspending|award|CONT_AWD_TIE_9700_-NONE-_-NONE-';
      const tie = async (raw1: string, raw2: string) => {
        await c.query('SAVEPOINT tied');
        await c.query(`INSERT INTO public.defproc_account_report_observation_v1
          (award_key,source_observed_at,recorded_at,raw_response,response_sha256,request_award_id)
          VALUES ($1,'2026-11-01',statement_timestamp(),$2,$3,$6),($1,'2026-11-02',statement_timestamp(),$4,$5,$6)`,
          [tieKey, raw1, hash(raw1), raw2, hash(raw2), tieKey.slice(18)]);
        const result = await read([tieKey]); await c.query('ROLLBACK TO tied'); await c.query('RELEASE SAVEPOINT tied'); return result;
      };
      assert.equal((await tie(initial, changed)).reports[0]!.state, 'conflict');
      const identical = await tie(initial, initial); assert.equal(identical.reports.length, 1); assert.equal(identical.reports[0]!.state, 'reported');
      checked('different-content ties withheld; identical-content ties select one observation');
      // Replay retained public source bytes, never label the replay as a fresh HTTP observation.
      const receipts = (JSON.parse(readFileSync(`${ROOT}/../official-source/source-receipts.json`, 'utf8')) as Array<{
        kind: string; status: number; url: string; requestedAwardId: string; request: unknown;
        artifact: string; sha256: string; observedAt: string; returnedRows: number;
      }>).filter(receipt => receipt.kind === 'funding');
      assert.equal(receipts.length, 3);
      const sourceRows = new Map<string, ReturnType<typeof projectRows>>();
      for (const receipt of receipts) {
        assert.equal(receipt.status, 200); assert.equal(receipt.url, FUNDING_ENDPOINT);
        const raw = readFileSync(receipt.artifact, 'utf8'); assert.equal(hash(raw), receipt.sha256);
        const admitted = await fetchAccountPage({ awardUniqueId: receipt.requestedAwardId, fetch: async (url, init) => {
          assert.equal(url, receipt.url); assert.deepEqual(JSON.parse(String(init?.body)), receipt.request);
          return new Response(raw);
        } });
        assert(admitted.ok); assert.equal(admitted.page.sha256, receipt.sha256);
        assert.equal(admitted.page.rowCount, receipt.returnedRows);
        const key = `usaspending|award|${receipt.requestedAwardId}`;
        const clock = receipt.observedAt.replace(/\+00:00$/, 'Z');
        assert.match(clock, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
        await append(key, raw, clock);
        sourceRows.set(key, projectRows(JSON.parse(raw, numericLexemeReviver).results));
      }
      const originalReports = await read([...sourceRows.keys()].sort());
      for (const report of originalReports.reports) {
        assert.equal(report.state, 'reported'); assert.deepEqual(report.rows, sourceRows.get(report.awardIdentityKey));
      }
      assert.equal(originalReports.reports.reduce((total, report) => total + report.rows.length, 0), 82);
      writeFileSync(`${ROOT}/original-source-native-payload.json`, JSON.stringify(originalReports, null, 2));
      checked('all 82 retained original source rows match native app-role projection exactly; original retrieval clocks retained');

      const capKeys = ['CAPA', 'CAPB'].map(id => `usaspending|award|CONT_AWD_${id}_9700_-NONE-_-NONE-`);
      const large = body(Array.from({ length: 100 }, () => ({ ...row(), account_title: 'é'.repeat(2048), program_activity_name: 'é'.repeat(2048) })));
      assert(Buffer.byteLength(large) <= 1_048_576);
      for (const key of capKeys) await append(key, large);
      assert.equal((await read([capKeys[0]!])).reports[0]!.rows.length, 100);
      const cap = await refused('actual combined response byte limit', () => read(capKeys), '54000');
      assert.match(cap.message!, /exceeds 1 MiB/);
      checked(`small UTF8 control admitted; full cap refused: ${cap.message}`);
    } finally { await c.query('ROLLBACK'); }
    assert.deepEqual(await snapshot(), before); checked('all existing table contents/functions/owners/ACL unchanged after rollback');
    assert.equal((await c.query("SELECT to_regclass('public.defproc_account_report_observation_v1') value")).rows[0].value, null);
    writeFileSync(`${ROOT}/parent-native-result.json`, JSON.stringify({ status: 'PASS', checks, count: checks.length,
      sourceHash: hash(readFileSync(MIGRATION, 'utf8')), testHash: hash(readFileSync(__filename, 'utf8')), afterRollbackVerified: true }, null, 2));
    console.log(JSON.stringify({ status: 'PASS', checks: checks.length }));
  } finally { await c.end(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
