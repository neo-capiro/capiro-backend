import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  assertPhase2DisposableInvocation,
  createPhase2OwnedResources,
} from './ci/outreach-phase2-owned-resources.mjs';

const validEnv = {
  GITHUB_ACTIONS: 'true',
  CI: 'true',
  CI_DISPOSABLE_POSTGRES: '1',
  PGHOST: '127.0.0.1',
  PGPORT: '5432',
  PGUSER: 'postgres',
  PGPASSWORD: 'fixture',
};
const freshDb = 'outreach_v3_p2_fresh_fixture';
const upgradeDb = 'outreach_v3_p2_upgrade_fixture';
const probeRole = 'outreach_v3_p2_probe_fixture';
const appendOnlySql = readFileSync(
  new URL('./ci/research-portfolio-append-only-prerequisite.sql', import.meta.url),
  'utf8',
);

for (const [key, value] of Object.entries({
  GITHUB_ACTIONS: 'false',
  CI: 'false',
  CI_DISPOSABLE_POSTGRES: '0',
  PGHOST: 'db.example.invalid',
  PGPORT: '55433',
  PGUSER: 'other',
  PGHOSTADDR: '203.0.113.1',
  PGSERVICE: 'remote',
  PGSERVICEFILE: '/other.conf',
  PGOPTIONS: '-c role=other',
  PGDATABASE: 'shared',
})) {
  test(`rejects unsafe invocation ${key} before creating resources`, () => {
    assert.throws(() => assertPhase2DisposableInvocation({ ...validEnv, [key]: value }, 'linux'));
  });
}

test('refuses the former Windows split-target invocation even with all CI markers', () => {
  assert.throws(
    () => assertPhase2DisposableInvocation(validEnv, 'win32'),
    /split Docker\/native Windows/,
  );
});

test('pins libpq routing and removes inherited URLs and other PG settings without mutating caller', () => {
  const original = {
    ...validEnv,
    PGSSLMODE: 'require',
    PGPASSFILE: '/private',
    DATABASE_URL: 'remote',
    DIRECT_URL: 'remote',
    SHADOW_DATABASE_URL: 'remote',
    PATH: 'retained',
  };
  const snapshot = { ...original };
  const result = assertPhase2DisposableInvocation(original, 'linux');
  assert.deepEqual(result, {
    ...validEnv,
    PGHOSTADDR: '127.0.0.1',
    PGDATABASE: 'postgres',
    PATH: 'retained',
  });
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(original, snapshot);
});

test('real CLI rejects local invocation before any target subprocess or version probe', () => {
  // Missing executables make an attempted subprocess distinguishable from the guard diagnostic.
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./verify-outreach-v3-phase2-db.mjs', import.meta.url))],
    {
      env: {
        ...process.env,
        ...validEnv,
        GITHUB_ACTIONS: 'false',
        PATH: '',
        PSQL_BIN: 'must-never-execute-psql',
        PNPM_BIN: 'must-never-execute-pnpm',
      },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /direct local full rehearsals are unsupported/);
  assert.doesNotMatch(result.stderr, /ENOENT|must-never-execute/);
  assert.equal(result.stdout, '');
});

function fixture({
  identity = 'postgres|postgres|5432|on',
  ready = 't|t',
  fail = () => false,
  bootstrapFails = false,
} = {}) {
  const calls = [];
  const resources = createPhase2OwnedResources({
    freshDb,
    upgradeDb,
    probeRole,
    probePassword: 'safe_fixture',
    appendOnlySql,
    admin(sql) {
      calls.push({ sql });
      if (fail(sql)) throw new Error('injected SQL failure');
      if (sql.startsWith('SELECT current_database()')) return identity;
      if (sql.startsWith('SELECT EXISTS')) return ready;
      return '';
    },
    psqlInput(db, sql) {
      calls.push({ db, sql });
      if (bootstrapFails) throw new Error('injected prerequisite failure');
    },
  });
  return { calls, resources };
}

test('no mutation or cleanup contact is possible before target verification', () => {
  const { resources, calls } = fixture();
  assert.throws(() => resources.createProbe(), /not verified/);
  assert.throws(() => resources.createDb(freshDb), /not verified/);
  assert.deepEqual(resources.cleanup(), []);
  assert.deepEqual(calls, []);
});

for (const options of [
  { identity: 'shared|postgres|5432|on' },
  { identity: 'postgres|postgres|5433|on' },
  { identity: 'postgres|postgres|5432|off' },
  { ready: 'f|t' },
  { ready: 't|f' },
]) {
  test(`unexpected server or prerequisite ${JSON.stringify(options)} remains read-only`, () => {
    const { resources, calls } = fixture(options);
    assert.throws(() => resources.verifyTarget());
    assert.throws(() => resources.createDb(freshDb), /not verified/);
    assert.deepEqual(resources.cleanup(), []);
    assert.ok(calls.every(({ sql }) => sql.startsWith('SELECT ')));
  });
}

test('installs canonical append-only prerequisite in each owned database before returning it', () => {
  const { resources, calls } = fixture();
  resources.verifyTarget();
  resources.createProbe();
  resources.createDb(freshDb);
  resources.createDb(upgradeDb);
  const bootstraps = calls.filter(({ db }) => db);
  assert.deepEqual(bootstraps, [
    { db: freshDb, sql: appendOnlySql },
    { db: upgradeDb, sql: appendOnlySql },
  ]);
  for (const db of [freshDb, upgradeDb]) {
    const creationIndex = calls.findIndex(({ sql }) => sql === `CREATE DATABASE "${db}";`);
    assert.deepEqual(calls[creationIndex + 1], { db, sql: appendOnlySql });
  }
  assert.deepEqual(resources.cleanup(), []);
  assert.deepEqual(
    calls.filter(({ sql }) => sql.startsWith('DROP ')).map(({ sql }) => sql),
    [`DROP DATABASE "${upgradeDb}";`, `DROP DATABASE "${freshDb}";`, `DROP ROLE "${probeRole}";`],
  );
  const afterCleanup = calls.length;
  assert.deepEqual(resources.cleanup(), []);
  assert.equal(calls.length, afterCleanup);
});

test('preexisting database collision is never terminated or dropped, while owned earlier resources are cleaned', () => {
  const { resources, calls } = fixture({
    fail: (sql) => sql === `CREATE DATABASE "${upgradeDb}";`,
  });
  resources.verifyTarget();
  resources.createProbe();
  resources.createDb(freshDb);
  assert.throws(() => resources.createDb(upgradeDb), /injected/);
  assert.deepEqual(resources.cleanup(), []);
  assert.ok(calls.some(({ sql }) => sql === `DROP DATABASE "${freshDb}";`));
  assert.ok(
    !calls.some(
      ({ sql }) =>
        (sql.startsWith('DROP ') || sql.includes('pg_terminate_backend')) &&
        sql.includes(upgradeDb),
    ),
  );
});

test('preexisting probe collision is never dropped', () => {
  const { resources, calls } = fixture({ fail: (sql) => sql.startsWith('CREATE ROLE ') });
  resources.verifyTarget();
  assert.throws(() => resources.createProbe(), /injected/);
  assert.deepEqual(resources.cleanup(), []);
  assert.ok(!calls.some(({ sql }) => sql.startsWith('DROP ')));
});

test('prerequisite failure still cleans its newly owned database and cannot progress', () => {
  const { resources, calls } = fixture({ bootstrapFails: true });
  resources.verifyTarget();
  assert.throws(() => resources.createDb(freshDb), /prerequisite failure/);
  assert.deepEqual(resources.cleanup(), []);
  assert.ok(calls.some(({ sql }) => sql === `DROP DATABASE "${freshDb}";`));
});

test('rejects unrelated or repeated creation without extra SQL', () => {
  const { resources, calls } = fixture();
  resources.verifyTarget();
  resources.createProbe();
  resources.createDb(freshDb);
  const count = calls.length;
  assert.throws(() => resources.createDb('capiro'), /unowned/);
  assert.throws(() => resources.createDb(freshDb), /repeated/);
  assert.throws(() => resources.createProbe(), /already created/);
  assert.equal(calls.length, count);
  resources.cleanup();
});

test('cleanup failure is returned to fail the gate, without silently claiming success', () => {
  const { resources, calls } = fixture({ fail: (sql) => sql.startsWith('DROP DATABASE ') });
  resources.verifyTarget();
  resources.createProbe();
  resources.createDb(freshDb);
  assert.equal(resources.cleanup().length, 1);
  assert.ok(calls.some(({ sql }) => sql === `DROP ROLE "${probeRole}";`));
});

test('rejects identifier injection and truncation collisions before invoking SQL', () => {
  for (const name of [
    'capiro',
    `${freshDb}";DROP DATABASE capiro;--`,
    `outreach_v3_p2_fresh_${'a'.repeat(64)}`,
  ]) {
    assert.throws(
      () =>
        createPhase2OwnedResources({
          freshDb: name,
          upgradeDb,
          probeRole,
          probePassword: 'safe',
          admin: assert.fail,
          psqlInput: assert.fail,
          appendOnlySql,
        }),
      /Invalid owned/,
    );
  }
});

test('flow-only resources do not create or drop any probe role', () => {
  const calls = [];
  const db = 'outreach_v3_p2_flow_fixture';
  const resources = createPhase2OwnedResources({
    freshDb: db,
    appendOnlySql,
    admin(sql) {
      calls.push(sql);
      if (sql.startsWith('SELECT current_database()')) return 'postgres|postgres|5432|on';
      if (sql.startsWith('SELECT EXISTS')) return 't|t';
      return '';
    },
    psqlInput(actualDb, sql) {
      assert.equal(actualDb, db);
      assert.equal(sql, appendOnlySql);
    },
  });
  resources.verifyTarget();
  assert.throws(() => resources.createProbe(), /No probe role/);
  resources.createDb(db);
  assert.deepEqual(resources.cleanup(), []);
  assert.ok(calls.includes(`DROP DATABASE "${db}";`));
  assert.ok(!calls.some((sql) => /(?:CREATE|DROP) ROLE/.test(sql)));
});

test('real flow CLI rejects local invocation before any target subprocess', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./run-outreach-v3-phase2-flow-db.mjs', import.meta.url))],
    {
      env: {
        ...process.env,
        ...validEnv,
        GITHUB_ACTIONS: 'false',
        PATH: '',
        PSQL_BIN: 'must-never-execute-psql',
      },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /direct local full rehearsals are unsupported/);
  assert.doesNotMatch(result.stderr, /ENOENT|must-never-execute/);
  assert.equal(result.stdout, '');
});
