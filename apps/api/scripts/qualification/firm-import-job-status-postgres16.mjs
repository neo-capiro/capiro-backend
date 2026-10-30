import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { ownedPostgresContainer } from './owned-postgres-container.mjs';

// Operator-run fixtures only. Never accepts a database URL, host, existing
// container, mount or network port; starts a disposable local PostgreSQL 16.
if (process.argv.length !== 3 || process.argv[2] !== '--run') {
  console.error('NOT RUN: authorized operator must explicitly pass --run; disposable PostgreSQL 16 only.');
  process.exit(2);
}

const migrationPath = '20281030140000_firm_import_job_status';
const migration = readFileSync(
  new URL(`../../prisma/migrations/${migrationPath}/migration.sql`, import.meta.url),
);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const tenant = '11111111-1111-4111-8111-111111111111';
const user = '22222222-2222-4222-8222-222222222222';
const client = '33333333-3333-4333-8333-333333333333';
const job = '44444444-4444-4444-8444-444444444444';
const jobs = [
  ['55555555-5555-4555-8555-000000000001', '2026-10-30 09:00:00.123900+00'],
  ['55555555-5555-4555-8555-000000000002', '2026-10-30 09:00:00.123800+00'],
  ['55555555-5555-4555-8555-000000000003', '2026-10-30 09:00:00.123400+00'],
  ['55555555-5555-4555-8555-000000000004', '2026-10-30 09:00:00.123900+00'],
  ['55555555-5555-4555-8555-000000000005', '2026-10-30 09:00:00.123000+00'],
  ['55555555-5555-4555-8555-000000000006', '2026-10-30 09:00:00.123000+00'],
];
const receipt = {
  gate: 'firm-import-job-status-postgres16',
  migration: `apps/api/prisma/migrations/${migrationPath}/migration.sql`,
  migrationSha256: sha256(migration),
  cases: [],
  passed: false,
};
let containerId;
let lifecycle;

function docker(args, input, requireSuccess = true) {
  const result = spawnSync('docker', ['--host', 'unix:///var/run/docker.sock', ...args], {
    input, encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  if (requireSuccess) assert.equal(result.status, 0, result.stderr);
  return result;
}

function sql(database, content, requireSuccess = true) {
  assert.match(containerId ?? '', /^[a-f0-9]{64}$/);
  return docker(['exec', '-i', containerId, 'psql', '-X', '-A', '-t',
    '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1',
    '-v', 'VERBOSITY=verbose'], content, requireSuccess);
}
const query = (database, statement) => sql(database, statement).stdout.trim();
const rejectedByCheck = (result) => {
  assert.notEqual(result.status, 0, 'Expected the outcome CHECK to reject the row');
  assert.match(result.stderr, /ERROR:\s+23514:/);
};

function insertItem(database, values) {
  return sql(database, `INSERT INTO firm_import_job_items
    (tenant_id, job_id, lda_client_id, outcome, code, client_id, processed_at)
    VALUES ('${tenant}', '${job}', 10, ${values});`, false);
}

function outcomeShapeCases() {
  const valid = [
    ['pending', `'pending', NULL, NULL, NULL`],
    ['created', `'created', NULL, '${client}', clock_timestamp()`],
    ['already_present', `'already_present', NULL, '${client}', clock_timestamp()`],
    ['rejected_not_own', `'rejected', 'NOT_OWN_CLIENT', NULL, clock_timestamp()`],
    ['rejected_not_found', `'rejected', 'LDA_CLIENT_NOT_FOUND', NULL, clock_timestamp()`],
    ['rejected_capacity', `'rejected', 'CLIENT_SLOT_LIMIT', NULL, clock_timestamp()`],
    ['rejected_internal', `'rejected', 'INTERNAL_ERROR', NULL, clock_timestamp()`],
  ];
  for (const [name, values] of valid) {
    const result = insertItem('b12_schema', values);
    assert.equal(result.status, 0, result.stderr);
    receipt.cases.push({ name: `outcome_valid_${name}`, passed: true });
  }
  const invalid = [
    ['rejected_null_code', `'rejected', NULL, NULL, clock_timestamp()`],
    ['rejected_unknown_code', `'rejected', 'UNKNOWN_CODE', NULL, clock_timestamp()`],
    ['rejected_with_client', `'rejected', 'NOT_OWN_CLIENT', '${client}', clock_timestamp()`],
    ['created_with_code', `'created', 'INTERNAL_ERROR', '${client}', clock_timestamp()`],
    ['pending_with_processed', `'pending', NULL, NULL, clock_timestamp()`],
  ];
  for (const [name, values] of invalid) {
    rejectedByCheck(insertItem('b12_schema', values));
    receipt.cases.push({ name: `outcome_invalid_${name}`, passed: true });
  }
}

function constraintCases() {
  const rows = query('b12_schema', `SELECT conname || '|' || confupdtype || '|' || confdeltype
    FROM pg_constraint WHERE conname IN (
      'firm_import_jobs_tenant_fkey',
      'firm_import_jobs_requested_by_fkey',
      'firm_import_job_items_job_fkey') ORDER BY conname;`)
    .split('\n');
  assert.deepEqual(rows, [
    'firm_import_job_items_job_fkey|a|c',
    'firm_import_jobs_requested_by_fkey|a|r',
    'firm_import_jobs_tenant_fkey|a|c',
  ]);
  receipt.cases.push({ name: 'foreign_key_names_and_no_action_updates', passed: true });
}

function precisionCases() {
  assert.equal(
    query('b12_schema', `SELECT format_type(atttypid, atttypmod) FROM pg_attribute
      WHERE attrelid='firm_import_jobs'::regclass AND attname='created_at';`),
    'timestamp(3) with time zone',
  );
  assert.match(
    query('b12_schema', `SELECT pg_get_expr(adbin, adrelid) FROM pg_attrdef
      WHERE adrelid='firm_import_jobs'::regclass AND adnum=(
        SELECT attnum FROM pg_attribute WHERE attrelid='firm_import_jobs'::regclass
          AND attname='created_at');`),
    /date_trunc\('milliseconds'/,
  );
  for (const [id, instant] of jobs) {
    sql('b12_schema', `INSERT INTO firm_import_jobs
      (id, tenant_id, requested_by_user_id, request_key, request_sha256,
       lda_registrant_id, requested_ids, created_at)
      VALUES ('${id}', '${tenant}', '${user}', 'req-${id.slice(-2)}',
        repeat('a', 64), 7, ARRAY[10], '${instant}');`);
  }
  assert.equal(
    query('b12_schema', `SELECT count(*) FROM firm_import_jobs
      WHERE created_at <> date_trunc('milliseconds', created_at);`),
    '0',
  );
  assert.equal(
    query('b12_schema', `SELECT string_agg(to_char(created_at AT TIME ZONE 'UTC',
      'HH24:MI:SS.MS'), ',' ORDER BY id) FROM firm_import_jobs;`),
    '09:00:00.124,09:00:00.124,09:00:00.123,09:00:00.124,09:00:00.123,09:00:00.123',
  );

  // Same predicates as FirmImportJobStore.listJobs, with JavaScript-Date
  // (millisecond) cursor text: page boundaries must not skip sub-millisecond
  // source instants that collapsed into one stored millisecond.
  const pages = [];
  let boundary = null;
  for (;;) {
    const where = boundary
      ? `WHERE created_at < '${boundary.createdAt}'::timestamptz
           OR (created_at = '${boundary.createdAt}'::timestamptz AND id < '${boundary.id}')`
      : '';
    const rows = query('b12_schema', `SELECT id || '|' || to_char(created_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      FROM firm_import_jobs ${where}
      ORDER BY created_at DESC, id DESC LIMIT 2;`).split('\n').filter(Boolean);
    if (!rows.length) break;
    pages.push(rows.map((row) => row.split('|')[0]));
    const [id, createdAt] = rows.at(-1).split('|');
    boundary = { id, createdAt };
  }
  const flat = pages.flat();
  assert.equal(flat.length, jobs.length);
  assert.equal(new Set(flat).size, jobs.length, 'A keyset page boundary skipped or repeated a row');
  receipt.pages = pages;
  receipt.cases.push({ name: 'millisecond_keyset_boundary_and_ties', passed: true });
}

try {
  const postgresImage = process.env.CAPIRO_POSTGRES_FIXTURE_IMAGE || 'postgres:16';
  assert.ok(['postgres:16', 'pgvector/pgvector:pg16'].includes(postgresImage),
    'Only the standard or preserved PostgreSQL16 fixture image is allowed');
  const [image] = JSON.parse(docker(['image', 'inspect', postgresImage]).stdout);
  assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
  receipt.image = { requested: postgresImage, id: image.Id, repoDigests: image.RepoDigests ?? [] };
  const name = `core108-fixtures-${randomUUID()}`;
  receipt.containerName = name;
  lifecycle = ownedPostgresContainer({ docker, imageId: image.Id, name, ownershipToken: randomUUID() });
  containerId = lifecycle.start();
  receipt.containerId = containerId;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (docker(['exec', containerId, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], undefined, false).status === 0) {
      ready = true;
      break;
    }
    await delay(1000);
  }
  assert.ok(ready, 'Disposable PostgreSQL did not become ready');
  const version = Number(query('postgres', 'SHOW server_version_num;'));
  assert.ok(version >= 160000 && version < 170000, `PostgreSQL 16 required, observed ${version}`);
  receipt.serverVersionNum = version;

  sql('postgres', `CREATE ROLE capiro_app NOLOGIN;
    CREATE FUNCTION rls_bypass() RETURNS boolean LANGUAGE sql AS 'SELECT true';
    CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    CREATE TABLE tenants(id uuid PRIMARY KEY);
    CREATE TABLE users(id uuid PRIMARY KEY);
    INSERT INTO tenants VALUES ('${tenant}');
    INSERT INTO users VALUES ('${user}');
    CREATE DATABASE b12_schema;`);
  sql('b12_schema', `CREATE FUNCTION rls_bypass() RETURNS boolean LANGUAGE sql AS 'SELECT true';
    CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    CREATE TABLE tenants(id uuid PRIMARY KEY);
    CREATE TABLE users(id uuid PRIMARY KEY);
    INSERT INTO tenants VALUES ('${tenant}');
    INSERT INTO users VALUES ('${user}');
    CREATE TABLE clients(id uuid PRIMARY KEY);
    INSERT INTO clients VALUES ('${client}');`);
  const applied = sql('b12_schema', migration, false);
  assert.equal(applied.status, 0, applied.stderr);
  receipt.cases.push({ name: 'migration_applies_to_isolated_pg16', passed: true });

  sql('b12_schema', `INSERT INTO firm_import_jobs
    (id, tenant_id, requested_by_user_id, request_key, request_sha256, lda_registrant_id, requested_ids)
    VALUES ('${job}', '${tenant}', '${user}', 'outcome-shapes', repeat('b', 64), 7, ARRAY[10]);`);
  constraintCases();
  outcomeShapeCases();
  precisionCases();
  assert.equal(query('b12_schema', `SELECT has_table_privilege('capiro_app','firm_import_jobs','DELETE');`), 'f');
  receipt.cases.push({ name: 'no_delete_grant', passed: true });
  receipt.passed = true;
} catch (error) {
  receipt.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (lifecycle) {
    receipt.containerId = lifecycle.id ?? null;
    try {
      receipt.containerCleanup = lifecycle.cleanup();
      receipt.ownedContainerRemoved = receipt.containerCleanup.removed;
    } catch (error) {
      receipt.ownedContainerRemoved = false;
      receipt.cleanupError = error instanceof Error ? error.message : String(error);
      receipt.passed = false;
      process.exitCode = 1;
    }
  }
  console.log(JSON.stringify(receipt, null, 2));
}
