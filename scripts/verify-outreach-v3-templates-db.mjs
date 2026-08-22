#!/usr/bin/env node
/**
 * Outreach V3 Phase 2 Templates disposable PostgreSQL rehearsal.
 *
 * Required environment: a PostgreSQL 16-compatible ADMIN endpoint via the usual
 * PGHOST/PGPORT/PGUSER/PGPASSWORD variables plus host `psql` and `pnpm`.
 * Modeled directly on scripts/verify-outreach-v3-phase2-db.mjs.
 *
 * Safety: this script NEVER accepts a target database name or DATABASE_URL. It
 * creates two uniquely named databases itself, applies only repository migration
 * bytes, and drops both in finally. It also creates a unique non-superuser probe
 * role and removes it after the databases are gone.
 *
 * Paths proved:
 *   fresh:   empty DB -> full repository migration chain -> Templates DB checks
 *   upgrade: pre-Templates chain -> real pre-existing `clients` row -> exact
 *            Templates migration.sql -> that row byte/logically unchanged
 *            (the migration ALTERs the existing `clients` table) -> DB checks
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API_PRISMA = resolve(ROOT, 'apps/api/prisma');
const MAIN_SCHEMA = resolve(API_PRISMA, 'schema.prisma');
const FOCUSED_SCHEMA = resolve(API_PRISMA, 'outreach-v3-templates/schema.prisma');
const TEMPLATES_MIGRATION_NAME = '20261219010000_outreach_v3_templates';
const TEMPLATES_MIGRATION = resolve(
  API_PRISMA,
  'migrations',
  TEMPLATES_MIGRATION_NAME,
  'migration.sql',
);

for (const path of [MAIN_SCHEMA, FOCUSED_SCHEMA, TEMPLATES_MIGRATION]) {
  if (!existsSync(path)) throw new Error(`Required Templates input is missing: ${path}`);
}

const PSQL = process.env.PSQL_BIN || 'psql';
const PGHOST = process.env.PGHOST || '127.0.0.1';
const PGPORT = process.env.PGPORT || '5432';
const PGUSER = process.env.PGUSER || 'postgres';
const PGPASSWORD = process.env.PGPASSWORD || '';
const suffix = `${process.pid}_${Date.now().toString(36)}`.replace(/[^a-zA-Z0-9_]/g, '_');
const FRESH_DB = `outreach_v3_tpl_fresh_${suffix}`;
const UPGRADE_DB = `outreach_v3_tpl_upgrade_${suffix}`;
const PROBE_ROLE = `outreach_v3_tpl_probe_${process.pid}`.replace(/[^a-zA-Z0-9_]/g, '_');
const PROBE_PASSWORD = `tpl_${process.pid}_probe`;
const tempRoot = mkdtempSync(join(tmpdir(), 'capiro-outreach-v3-templates-'));

const TENANT_A = '00000000-0000-4000-8000-000000000101';
const TENANT_B = '00000000-0000-4000-8000-000000000102';
const USER_A1 = '00000000-0000-4000-8000-000000000111'; // owns the tenant-A templates
const USER_A2 = '00000000-0000-4000-8000-000000000112'; // different tenant-A user
const USER_B = '00000000-0000-4000-8000-000000000113'; // tenant-B user
const CLIENT_A = '00000000-0000-4000-8000-000000000121';
const CLIENT_B = '00000000-0000-4000-8000-000000000122';
const SESSION_A = '00000000-0000-4000-8000-000000000131';
const SESSION_APPLIED = '00000000-0000-4000-8000-000000000132';
const TEMPLATE_PRIVATE_A = '00000000-0000-4000-8000-000000000141';
const TEMPLATE_FIRM_A = '00000000-0000-4000-8000-000000000142';
const TEMPLATE_CLIENT_A = '00000000-0000-4000-8000-000000000143';
const VERSION_PRIVATE_PUBLISHED = '00000000-0000-4000-8000-000000000151';
const VERSION_PRIVATE_DRAFT = '00000000-0000-4000-8000-000000000152';
const APPLICATION_A = '00000000-0000-4000-8000-000000000161';
const AUDIT_A = '00000000-0000-4000-8000-000000000171';
const LEGACY_CLIENT_ID = '00000000-0000-4000-8000-000000000181';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const REQUEST_KEY_A = '00000000-0000-4000-8000-000000000191';

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
        ('${TENANT_A}', 'outreach-v3-tpl-a-${process.pid}', 'Outreach V3 Templates A', 'active'),
        ('${TENANT_B}', 'outreach-v3-tpl-b-${process.pid}', 'Outreach V3 Templates B', 'active')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO users (id, clerk_user_id, email)
      VALUES
        ('${USER_A1}', 'outreach_v3_tpl_user_a1_${process.pid}', 'outreach-v3-tpl-a1-${process.pid}@example.invalid'),
        ('${USER_A2}', 'outreach_v3_tpl_user_a2_${process.pid}', 'outreach-v3-tpl-a2-${process.pid}@example.invalid'),
        ('${USER_B}', 'outreach_v3_tpl_user_b_${process.pid}', 'outreach-v3-tpl-b-${process.pid}@example.invalid')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO clients (id, tenant_id, name)
      VALUES
        ('${CLIENT_A}', '${TENANT_A}', 'Templates Rehearsal Client A'),
        ('${CLIENT_B}', '${TENANT_B}', 'Templates Rehearsal Client B')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO outreach_sessions (id, tenant_id, created_by_user_id, status, current_state_version, title)
      VALUES
        ('${SESSION_A}', '${TENANT_A}', '${USER_A1}', 'active', 1, 'tpl-source-session'),
        ('${SESSION_APPLIED}', '${TENANT_A}', '${USER_A1}', 'active', 1, 'tpl-applied-session')
      ON CONFLICT (id) DO NOTHING;
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
  // Mirrors the exact privileges the migration itself grants to `capiro_app`
  // — the probe role represents "what if the runtime role did NOT bypass
  // RLS" (closeout runbook 8.3: "behavior under an RLS-enforced role"),
  // independent of what the deployed capiro_app connection actually does.
  psql(
    db,
    `
      GRANT USAGE ON SCHEMA public TO "${PROBE_ROLE}";
      GRANT SELECT, INSERT, UPDATE ON outreach_v3_templates TO "${PROBE_ROLE}";
      GRANT SELECT, INSERT, UPDATE ON outreach_v3_template_versions TO "${PROBE_ROLE}";
      GRANT SELECT, INSERT ON outreach_v3_template_applications TO "${PROBE_ROLE}";
      GRANT SELECT, INSERT ON outreach_v3_session_template_provenance TO "${PROBE_ROLE}";
      GRANT SELECT, INSERT ON outreach_v3_template_audit_log TO "${PROBE_ROLE}";
    `,
  );
}

function seedTemplateRows(db) {
  psql(
    db,
    `
      INSERT INTO outreach_v3_templates
        (id, tenant_id, owner_user_id, client_id, scope, name, status, current_draft_version_id, published_version_id)
      VALUES
        ('${TEMPLATE_PRIVATE_A}', '${TENANT_A}', '${USER_A1}', NULL, 'private', 'Private A', 'active', NULL, NULL),
        ('${TEMPLATE_FIRM_A}', '${TENANT_A}', '${USER_A1}', NULL, 'firm', 'Firm A', 'active', NULL, NULL),
        ('${TEMPLATE_CLIENT_A}', '${TENANT_A}', '${USER_A1}', '${CLIENT_A}', 'client', 'Client A', 'active', NULL, NULL);

      INSERT INTO outreach_v3_template_versions
        (id, tenant_id, template_id, version_number, lifecycle, template_spec_jsonb, content_hash,
         source_session_id, source_state_version, created_by_user_id, published_at)
      VALUES
        ('${VERSION_PRIVATE_PUBLISHED}', '${TENANT_A}', '${TEMPLATE_PRIVATE_A}', 1, 'published', '{}'::jsonb, '${HASH_A}',
         '${SESSION_A}', 1, '${USER_A1}', NOW());

      UPDATE outreach_v3_templates
        SET published_version_id = '${VERSION_PRIVATE_PUBLISHED}'
        WHERE id = '${TEMPLATE_PRIVATE_A}';

      INSERT INTO outreach_v3_template_versions
        (id, tenant_id, template_id, version_number, lifecycle, template_spec_jsonb, content_hash,
         source_session_id, source_state_version, created_by_user_id)
      VALUES
        ('${VERSION_PRIVATE_DRAFT}', '${TENANT_A}', '${TEMPLATE_PRIVATE_A}', 2, 'draft', '{}'::jsonb, '${HASH_B}',
         '${SESSION_A}', 1, '${USER_A1}');

      UPDATE outreach_v3_templates
        SET current_draft_version_id = '${VERSION_PRIVATE_DRAFT}'
        WHERE id = '${TEMPLATE_PRIVATE_A}';

      INSERT INTO outreach_v3_template_applications
        (id, tenant_id, template_id, template_version_id, session_id, applied_by_user_id,
         request_key, request_fingerprint, command_batch_jsonb, template_content_hash,
         resulting_state_version, receipt_jsonb)
      VALUES
        ('${APPLICATION_A}', '${TENANT_A}', '${TEMPLATE_PRIVATE_A}', '${VERSION_PRIVATE_PUBLISHED}', '${SESSION_APPLIED}',
         '${USER_A1}', '${REQUEST_KEY_A}', '${HASH_A}', '[]'::jsonb, '${HASH_A}', 1, '{}'::jsonb);

      INSERT INTO outreach_v3_session_template_provenance
        (session_id, tenant_id, template_id, template_version_id, application_id, applied_by_user_id)
      VALUES
        ('${SESSION_APPLIED}', '${TENANT_A}', '${TEMPLATE_PRIVATE_A}', '${VERSION_PRIVATE_PUBLISHED}', '${APPLICATION_A}', '${USER_A1}');

      INSERT INTO outreach_v3_template_audit_log
        (id, tenant_id, actor_user_id, action, template_id, template_version_id, scope, outcome)
      VALUES
        ('${AUDIT_A}', '${TENANT_A}', '${USER_A1}', 'use', '${TEMPLATE_PRIVATE_A}', '${VERSION_PRIVATE_PUBLISHED}', 'private', 'allowed');
    `,
  );
}

function proveDatabaseInvariants(db, labelPrefix) {
  const tables = [
    'outreach_v3_templates',
    'outreach_v3_template_versions',
    'outreach_v3_template_applications',
    'outreach_v3_session_template_provenance',
    'outreach_v3_template_audit_log',
  ];
  eq(
    `${labelPrefix}: five Templates tables exist`,
    psql(db, `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('${tables.join("','")}');`),
    '5',
  );
  eq(
    `${labelPrefix}: RLS is enabled and forced on all five Templates tables`,
    psql(db, `SELECT COUNT(*) FROM pg_class WHERE oid IN (${tables.map((t) => `'${t}'::regclass`).join(',')}) AND relrowsecurity AND relforcerowsecurity;`),
    '5',
  );
  eq(
    `${labelPrefix}: published-version immutability trigger exists`,
    psql(db, `SELECT COUNT(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname='outreach_v3_template_versions_immutable';`),
    '1',
  );
  eq(
    `${labelPrefix}: append-only triggers exist on applications/provenance/audit_log`,
    psql(db, `SELECT COUNT(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('outreach_v3_template_applications_append_only','outreach_v3_session_template_provenance_append_only','outreach_v3_template_audit_log_append_only');`),
    '3',
  );
  eq(
    `${labelPrefix}: 'superseded' is an allowed version lifecycle value`,
    (() => {
      const probeId = '00000000-0000-4000-8000-0000000001ff';
      psql(db, `INSERT INTO outreach_v3_template_versions (id, tenant_id, template_id, version_number, lifecycle, template_spec_jsonb, content_hash, created_by_user_id) SELECT '${probeId}', '${TENANT_A}', id, 99, 'superseded', '{}'::jsonb, '${HASH_A}', '${USER_A1}' FROM outreach_v3_templates WHERE id='${TEMPLATE_PRIVATE_A}';`);
      const count = psql(db, `SELECT COUNT(*) FROM outreach_v3_template_versions WHERE id='${probeId}' AND lifecycle='superseded';`);
      psql(db, `DELETE FROM outreach_v3_template_versions WHERE id='${probeId}';`);
      return count;
    })(),
    '1',
  );

  seedIdentity(db);
  seedTemplateRows(db);
  grantProbe(db);

  const probe = (sql) => psql(db, sql, { user: PROBE_ROLE, password: PROBE_PASSWORD });

  eq(
    `${labelPrefix}: RLS-enforced role with no tenant context sees no templates`,
    probe('SELECT COUNT(*) FROM outreach_v3_templates;'),
    '0',
  );
  eq(
    `${labelPrefix}: tenant A owner sees all three of their own templates (private+firm+client)`,
    probe(`SET app.current_tenant='${TENANT_A}'; SET app.current_user='${USER_A1}'; SELECT COUNT(*) FROM outreach_v3_templates;`),
    '3',
  );
  eq(
    `${labelPrefix}: a DIFFERENT tenant-A user sees only the shared firm+client templates, not the private one`,
    probe(`SET app.current_tenant='${TENANT_A}'; SET app.current_user='${USER_A2}'; SELECT COUNT(*) FROM outreach_v3_templates;`),
    '2',
  );
  eq(
    `${labelPrefix}: tenant B sees none of tenant A's templates`,
    probe(`SET app.current_tenant='${TENANT_B}'; SET app.current_user='${USER_B}'; SELECT COUNT(*) FROM outreach_v3_templates;`),
    '0',
  );
  expectSqlFailure(
    `${labelPrefix}: RLS rejects a tenant-B actor inserting a tenant-A-owned template`,
    db,
    `SET app.current_tenant='${TENANT_B}'; SET app.current_user='${USER_B}'; INSERT INTO outreach_v3_templates (tenant_id, owner_user_id, scope, name) VALUES ('${TENANT_A}','${USER_A1}','private','forbidden');`,
    /row-level security|permission denied/i,
    { user: PROBE_ROLE, password: PROBE_PASSWORD },
  );

  expectSqlFailure(
    `${labelPrefix}: published version UPDATE is rejected by the immutability trigger`,
    db,
    `UPDATE outreach_v3_template_versions SET content_hash='${HASH_B}' WHERE id='${VERSION_PRIVATE_PUBLISHED}';`,
    /immutable/i,
  );
  expectSqlFailure(
    `${labelPrefix}: published version DELETE is rejected by the immutability trigger`,
    db,
    `DELETE FROM outreach_v3_template_versions WHERE id='${VERSION_PRIVATE_PUBLISHED}';`,
    /immutable/i,
  );
  psql(db, `UPDATE outreach_v3_template_versions SET content_hash='${HASH_B}' WHERE id='${VERSION_PRIVATE_DRAFT}';`);
  ok(`${labelPrefix}: a DRAFT version may still be mutated (only published rows are frozen)`);

  expectSqlFailure(
    `${labelPrefix}: application UPDATE is rejected by the append-only trigger`,
    db,
    `UPDATE outreach_v3_template_applications SET resulting_state_version=99 WHERE id='${APPLICATION_A}';`,
    /append-only/i,
  );
  expectSqlFailure(
    `${labelPrefix}: application DELETE is rejected by the append-only trigger`,
    db,
    `DELETE FROM outreach_v3_template_applications WHERE id='${APPLICATION_A}';`,
    /append-only/i,
  );
  expectSqlFailure(
    `${labelPrefix}: session provenance UPDATE is rejected by the append-only trigger`,
    db,
    `UPDATE outreach_v3_session_template_provenance SET applied_by_user_id='${USER_A2}' WHERE session_id='${SESSION_APPLIED}';`,
    /append-only/i,
  );
  expectSqlFailure(
    `${labelPrefix}: audit log UPDATE is rejected by the append-only trigger`,
    db,
    `UPDATE outreach_v3_template_audit_log SET outcome='denied' WHERE id='${AUDIT_A}';`,
    /append-only/i,
  );

  expectSqlFailure(
    `${labelPrefix}: a duplicate (tenant, actor, request_key) application is rejected — idempotency at the DB layer`,
    db,
    `INSERT INTO outreach_v3_template_applications (id, tenant_id, template_id, template_version_id, session_id, applied_by_user_id, request_key, request_fingerprint, command_batch_jsonb, template_content_hash, resulting_state_version, receipt_jsonb) VALUES (gen_random_uuid(), '${TENANT_A}', '${TEMPLATE_PRIVATE_A}', '${VERSION_PRIVATE_PUBLISHED}', gen_random_uuid(), '${USER_A1}', '${REQUEST_KEY_A}', '${HASH_B}', '[]'::jsonb, '${HASH_A}', 1, '{}'::jsonb);`,
    /unique|duplicate/i,
  );
  expectSqlFailure(
    `${labelPrefix}: a session can have at most one template application (session_id unique)`,
    db,
    `INSERT INTO outreach_v3_template_applications (id, tenant_id, template_id, template_version_id, session_id, applied_by_user_id, request_key, request_fingerprint, command_batch_jsonb, template_content_hash, resulting_state_version, receipt_jsonb) VALUES (gen_random_uuid(), '${TENANT_A}', '${TEMPLATE_PRIVATE_A}', '${VERSION_PRIVATE_PUBLISHED}', '${SESSION_APPLIED}', '${USER_A1}', gen_random_uuid(), '${HASH_B}', '[]'::jsonb, '${HASH_A}', 1, '{}'::jsonb);`,
    /unique|duplicate/i,
  );
  expectSqlFailure(
    `${labelPrefix}: an application's version must belong to its own template (composite FK)`,
    db,
    `INSERT INTO outreach_v3_template_applications (id, tenant_id, template_id, template_version_id, session_id, applied_by_user_id, request_key, request_fingerprint, command_batch_jsonb, template_content_hash, resulting_state_version, receipt_jsonb) SELECT gen_random_uuid(), '${TENANT_A}', '${TEMPLATE_FIRM_A}', '${VERSION_PRIVATE_PUBLISHED}', id, '${USER_A1}', gen_random_uuid(), '${HASH_B}', '[]'::jsonb, '${HASH_A}', 1, '{}'::jsonb FROM outreach_sessions WHERE tenant_id='${TENANT_A}' LIMIT 1;`,
    /foreign key|violates/i,
  );
  expectSqlFailure(
    `${labelPrefix}: a client scope requires a same-tenant client (composite FK)`,
    db,
    `INSERT INTO outreach_v3_templates (tenant_id, owner_user_id, client_id, scope, name) VALUES ('${TENANT_A}', '${USER_A1}', '${CLIENT_B}', 'client', 'cross tenant client');`,
    /foreign key|violates/i,
  );
  expectSqlFailure(
    `${labelPrefix}: a draft/published pointer must belong to the same template (composite FK)`,
    db,
    `UPDATE outreach_v3_templates SET published_version_id = (SELECT id FROM outreach_v3_template_versions WHERE template_id != '${TEMPLATE_FIRM_A}' LIMIT 1) WHERE id = '${TEMPLATE_FIRM_A}';`,
    /foreign key|violates/i,
  );
}

function seedLegacyClient(db) {
  seedIdentity(db);
  psql(
    db,
    `INSERT INTO clients (id, tenant_id, name) VALUES ('${LEGACY_CLIENT_ID}', '${TENANT_A}', 'Pre-Templates legacy client sentinel');`,
  );
  return psql(
    db,
    `SELECT md5(row_to_json(c)::text) FROM clients c WHERE id='${LEGACY_CLIENT_ID}';`,
  );
}

function buildPreTemplatesPrismaCopy() {
  const copyRoot = resolve(tempRoot, 'prisma');
  cpSync(API_PRISMA, copyRoot, { recursive: true });
  const templatesCopy = resolve(copyRoot, 'migrations', TEMPLATES_MIGRATION_NAME);
  rmSync(templatesCopy, { recursive: true, force: true });
  rmSync(resolve(copyRoot, 'outreach-v3-templates/generated'), { recursive: true, force: true });
  return resolve(copyRoot, 'schema.prisma');
}

async function main() {
  requireCommand(PSQL);
  requireCommand('pnpm', ['--version']);
  console.log(`== Outreach V3 Templates DB rehearsal on ${PGHOST}:${PGPORT} ==`);
  console.log('Safety: creating disposable databases only; no DATABASE_URL target is accepted.');

  createProbeRole();

  console.log('\n-- Fresh path: full migration chain --');
  createDatabase(FRESH_DB);
  prismaMigrate(FRESH_DB, MAIN_SCHEMA);
  ok('fresh: full repository migration chain applies');
  prismaValidate(FRESH_DB, FOCUSED_SCHEMA);
  ok('fresh: focused Templates Prisma projection validates');
  proveDatabaseInvariants(FRESH_DB, 'fresh');

  console.log('\n-- Ordered-upgrade path: pre-Templates -> exact Templates migration --');
  createDatabase(UPGRADE_DB);
  const preTemplatesSchema = buildPreTemplatesPrismaCopy();
  prismaMigrate(UPGRADE_DB, preTemplatesSchema);
  ok('upgrade: pre-Templates repository migration chain applies');
  eq(
    'upgrade: Templates tables are absent before the new migration',
    psql(UPGRADE_DB, `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name = 'outreach_v3_templates';`),
    '0',
  );

  const legacyBefore = seedLegacyClient(UPGRADE_DB);
  ok('upgrade: real pre-existing `clients` row exists before the Templates migration');
  psqlFile(UPGRADE_DB, readFileSync(TEMPLATES_MIGRATION, 'utf8'));
  ok(`upgrade: exact ${basename(dirname(TEMPLATES_MIGRATION))}/migration.sql applies`);
  const legacyAfter = psql(
    UPGRADE_DB,
    `SELECT md5(row_to_json(c)::text) FROM clients c WHERE id='${LEGACY_CLIENT_ID}';`,
  );
  eq('upgrade: pre-existing `clients` row is byte/logically unchanged by ALTER TABLE clients', legacyAfter, legacyBefore);
  proveDatabaseInvariants(UPGRADE_DB, 'upgrade');

  console.log(`\nOUTREACH_V3_TEMPLATES_DB_COMPLETE (${passes} checks)`);
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  console.error(`OUTREACH_V3_TEMPLATES_DB_FAILED: ${error.stack || error.message || error}`);
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
