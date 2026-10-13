import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const HELPER = fileURLToPath(new URL('./pe-phase-9-owned-postgres.sh', import.meta.url));
const WORKER_SQL = readFileSync(join(ROOT, 'scripts/ci/disposable-capiro-worker-role.sql'));
const CONTAINER_ID = 'abc01234'.repeat(8);
const NAME = 'pe9-owned-postgres-regression';

const FAKE_DOCKER = `
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const env = process.env;
appendFileSync(env.PE9_TEST_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'container' && args[1] === 'inspect') {
  process.exit(env.PE9_TEST_COLLISION === '1' ? 0 : 1);
}
if (args[0] === 'run') {
  if (env.PE9_TEST_RUN_EXIT !== '0') process.exit(Number(env.PE9_TEST_RUN_EXIT));
  process.stdout.write(env.PE9_TEST_CREATED_ID + '\\n');
  process.exit(0);
}
if (args[0] === 'exec' && args.includes('pg_isready')) {
  const prior = existsSync(env.PE9_TEST_READY_COUNT)
    ? Number(readFileSync(env.PE9_TEST_READY_COUNT, 'utf8')) : 0;
  writeFileSync(env.PE9_TEST_READY_COUNT, String(prior + 1));
  process.exit(prior < Number(env.PE9_TEST_READY_FAILURES) ? 1 : 0);
}
if (args[0] === 'exec' && args.includes('psql')) {
  writeFileSync(env.PE9_TEST_SQL_INPUT, readFileSync(0));
  process.exit(Number(env.PE9_TEST_BOOTSTRAP_EXIT));
}
if (args[0] === 'rm') process.exit(0);
process.stderr.write('Unexpected fake docker command: ' + JSON.stringify(args) + '\\n');
process.exit(91);
`;

const DRIVER = `
set -euo pipefail
source "$PE9_TEST_HELPER"
CONTAINER_ID=stale-unowned-name
trap cleanup EXIT
start_owned_postgres
printf 'observed_container_id=%s\\n' "$CONTAINER_ID"
bootstrap_owned_worker
printf 'bootstrap_complete\\n'
`;

function exercise(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pe9-owned-postgres-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'docker.jsonl');
  const sqlInput = join(dir, 'worker-input.sql');
  const dockerScript = join(dir, 'fake-docker.cjs');
  writeFileSync(dockerScript, FAKE_DOCKER);
  writeFileSync(
    join(dir, 'docker'),
    '#!/usr/bin/env bash\nexec "$PE9_TEST_NODE" "$PE9_TEST_DOCKER_SCRIPT" "$@"\n',
    { mode: 0o755 },
  );
  writeFileSync(join(dir, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  const result = spawnSync('bash', ['--noprofile', '--norc', '-c', DRIVER], {
    encoding: 'utf8',
    timeout: 15000,
    env: {
      PATH: `${dir}${delimiter}${process.env.PATH}`,
      ROOT,
      NAME,
      IMAGE: 'pgvector/pgvector:pg16',
      PORT: '55439',
      USER_NAME: 'capiro',
      PASS: 'owned-fixture-password',
      KEEP: '0',
      PE9_TEST_HELPER: HELPER,
      PE9_TEST_NODE: process.execPath,
      PE9_TEST_DOCKER_SCRIPT: dockerScript,
      PE9_TEST_LOG: log,
      PE9_TEST_SQL_INPUT: sqlInput,
      PE9_TEST_READY_COUNT: join(dir, 'ready-count'),
      PE9_TEST_COLLISION: '0',
      PE9_TEST_CREATED_ID: CONTAINER_ID,
      PE9_TEST_READY_FAILURES: '0',
      PE9_TEST_RUN_EXIT: '0',
      PE9_TEST_BOOTSTRAP_EXIT: '0',
      ...options,
    },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { result, calls, sql: existsSync(sqlInput) ? readFileSync(sqlInput) : undefined };
}

function callsFor(calls, command) {
  return calls.filter((args) => args[0] === command);
}

test('existing container name is refused without creation, bootstrap, or deletion', (t) => {
  const { result, calls, sql } = exercise(t, { PE9_TEST_COLLISION: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /container name already exists; refusing replacement/);
  assert.deepEqual(calls, [['container', 'inspect', NAME]]);
  assert.equal(sql, undefined);
  assert.doesNotMatch(result.stdout, /created_container_id|bootstrap_complete/);
});

test('startup records the created ID, publishes loopback only, and waits for TCP readiness', (t) => {
  const { result, calls } = exercise(t, { PE9_TEST_READY_FAILURES: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`created_container_id=${CONTAINER_ID}`));
  assert.match(result.stdout, new RegExp(`observed_container_id=${CONTAINER_ID}`));
  assert.deepEqual(calls[0], ['container', 'inspect', NAME]);
  const [run] = callsFor(calls, 'run');
  assert.equal(callsFor(calls, 'run').length, 1);
  assert.equal(run[run.indexOf('--name') + 1], NAME);
  assert.equal(run[run.indexOf('-p') + 1], '127.0.0.1:55439:5432');
  assert.equal(run.at(-1), 'pgvector/pgvector:pg16');
  const readiness = calls.filter((args) => args.includes('pg_isready'));
  assert.equal(readiness.length, 2);
  for (const args of readiness) {
    assert.equal(args[1], CONTAINER_ID);
    assert.equal(args[args.indexOf('-h') + 1], '127.0.0.1');
    assert.equal(args[args.indexOf('-U') + 1], 'capiro');
    assert.equal(args[args.indexOf('-d') + 1], 'capiro');
  }
});

test('bootstrap passes the exact canonical worker SQL to the created container and maintenance database', (t) => {
  const { result, calls, sql } = exercise(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(sql, WORKER_SQL);
  const bootstrap = calls.filter((args) => args.includes('psql'));
  assert.equal(bootstrap.length, 1);
  const [args] = bootstrap;
  assert.ok(args.includes('-i'));
  assert.equal(args[args.indexOf('psql') - 1], CONTAINER_ID);
  assert.equal(args[args.indexOf('-h') + 1], '127.0.0.1');
  assert.equal(args[args.indexOf('-U') + 1], 'capiro');
  assert.equal(args[args.indexOf('-d') + 1], 'postgres');
  assert.ok(args.includes('ON_ERROR_STOP=1'));
  assert.ok(calls.findIndex((call) => call.includes('pg_isready')) < calls.indexOf(args));
  assert.match(result.stdout, /bootstrap_complete/);
});

test('cleanup removes volumes only for the recorded created container ID', (t) => {
  const { result, calls } = exercise(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(callsFor(calls, 'rm'), [['rm', '-f', '-v', CONTAINER_ID]]);
  for (const args of callsFor(calls, 'exec')) assert.ok(args.includes(CONTAINER_ID));
  assert.equal(calls.at(-1)[0], 'rm');
});

test('worker bootstrap failure propagates its nonzero status and cleans up the owned container', (t) => {
  const { result, calls, sql } = exercise(t, { PE9_TEST_BOOTSTRAP_EXIT: '43' });
  assert.equal(result.status, 43);
  assert.deepEqual(sql, WORKER_SQL);
  assert.doesNotMatch(result.stdout, /bootstrap_complete/);
  assert.deepEqual(callsFor(calls, 'rm'), [['rm', '-f', '-v', CONTAINER_ID]]);
});

test('KEEP preserves the owned container without issuing any removal', (t) => {
  const { result, calls } = exercise(t, { KEEP: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`KEEP=1.*${CONTAINER_ID}`));
  assert.deepEqual(callsFor(calls, 'rm'), []);
  assert.equal(calls.filter((args) => args.includes('psql')).length, 1);
});

test('a failed docker creation propagates without touching the name or attempting bootstrap', (t) => {
  const { result, calls, sql } = exercise(t, { PE9_TEST_RUN_EXIT: '42' });
  assert.equal(result.status, 42);
  assert.deepEqual(callsFor(calls, 'rm'), []);
  assert.deepEqual(callsFor(calls, 'exec'), []);
  assert.equal(sql, undefined);
  assert.doesNotMatch(result.stdout, /created_container_id|bootstrap_complete/);
});

for (const id of ['short-id', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64)]) {
  test(`invalid created ID is refused without deletion or bootstrap: ${id.length} characters`, (t) => {
    const { result, calls, sql } = exercise(t, { PE9_TEST_CREATED_ID: id });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /docker did not return a created container ID/);
    assert.deepEqual(callsFor(calls, 'rm'), []);
    assert.deepEqual(callsFor(calls, 'exec'), []);
    assert.equal(sql, undefined);
  });
}
