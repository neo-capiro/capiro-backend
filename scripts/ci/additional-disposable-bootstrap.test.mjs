import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '../../node_modules/.pnpm/@electric-sql+pglite@0.5.8/node_modules/@electric-sql/pglite/dist/index.js';

const sql = readFileSync(new URL('./disposable-capiro-worker-role.sql', import.meta.url), 'utf8');
const funding = fileURLToPath(new URL('./bootstrap-funding-opportunities-test-dbs.sh', import.meta.url));
const defense = fileURLToPath(new URL('../verify-phase8-session2-db.sh', import.meta.url));

test('missing worker becomes a restricted capability role and safe reruns preserve its identity', async () => {
  const db = new PGlite();
  try {
    await db.exec(sql);
    const query = "SELECT oid,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls FROM pg_roles WHERE rolname='capiro_worker'";
    const before = (await db.query(query)).rows;
    assert.equal(before.length, 1);
    for (const [key, value] of Object.entries(before[0])) if (key !== 'oid') assert.equal(value, false, key);
    await db.exec(sql);
    assert.deepEqual((await db.query(query)).rows, before);
    assert.deepEqual((await db.query("SELECT rolname FROM pg_roles WHERE rolname LIKE 'capiro_%'")).rows, [{rolname:'capiro_worker'}]);
  } finally { await db.close(); }
});

for (const flag of ['LOGIN', 'SUPERUSER', 'CREATEDB', 'CREATEROLE', 'INHERIT', 'BYPASSRLS', 'REPLICATION']) {
  test(`unsafe existing worker ${flag} is rejected without changing it`, async () => {
    const db = new PGlite();
    try {
      await db.exec(`CREATE ROLE capiro_worker NOLOGIN NOINHERIT; ALTER ROLE capiro_worker ${flag};`);
      const before = (await db.query("SELECT * FROM pg_roles WHERE rolname='capiro_worker'")).rows;
      await assert.rejects(db.exec(sql), /not the expected least-privilege CI fixture/);
      assert.deepEqual((await db.query("SELECT * FROM pg_roles WHERE rolname='capiro_worker'")).rows, before);
    } finally { await db.close(); }
  });
}

for (const grant of ['GRANT capiro_worker TO holder', 'GRANT holder TO capiro_worker']) {
  test(`existing worker membership is rejected: ${grant}`, async () => {
    const db = new PGlite();
    try {
      await db.exec('CREATE ROLE capiro_worker NOLOGIN NOINHERIT; CREATE ROLE holder NOLOGIN NOINHERIT;');
      await db.exec(grant);
      await assert.rejects(db.exec(sql), /not the expected least-privilege CI fixture/);
    } finally { await db.close(); }
  });
}

function fakeFunding(identity) {
  const dir = mkdtempSync(path.join(tmpdir(), 'additional-bootstrap-'));
  const log = path.join(dir, 'commands.log');
  writeFileSync(path.join(dir,'psql'), `#!/usr/bin/env bash
printf 'PSQL HOSTADDR=%s SERVICE=%s SERVICEFILE=%s OPTIONS=%s ARGS=%s\\n' "\${PGHOSTADDR-}" "\${PGSERVICE+x}" "\${PGSERVICEFILE+x}" "\${PGOPTIONS+x}" "$*" >> "$BOOTSTRAP_TEST_LOG"
if [[ "$*" == *"current_database()"* ]]; then
 printf '%s\\n' "$BOOTSTRAP_TEST_IDENTITY"
elif [[ "$*" == *"disposable-capiro-worker-role.sql"* ]]; then
 printf 'ROLE_PREREQUISITE\\n' >> "$BOOTSTRAP_TEST_LOG"
elif [[ "$*" == *"SELECT 1 FROM pg_database"* ]]; then
 printf '1\\n'
elif [[ "$#" -eq 3 ]]; then
 cat >/dev/null
fi
`, {mode:0o755});
  writeFileSync(path.join(dir,'pnpm'), `#!/usr/bin/env bash
grep -q '^ROLE_PREREQUISITE$' "$BOOTSTRAP_TEST_LOG" || exit 87
[[ "$PGHOSTADDR" == '127.0.0.1' && -z "\${PGSERVICE+x}\${PGSERVICEFILE+x}\${PGOPTIONS+x}" ]] || exit 88
printf 'MIGRATE\\n' >> "$BOOTSTRAP_TEST_LOG"
`, {mode:0o755});
  const result = spawnSync('bash',[funding],{encoding:'utf8',env:{...process.env,
    PATH:`${dir}${path.delimiter}${process.env.PATH}`, BOOTSTRAP_TEST_LOG:log, BOOTSTRAP_TEST_IDENTITY:identity,
    CI_POSTGRES_ADMIN_DATABASE_URL:'postgresql://postgres:postgres@127.0.0.1:5486/postgres?schema=public',
    PGHOSTADDR:'203.0.113.8', PGSERVICE:'redirect', PGSERVICEFILE:'untrusted', PGOPTIONS:'-c search_path=untrusted'}});
  return {result,log:readFileSync(log,'utf8')};
}

test('Funding pins libpq, verifies identity and supplies the role before all three replays', () => {
  const {result,log} = fakeFunding('postgres|postgres|5432|on');
  assert.equal(result.status,0,result.stderr);
  assert.equal(log.match(/^MIGRATE$/gm)?.length,3);
  assert.equal(log.match(/^ROLE_PREREQUISITE$/gm)?.length,1);
  for (const line of log.split('\n').filter(l=>l.startsWith('PSQL ')))
    assert.match(line,/^PSQL HOSTADDR=127\.0\.0\.1 SERVICE= SERVICEFILE= OPTIONS= /);
  assert.ok(log.indexOf('current_database()')<log.indexOf('ROLE_PREREQUISITE'));
  assert.ok(log.indexOf('ROLE_PREREQUISITE')<log.indexOf('MIGRATE'));
  assert.doesNotMatch(log,/203\.0\.113\.8|untrusted/);
});

test('Funding refuses a wrong connected identity before any SQL mutation or migration', () => {
  const {result,log} = fakeFunding('capiro-dev|postgres|5432|on');
  assert.equal(result.status,2);
  assert.match(result.stderr,/unexpected PostgreSQL admin identity/);
  assert.equal(log.trim().split('\n').length,1);
  assert.doesNotMatch(log,/ROLE_PREREQUISITE|MIGRATE|CREATE ROLE|ALTER ROLE|CREATE DATABASE/);
});

test('Defense only bootstraps the worker for its self-managed fixture; shell syntax remains valid', () => {
  const source=readFileSync(defense,'utf8');
  assert.match(source,/if \[ "\$SELF_MANAGED" = "1" \]; then\n  run_sql "\$\(cat "\$REPO_ROOT\/scripts\/ci\/disposable-capiro-worker-role.sql"\)"\nelse\n/);
  assert.match(source,/external rehearsal requires an existing safe capiro_worker prerequisite/);
  assert.ok(source.indexOf('disposable-capiro-worker-role.sql')<source.indexOf('npx prisma migrate deploy'));
  for(const file of [funding,defense]) {
    const r=spawnSync('bash',['-n',file],{encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);
  }
});
