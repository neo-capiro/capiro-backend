#!/usr/bin/env node
/**
 * Outreach V3 Revised Phase 2 disposable PostgreSQL rehearsal.
 *
 * Required environment: a PostgreSQL 16-compatible ADMIN endpoint via the usual
 * PGHOST/PGPORT/PGUSER/PGPASSWORD variables plus host `psql` and `pnpm`.
 *
 * Safety: this script NEVER accepts a target database name or DATABASE_URL. It
 * creates two uniquely named databases itself, applies only repository migration
 * bytes, and drops both in finally. It also creates a unique non-superuser probe
 * role and removes it after the databases are gone.
 *
 * Paths proved:
 *   fresh:   empty DB -> full repository migration chain -> Phase 2 DB checks
 *   upgrade: pre-Phase-2 chain -> real legacy outreach row -> exact Phase 2 SQL
 *            -> legacy row byte/logical identity unchanged -> Phase 2 DB checks
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API_PRISMA = resolve(ROOT, 'apps/api/prisma');
const MAIN_SCHEMA = resolve(API_PRISMA, 'schema.prisma');
const FOCUSED_SCHEMA = resolve(API_PRISMA, 'outreach-v3-phase2/schema.prisma');
const PHASE2_MIGRATION_NAME = '20260908010000_outreach_v3_campaign_state';
const PHASE2_MIGRATION = resolve(
  API_PRISMA,
  'migrations',
  PHASE2_MIGRATION_NAME,
  'migration.sql',
);

for (const path of [MAIN_SCHEMA, FOCUSED_SCHEMA, PHASE2_MIGRATION]) {
  if (!existsSync(path)) throw new Error(`Required Phase 2 input is missing: ${path}`);
}

const PSQL = process.env.PSQL_BIN || 'psql';
const PGHOST = process.env.PGHOST || '127.0.0.1';
const PGPORT = process.env.PGPORT || '5432';
const PGUSER = process.env.PGUSER || 'postgres';
const PGPASSWORD = process.env.PGPASSWORD || '';
const suffix = `${process.pid}_${Date.now().toString(36)}`.replace(/[^a-zA-Z0-9_]/g, '_');
const FRESH_DB = `outreach_v3_p2_fresh_${suffix}`;
const UPGRADE_DB = `outreach_v3_p2_upgrade_${suffix}`;
const PROBE_ROLE = `outreach_v3_p2_probe_${process.pid}`.replace(/[^a-zA-Z0-9_]/g, '_');
const PROBE_PASSWORD = `p2_${process.pid}_probe`;
const tempRoot = mkdtempSync(join(tmpdir(), 'capiro-outreach-v3-p2-'));

const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '00000000-0000-4000-8000-000000000002';
const USER_A = '00000000-0000-4000-8000-000000000011';
const USER_B = '00000000-0000-4000-8000-000000000012';
const SESSION_A = '00000000-0000-4000-8000-000000000021';
const SESSION_B = '00000000-0000-4000-8000-000000000022';
const VERSION_A = '00000000-0000-4000-8000-000000000031';
const EVENT_A = '00000000-0000-4000-8000-000000000041';
const PROPOSAL_A = '00000000-0000-4000-8000-000000000051';
const BATCH_A = '00000000-0000-4000-8000-000000000061';
const LEGACY_OUTREACH_ID = '00000000-0000-4000-8000-000000000071';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

let passes = 0;
function ok(label) {
  passes += 1;
  console.log(`  PASS  ${label}`);
}
function fail(label, detail = '') {
  throw new Error(`${label}${detail ? `: ${detail}` : ''}`);
}
function eq(label, actual, expected) {
  if (String(actual).trim() !== String(expected).trim()) {
    fail(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  ok(`${label} (${String(actual).trim()})`);
}

function command(bin, args, options = {}) {
  const result = spawnSync(bin, args, {
    cwd: options.cwd || ROOT,
    env: { ...process.env, ...(options.env || {}) },
    input: options.input,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(
      `${bin} ${args.join(' ')} failed (${result.status})\n${result.stderr || result.stdout}`,
    );
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    error.status = result.status;
    throw error;
  }
  return (result.stdout || '').trim();
}

function requireCommand(bin, versionArgs = ['--version']) {
  try {
    command(bin, versionArgs);
  } catch (error) {
    throw new Error(`Required command is unavailable: ${bin}. ${error.message}`);
  }
}

function psql(db, sql, options = {}) {
  const user = options.user || PGUSER;
  const password = options.password === undefined ? PGPASSWORD : options.password;
  return command(
    PSQL,
    ['-X', '-v', 'ON_ERROR_STOP=1', '-qAt', '-h', PGHOST, '-p', PGPORT, '-U', user, '-d', db, '-c', sql],
    { env: { PGPASSWORD: password } },
  );
}

function psqlFile(db, sqlText) {
  return command(
    PSQL,
    ['-X', '-v', 'ON_ERROR_STOP=1', '-qAt', '-h', PGHOST, '-p', PGPORT, '-U', PGUSER, '-d', db],
    { env: { PGPASSWORD }, input: sqlText },
  );
}

function expectSqlFailure(label, db, sql, pattern, options = {}) {
  try {
    psql(db, sql, options);
  } catch (error) {
    const combined = `${error.stderr || ''}\n${error.stdout || ''}\n${error.message || ''}`;
    if (pattern && !pattern.test(combined)) {
      fail(label, `failed for an unexpected reason: ${combined.slice(-1200)}`);
    }
    ok(label);
    return;
  }
  fail(label, 'statement unexpectedly succeeded');
}

function adminSql(sql) {
  return psql('postgres', sql);
}

function terminateAndDropDatabase(db) {
  try {
    adminSql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}' AND pid <> pg_backend_pid();`);
  } catch {}
  try {
    adminSql(`DROP DATABASE IF EXISTS "${db}";`);
  } catch {}
}

function createDatabase(db) {
  terminateAndDropDatabase(db);
  adminSql(`CREATE DATABASE "${db}";`);
}

function databaseUrl(db) {
  const url = new URL('postgresql://localhost');
  url.username = PGUSER;
  if (PGPASSWORD) url.password = PGPASSWORD;
  url.hostname = PGHOST;
  url.port = PGPORT;
  url.pathname = `/${db}`;
  url.searchParams.set('schema', 'public');
  return url.toString();
}

function prismaMigrate(db, schemaPath) {
  command(
    'pnpm',
    ['--filter', '@capiro/api', 'exec', 'prisma', 'migrate', 'deploy', '--schema', schemaPath],
    { env: { DATABASE_URL: databaseUrl(db) } },
  );
}

function prismaValidate(db, schemaPath) {
  command(
    'pnpm',
    ['--filter', '@capiro/api', 'exec', 'prisma', 'validate', '--schema', schemaPath],
    { env: { DATABASE_URL: databaseUrl(db) } },
  );
}

function seedIdentity(db) {
  psql(
    db,
    `
      INSERT INTO tenants (id, slug, name, status)
      VALUES
        ('${TENANT_A}', 'outreach-v3-p2-a-${process.pid}', 'Outreach V3 Phase 2 A', 'active'),
        ('${TENANT_B}', 'outreach-v3-p2-b-${process.pid}', 'Outreach V3 Phase 2 B', 'active');
      INSERT INTO users (id, clerk_user_id, email)
      VALUES
        ('${USER_A}', 'outreach_v3_p2_user_a_${process.pid}', 'outreach-v3-p2-a-${process.pid}@example.invalid'),
        ('${USER_B}', 'outreach_v3_p2_user_b_${process.pid}', 'outreach-v3-p2-b-${process.pid}@example.invalid');
    `,
  );
}

function createProbeRole() {
  try {
    adminSql(`DROP ROLE IF EXISTS "${PROBE_ROLE}";`);
  } catch {}
  adminSql(
    `CREATE ROLE "${PROBE_ROLE}" LOGIN PASSWORD '${PROBE_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`,
  );
}

function grantProbe(db) {
  psql(
    db,
    `
      GRANT USAGE ON SCHEMA public TO "${PROBE_ROLE}";
      GRANT SELECT, INSERT, UPDATE ON outreach_sessions TO "${PROBE_ROLE}";
      GRANT SELECT, INSERT ON outreach_state_versions TO "${PROBE_ROLE}";
      GRANT SELECT, INSERT ON outreach_events TO "${PROBE_ROLE}";
      GRANT SELECT, INSERT, UPDATE ON outreach_command_proposals TO "${PROBE_ROLE}";
    `,
  );
}

function seedPhase2Rows(db) {
  const blank = JSON.stringify({
    schemaVersion: 'outreach_campaign_spec_v1',
    goal: { goal: null, objective: null, topic: null, desiredOutcome: null, ask: { mode: 'undecided', text: null }, whyNow: null },
    sponsor: { kind: 'undecided', label: null, clientRefs: [] },
    targeting: { criteria: null, selectedTargetRefs: [], rejectedRecommendationRefs: [] },
    delivery: { pattern: 'undecided', personalization: 'undecided' },
    context: { requiredPolicyRefs: [], writingGuidanceRefs: [], campaignFactRefs: [], targetSpecificRefs: [], groupSafeRefs: [], excludedRefs: [] },
    strategy: { campaignAngle: null, tone: null, length: 'undecided', customLengthInstruction: null },
  }).replaceAll("'", "''");

  psql(
    db,
    `
      INSERT INTO outreach_sessions
        (id, tenant_id, created_by_user_id, status, current_state_version, title)
      VALUES
        ('${SESSION_A}', '${TENANT_A}', '${USER_A}', 'active', 1, 'tenant-a'),
        ('${SESSION_B}', '${TENANT_B}', '${USER_B}', 'active', 1, 'tenant-b');

      INSERT INTO outreach_state_versions
        (id, tenant_id, session_id, version, schema_version, spec_jsonb, spec_hash, created_by_user_id)
      VALUES
        ('${VERSION_A}', '${TENANT_A}', '${SESSION_A}', 1, 'outreach_campaign_spec_v1', '${blank}'::jsonb, '${HASH_A}', '${USER_A}');

      INSERT INTO outreach_events
        (id, tenant_id, session_id, sequence, event_type, actor_user_id, source,
         state_version_before, state_version_after, command_batch_id, payload_hash, safe_metadata_jsonb)
      VALUES
        ('${EVENT_A}', '${TENANT_A}', '${SESSION_A}', 1, 'command_batch_result', '${USER_A}', 'user_control',
         1, 1, '${BATCH_A}', '${HASH_B}', '{"status":"no_change"}'::jsonb);

      INSERT INTO outreach_command_proposals
        (id, tenant_id, session_id, created_by_user_id, source, expected_state_version,
         commands_jsonb, commands_hash, status)
      VALUES
        ('${PROPOSAL_A}', '${TENANT_A}', '${SESSION_A}', '${USER_A}', 'user', 1,
         '[]'::jsonb, '${HASH_B}', 'pending');
    `,
  );
}

function proveDatabaseInvariants(db, labelPrefix) {
  eq(
    `${labelPrefix}: four Phase 2 tables exist`,
    psql(db, `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('outreach_sessions','outreach_state_versions','outreach_events','outreach_command_proposals');`),
    '4',
  );
  eq(
    `${labelPrefix}: RLS is enabled and forced on all Phase 2 tables`,
    psql(db, `SELECT COUNT(*) FROM pg_class WHERE oid IN ('outreach_sessions'::regclass,'outreach_state_versions'::regclass,'outreach_events'::regclass,'outreach_command_proposals'::regclass) AND relrowsecurity AND relforcerowsecurity;`),
    '4',
  );
  eq(
    `${labelPrefix}: append-only triggers exist`,
    psql(db, `SELECT COUNT(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('outreach_state_versions_append_only','outreach_events_append_only');`),
    '2',
  );
  eq(
    `${labelPrefix}: proposal lifecycle trigger exists`,
    psql(db, `SELECT COUNT(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname='outreach_command_proposals_lifecycle';`),
    '1',
  );

  seedIdentity(db);
  seedPhase2Rows(db);
  grantProbe(db);

  const probe = (sql) =>
    psql(db, sql, { user: PROBE_ROLE, password: PROBE_PASSWORD });

  eq(
    `${labelPrefix}: runtime-like role with no tenant context sees no sessions`,
    probe('SELECT COUNT(*) FROM outreach_sessions;'),
    '0',
  );
  eq(
    `${labelPrefix}: tenant A sees only tenant A session`,
    probe(`SET app.current_tenant='${TENANT_A}'; SELECT COUNT(*) FROM outreach_sessions;`),
    '1',
  );
  expectSqlFailure(
    `${labelPrefix}: tenant A cannot insert tenant B session`,
    db,
    `SET app.current_tenant='${TENANT_A}'; INSERT INTO outreach_sessions (tenant_id,created_by_user_id,title) VALUES ('${TENANT_B}','${USER_B}','forbidden');`,
    /row-level security|permission denied/i,
    { user: PROBE_ROLE, password: PROBE_PASSWORD },
  );

  expectSqlFailure(
    `${labelPrefix}: session/tenant mismatch is rejected structurally`,
    db,
    `INSERT INTO outreach_state_versions (tenant_id,session_id,version,schema_version,spec_jsonb,spec_hash,created_by_user_id) VALUES ('${TENANT_B}','${SESSION_A}',2,'outreach_campaign_spec_v1','{}','${HASH_A}','${USER_B}');`,
    /foreign key|violates/i,
  );
  expectSqlFailure(
    `${labelPrefix}: duplicate state version is rejected`,
    db,
    `INSERT INTO outreach_state_versions (tenant_id,session_id,version,schema_version,spec_jsonb,spec_hash,created_by_user_id) VALUES ('${TENANT_A}','${SESSION_A}',1,'outreach_campaign_spec_v1','{}','${HASH_A}','${USER_A}');`,
    /unique|duplicate/i,
  );
  expectSqlFailure(
    `${labelPrefix}: state version UPDATE is rejected by append-only trigger`,
    db,
    `UPDATE outreach_state_versions SET spec_hash='${HASH_B}' WHERE id='${VERSION_A}';`,
    /append-only/i,
  );
  expectSqlFailure(
    `${labelPrefix}: state version DELETE is rejected by append-only trigger`,
    db,
    `DELETE FROM outreach_state_versions WHERE id='${VERSION_A}';`,
    /append-only/i,
  );
  expectSqlFailure(
    `${labelPrefix}: duplicate event sequence is rejected`,
    db,
    `INSERT INTO outreach_events (tenant_id,session_id,sequence,event_type,actor_user_id,source) VALUES ('${TENANT_A}','${SESSION_A}',1,'probe','${USER_A}','system');`,
    /unique|duplicate/i,
  );
  expectSqlFailure(
    `${labelPrefix}: duplicate command batch id is rejected`,
    db,
    `INSERT INTO outreach_events (tenant_id,session_id,sequence,event_type,actor_user_id,source,command_batch_id) VALUES ('${TENANT_A}','${SESSION_A}',2,'command_batch_result','${USER_A}','user_control','${BATCH_A}');`,
    /unique|duplicate/i,
  );
  expectSqlFailure(
    `${labelPrefix}: event UPDATE is rejected by append-only trigger`,
    db,
    `UPDATE outreach_events SET event_type='mutated' WHERE id='${EVENT_A}';`,
    /append-only/i,
  );
  expectSqlFailure(
    `${labelPrefix}: event DELETE is rejected by append-only trigger`,
    db,
    `DELETE FROM outreach_events WHERE id='${EVENT_A}';`,
    /append-only/i,
  );
  expectSqlFailure(
    `${labelPrefix}: invalid proposal status is rejected`,
    db,
    `INSERT INTO outreach_command_proposals (tenant_id,session_id,created_by_user_id,source,expected_state_version,commands_jsonb,commands_hash,status) VALUES ('${TENANT_A}','${SESSION_A}','${USER_A}','user',1,'[]','${HASH_A}','approved');`,
    /check constraint|violates/i,
  );
  expectSqlFailure(
    `${labelPrefix}: proposal command content cannot be rewritten`,
    db,
    `UPDATE outreach_command_proposals SET commands_jsonb='[{"tampered":true}]'::jsonb, status='rejected', decided_at=NOW(), decided_by_user_id='${USER_A}' WHERE id='${PROPOSAL_A}';`,
    /content is immutable/i,
  );

  psql(
    db,
    `UPDATE outreach_command_proposals SET status='rejected', decided_at=NOW(), decided_by_user_id='${USER_A}', rejection_code='user_rejected' WHERE id='${PROPOSAL_A}';`,
  );
  ok(`${labelPrefix}: legal pending -> rejected proposal transition succeeds`);
  expectSqlFailure(
    `${labelPrefix}: terminal proposal cannot be rewritten`,
    db,
    `UPDATE outreach_command_proposals SET rejection_code='changed' WHERE id='${PROPOSAL_A}';`,
    /terminal state is immutable/i,
  );
  expectSqlFailure(
    `${labelPrefix}: runtime role cannot delete a session`,
    db,
    `SET app.current_tenant='${TENANT_A}'; DELETE FROM outreach_sessions WHERE id='${SESSION_A}';`,
    /permission denied/i,
    { user: PROBE_ROLE, password: PROBE_PASSWORD },
  );
}

function seedLegacyOutreach(db) {
  seedIdentity(db);
  psql(
    db,
    `INSERT INTO outreach_records (id,tenant_id,created_by_user_id,type,status,title) VALUES ('${LEGACY_OUTREACH_ID}','${TENANT_A}','${USER_A}','follow_up','draft','Phase 2 legacy sentinel');`,
  );
  return psql(
    db,
    `SELECT md5(row_to_json(r)::text) FROM outreach_records r WHERE id='${LEGACY_OUTREACH_ID}';`,
  );
}

function buildPrePhase2PrismaCopy() {
  const copyRoot = resolve(tempRoot, 'prisma');
  cpSync(API_PRISMA, copyRoot, { recursive: true });
  const phase2Copy = resolve(copyRoot, 'migrations', PHASE2_MIGRATION_NAME);
  rmSync(phase2Copy, { recursive: true, force: true });
  // The focused projection is not part of the canonical migration chain and is
  // irrelevant to the baseline; remove generated output if a developer had it.
  rmSync(resolve(copyRoot, 'outreach-v3-phase2/generated'), { recursive: true, force: true });
  return resolve(copyRoot, 'schema.prisma');
}

async function main() {
  requireCommand(PSQL);
  requireCommand('pnpm', ['--version']);
  console.log(`== Outreach V3 Phase 2 DB rehearsal on ${PGHOST}:${PGPORT} ==`);
  console.log('Safety: creating disposable databases only; no DATABASE_URL target is accepted.');

  createProbeRole();

  console.log('\n-- Fresh path: full migration chain --');
  createDatabase(FRESH_DB);
  prismaMigrate(FRESH_DB, MAIN_SCHEMA);
  ok('fresh: full repository migration chain applies');
  prismaValidate(FRESH_DB, FOCUSED_SCHEMA);
  ok('fresh: focused Phase 2 Prisma projection validates');
  proveDatabaseInvariants(FRESH_DB, 'fresh');

  console.log('\n-- Ordered-upgrade path: pre-Phase-2 -> exact Phase 2 migration --');
  createDatabase(UPGRADE_DB);
  const prePhase2Schema = buildPrePhase2PrismaCopy();
  prismaMigrate(UPGRADE_DB, prePhase2Schema);
  ok('upgrade: pre-Phase-2 repository migration chain applies');
  eq(
    'upgrade: Phase 2 tables are absent before the new migration',
    psql(UPGRADE_DB, `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('outreach_sessions','outreach_state_versions','outreach_events','outreach_command_proposals');`),
    '0',
  );

  const legacyBefore = seedLegacyOutreach(UPGRADE_DB);
  ok('upgrade: real legacy outreach_records sentinel exists before Phase 2');
  psqlFile(UPGRADE_DB, readFileSync(PHASE2_MIGRATION, 'utf8'));
  ok(`upgrade: exact ${basename(dirname(PHASE2_MIGRATION))}/migration.sql applies`);
  const legacyAfter = psql(
    UPGRADE_DB,
    `SELECT md5(row_to_json(r)::text) FROM outreach_records r WHERE id='${LEGACY_OUTREACH_ID}';`,
  );
  eq('upgrade: legacy outreach_records sentinel is byte/logically unchanged', legacyAfter, legacyBefore);
  proveDatabaseInvariants(UPGRADE_DB, 'upgrade');

  console.log(`\nOUTREACH_V3_PHASE2_DB_COMPLETE (${passes} checks)`);
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  console.error(`OUTREACH_V3_PHASE2_DB_FAILED: ${error.stack || error.message || error}`);
} finally {
  terminateAndDropDatabase(FRESH_DB);
  terminateAndDropDatabase(UPGRADE_DB);
  try {
    adminSql(`DROP ROLE IF EXISTS "${PROBE_ROLE}";`);
  } catch (error) {
    console.error(`WARN: could not drop probe role ${PROBE_ROLE}: ${error.message}`);
    exitCode = 1;
  }
  rmSync(tempRoot, { recursive: true, force: true });
}

process.exit(exitCode);
