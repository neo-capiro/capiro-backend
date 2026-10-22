import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

// Operator-run fixtures only. This script never accepts a database URL, host,
// existing container, host mount, or network port. It is not a deploy runner.
if (process.argv.length !== 3 || process.argv[2] !== '--run') {
  console.error('NOT RUN: authorized operator must explicitly pass --run; disposable PostgreSQL 16 only.');
  process.exit(2);
}

const paths = {
  owners: '20281012020000_client_ordered_owners',
  originalReceipt: '20281018020000_clio_meri_memory_submissions',
  scope: '20281018080000_clio_memory_scope_unique',
  receipt: '20281018090000_clio_meri_memory_submissions_content_free',
};
const sources = Object.fromEntries(Object.entries(paths).map(([key, name]) => [
  key, readFileSync(new URL(`../../prisma/migrations/${name}/migration.sql`, import.meta.url)),
]));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const receipt = {
  gate: 'core-migration-cleanup-postgres16-fixtures',
  sourceSha256: Object.fromEntries(Object.entries(sources).map(([key, bytes]) => [
    `apps/api/prisma/migrations/${paths[key]}/migration.sql`, sha256(bytes),
  ])),
  cases: [],
  fullLedgerMigrateDeploy: 'NOT RUN: separate operator gate',
  passed: false,
};
const tenant = '11111111-1111-4111-8111-111111111111';
const user = '22222222-2222-4222-8222-222222222222';
const client = '33333333-3333-4333-8333-333333333333';
const functions = `
CREATE FUNCTION rls_bypass() RETURNS boolean LANGUAGE sql AS 'SELECT false';
CREATE FUNCTION current_tenant_id() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
`;
let containerId;

function docker(args, input, requireSuccess = true) {
  // Pin the local daemon explicitly: inherited DOCKER_HOST/CONTEXT cannot
  // redirect this fixture to an operator's cloud or product environment.
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

function query(database, statement) {
  return sql(database, statement).stdout.trim();
}

function newDatabase(name, setup) {
  assert.match(name, /^[a-z][a-z0-9_]*$/);
  sql('postgres', `CREATE DATABASE ${name};`);
  sql(name, setup);
}

function rejects(result, state, marker) {
  assert.notEqual(result.status, 0, 'Expected migration to fail closed');
  assert.match(result.stderr, new RegExp(`ERROR:\\s+${state}:`));
  assert.ok(result.stderr.includes(marker), result.stderr);
}

function columnState(database) {
  return JSON.parse(query(database, `SELECT json_build_object(
    'type', a.atttypid::regtype::text, 'notNull', a.attnotnull,
    'default', pg_get_expr(d.adbin,d.adrelid), 'identity', a.attidentity,
    'generated', a.attgenerated, 'value', (SELECT account_owner_version FROM clients)
  ) FROM pg_attribute a LEFT JOIN pg_attrdef d
    ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE a.attrelid='clients'::regclass AND a.attname='account_owner_version';`));
}

function checkState(database) {
  return query(database, `SELECT convalidated::text FROM pg_constraint
    WHERE conrelid='clients'::regclass
      AND conname='clients_account_owner_version_nonnegative';`);
}

function ownerCases() {
  const cases = [
    ['owners_absent', '', undefined, null],
    ['owners_matching', 'integer NOT NULL DEFAULT 0', 7, null],
    ['owners_wrong_type', 'bigint NOT NULL DEFAULT 0', 7, '55000'],
    ['owners_nullable', 'integer DEFAULT 0', 7, '55000'],
    ['owners_wrong_default', 'integer NOT NULL DEFAULT 1', 7, '55000'],
    ['owners_missing_default', 'integer NOT NULL', 7, '55000'],
    ['owners_negative_existing', 'integer NOT NULL DEFAULT 0', -1, '23514'],
  ];
  for (const [name, shape, value, expectedError] of cases) {
    newDatabase(name, `${functions}
      CREATE TABLE users(id uuid PRIMARY KEY);
      CREATE TABLE clients(tenant_id uuid NOT NULL,id uuid NOT NULL,
        account_owner_user_id uuid REFERENCES users(id),
        ${shape ? `account_owner_version ${shape},` : ''}
        PRIMARY KEY(tenant_id,id));
      INSERT INTO users VALUES ('${user}');
      INSERT INTO clients(tenant_id,id,account_owner_user_id${shape ? ',account_owner_version' : ''})
        VALUES ('${tenant}','${client}','${user}'${shape ? `,${value}` : ''});`);
    const before = shape ? columnState(name) : null;
    // Whole source bytes, with no schema rewriting or added transaction wrapper.
    const result = sql(name, sources.owners, false);
    if (expectedError) {
      rejects(result, expectedError, expectedError === '55000'
        ? 'account_owner_version must be integer NOT NULL DEFAULT 0'
        : 'clients_account_owner_version_nonnegative');
      assert.deepEqual(columnState(name), before);
      assert.equal(query(name, "SELECT to_regclass('client_ordered_owners') IS NULL;"), 't');
      assert.equal(checkState(name), expectedError === '23514' ? 'false' : '');
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(columnState(name), {
        type: 'integer', notNull: true, default: '0', identity: '', generated: '', value: value ?? 0,
      });
      assert.equal(checkState(name), 'true');
      assert.equal(query(name, `SELECT count(*) FROM client_ordered_owners
        WHERE tenant_id='${tenant}' AND client_id='${client}' AND rank=1 AND user_id='${user}';`), '1');
      assert.equal(query(name, `SELECT relrowsecurity AND relforcerowsecurity FROM pg_class
        WHERE oid='client_ordered_owners'::regclass;`), 't');
      assert.equal(query(name, `SELECT count(*) FROM pg_trigger WHERE
        tgname IN ('client_ordered_owners_consistent','clients_ordered_owners_consistent')
        AND tgdeferrable AND tginitdeferred;`), '2');
      rejects(sql(name, 'UPDATE clients SET account_owner_version=-1;', false),
        '23514', 'clients_account_owner_version_nonnegative');
      assert.equal(columnState(name).value, value ?? 0);
    }
    receipt.cases.push({ name, passed: true });
  }
}

function scopeCases() {
  const exact = "(scope='firm' AND owner_user_id IS NULL AND client_id IS NULL) OR " +
    "(scope='user_private' AND owner_user_id IS NOT NULL AND client_id IS NULL) OR " +
    "(scope='client' AND owner_user_id IS NULL AND client_id IS NOT NULL)";
  // Same column bindings, but firm rows improperly permit a client. A name or
  // conkey-only guard must not accept this weaker expression.
  const weaker = "(scope='firm' AND owner_user_id IS NULL) OR " +
    "(scope='user_private' AND owner_user_id IS NOT NULL AND client_id IS NULL) OR " +
    "(scope='client' AND owner_user_id IS NULL AND client_id IS NOT NULL)";
  for (const [name, check, valid, succeeds] of [
    ['memory_scope_exact', exact, true, true],
    ['memory_scope_absent', null, true, false],
    ['memory_scope_unvalidated', exact, false, false],
    ['memory_scope_weaker', weaker, true, false],
  ]) {
    newDatabase(name, `CREATE TABLE clio_memory(tenant_id uuid NOT NULL,
      scope text NOT NULL,key text NOT NULL,owner_user_id uuid,client_id uuid);
      CREATE UNIQUE INDEX clio_memory_firm_key_uniq ON clio_memory(tenant_id,scope,key)
        WHERE owner_user_id IS NULL;
      ${check ? `ALTER TABLE clio_memory ADD CONSTRAINT clio_memory_scope_owner_check
        CHECK (${check})${valid ? '' : ' NOT VALID'};` : ''}`);
    const oldIndex = query(name, "SELECT pg_get_indexdef('clio_memory_firm_key_uniq'::regclass);");
    const result = sql(name, sources.scope, false);
    if (succeeds) {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(query(name, "SELECT to_regclass('clio_memory_client_key_uniq') IS NOT NULL;"), 't');
      assert.notEqual(query(name, "SELECT pg_get_indexdef('clio_memory_firm_key_uniq'::regclass);"), oldIndex);
    } else {
      rejects(result, 'P0001', 'expected client-aware clio_memory_scope_owner_check is absent or changed');
      assert.equal(query(name, "SELECT pg_get_indexdef('clio_memory_firm_key_uniq'::regclass);"), oldIndex);
      assert.equal(query(name, "SELECT to_regclass('clio_memory_client_key_uniq') IS NULL;"), 't');
    }
    receipt.cases.push({ name, passed: true });
  }
}

function receiptCases() {
  const table = 'clio_meri_memory_submissions';
  for (const [name, changedConstraint] of [
    ['memory_receipt_exact', ''],
    ['memory_receipt_wrong_pk', `ALTER TABLE ${table} DROP CONSTRAINT ${table}_pkey;
      ALTER TABLE ${table} ADD CONSTRAINT ${table}_pkey PRIMARY KEY(candidate_id);`],
    ['memory_receipt_wrong_unique', `ALTER TABLE ${table} DROP CONSTRAINT ${table}_review_id_key;
      ALTER TABLE ${table} ADD CONSTRAINT ${table}_review_id_key UNIQUE(candidate_id);`],
    ['memory_receipt_wrong_fk', `CREATE TABLE other_tenants(id uuid PRIMARY KEY);
      INSERT INTO other_tenants VALUES ('${tenant}');
      ALTER TABLE ${table} DROP CONSTRAINT ${table}_tenant_fkey;
      ALTER TABLE ${table} ADD CONSTRAINT ${table}_tenant_fkey
        FOREIGN KEY(tenant_id) REFERENCES other_tenants(id) ON DELETE CASCADE;`],
  ]) {
    newDatabase(name, `${functions} CREATE TABLE tenants(id uuid PRIMARY KEY);
      INSERT INTO tenants VALUES ('${tenant}');
      CREATE TABLE _prisma_migrations(migration_name text,checksum text,
        finished_at timestamptz,rolled_back_at timestamptz);
      INSERT INTO _prisma_migrations VALUES ('${paths.originalReceipt}',
        '${sha256(sources.originalReceipt)}',CURRENT_TIMESTAMP,NULL);`);
    sql(name, sources.originalReceipt);
    sql(name, `INSERT INTO ${table}(tenant_id,candidate_id,candidate_sha256,
      proposer_user_id,review_id,candidate) VALUES ('${tenant}','${client}',
      '${'a'.repeat(64)}','${user}','${user}','{"preserve":"fixture"}'); ${changedConstraint}`);
    const before = query(name, `SELECT candidate::text FROM ${table};`);
    const result = sql(name, sources.receipt, false);
    if (changedConstraint) {
      rejects(result, '55000', 'Stage 1 requires the original primary, review-unique and tenant foreign keys');
      assert.equal(query(name, `SELECT attnotnull FROM pg_attribute
        WHERE attrelid='${table}'::regclass AND attname='candidate';`), 't');
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(query(name, `SELECT attnotnull FROM pg_attribute
        WHERE attrelid='${table}'::regclass AND attname='candidate';`), 'f');
    }
    assert.equal(query(name, `SELECT candidate::text FROM ${table};`), before);
    receipt.cases.push({ name, passed: true });
  }
}

try {
  const [image] = JSON.parse(docker(['image', 'inspect', 'postgres:16']).stdout);
  assert.match(image.Id, /^sha256:[a-f0-9]{64}$/);
  receipt.image = { requested: 'postgres:16', id: image.Id, repoDigests: image.RepoDigests ?? [] };
  const name = `core108-fixtures-${randomUUID()}`;
  assert.notEqual(docker(['container', 'inspect', name], undefined, false).status, 0,
    'Refusing an existing container');
  containerId = docker(['run', '--pull=never', '-d', '--name', name, '--network', 'none',
    '--label', 'capiro.qualification=core108-disposable',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', image.Id]).stdout.trim();
  assert.match(containerId, /^[a-f0-9]{64}$/);
  const [container] = JSON.parse(docker(['container', 'inspect', containerId]).stdout);
  assert.equal(container.Image, image.Id);
  assert.equal(container.HostConfig.NetworkMode, 'none');
  assert.ok(!container.HostConfig.Binds?.length);
  assert.ok(!Object.keys(container.HostConfig.PortBindings ?? {}).length);
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
  receipt.serverVersion = query('postgres', 'SELECT version();');
  ownerCases();
  scopeCases();
  receiptCases();
  receipt.passed = true;
} catch (error) {
  receipt.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (/^[a-f0-9]{64}$/.test(containerId ?? '')) {
    try {
      docker(['rm', '-f', '-v', containerId]);
      receipt.ownedContainerRemoved = true;
    } catch (error) {
      receipt.ownedContainerRemoved = false;
      receipt.cleanupError = error instanceof Error ? error.message : String(error);
      receipt.passed = false;
      process.exitCode = 1;
    }
  }
  console.log(JSON.stringify(receipt, null, 2));
}
