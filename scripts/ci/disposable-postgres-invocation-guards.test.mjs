import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const funding = path.join(scriptDir, 'bootstrap-funding-opportunities-test-dbs.sh');
const phase8 = path.resolve(scriptDir, '../verify-phase8-session2-db.sh');
const adminUrl = 'postgresql://postgres:postgres@127.0.0.1:5486/postgres?schema=public';

function fixture({ safeWorker = false } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'capiro-disposable-invocation-'));
  const log = path.join(directory, 'commands.log');
  for (const [name, code] of [
    ['psql', 0],
    ['npx', 73],
    ['docker', 97],
    ['pnpm', 97],
  ]) {
    // safeWorker: the external database already holds the restricted worker,
    // so the read-only capiro_worker verification query answers true.
    const answer =
      name === 'psql' && safeWorker
        ? `[[ "$*" == *"rolname='capiro_worker'"* ]] && printf 't\\n'\n`
        : '';
    writeFileSync(
      path.join(directory, name),
      `#!/usr/bin/env bash\nprintf '%s\\n' '${name}' "$*" >> "${log}"\n${answer}exit ${code}\n`,
      { mode: 0o755 },
    );
  }
  return {
    env: {
      ...process.env,
      PATH: `${directory}${path.delimiter}${process.env.PATH}`,
      GITHUB_ACTIONS: '',
      CI: '',
      CI_DISPOSABLE_POSTGRES: '',
      CI_POSTGRES_ADMIN_DATABASE_URL: '',
      REHEARSAL_DATABASE_URL: '',
    },
    commands: () => (existsSync(log) ? readFileSync(log, 'utf8') : ''),
  };
}

for (const [name, url, overrides, message] of [
  ['wrong host', adminUrl.replace('127.0.0.1', '203.0.113.9'), {}, 'admin host must be'],
  ['wrong port', adminUrl.replace(':5486/', ':55433/'), {}, 'admin port must be'],
  ['unowned database', adminUrl.replace('/postgres?', '/unowned?'), {}, 'admin database'],
  ['missing GitHub Actions', adminUrl, {}, 'restricted to GitHub Actions'],
  ['missing CI', adminUrl, { GITHUB_ACTIONS: 'true' }, 'CI=true is required'],
  ['missing marker', adminUrl, { GITHUB_ACTIONS: 'true', CI: 'true' }, 'CI_DISPOSABLE_POSTGRES=1'],
]) {
  test(`Funding rejects ${name} before any database command`, () => {
    const local = fixture();
    const result = spawnSync('bash', [funding, '--admin-url', url], {
      encoding: 'utf8',
      env: { ...local.env, ...overrides },
      timeout: 15000,
    });
    assert.equal(result.status, 2, result.stderr);
    assert.ok(result.stderr.includes(message), result.stderr);
    assert.equal(local.commands(), '');
  });
}

test('Funding validation-only keeps the fixed databases and executes no database command', () => {
  const local = fixture();
  const result = spawnSync('bash', [funding, '--admin-url', adminUrl, '--validate-only'], {
    encoding: 'utf8',
    env: local.env,
    timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /targets=fo_v2_test fo_v2_search fo_v2_saved/);
  assert.match(result.stdout, /no PostgreSQL command executed/);
  assert.equal(local.commands(), '');
});

test('Phase8 external URL path makes no new container prerequisite calls', () => {
  const local = fixture({ safeWorker: true });
  const result = spawnSync('bash', [phase8], {
    encoding: 'utf8',
    env: {
      ...local.env,
      REHEARSAL_DATABASE_URL: 'postgresql://fake:fake@unowned.invalid:5432/unowned',
    },
    timeout: 15000,
  });
  // Fake psql intercepts the existing extension initialization. Fake npx stops
  // at migration dispatch, so neither a real database nor network is contacted.
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /migration-from-zero failed/);
  const commands = local.commands();
  assert.match(commands, /^psql$/m);
  assert.match(commands, /^npx$/m);
  assert.doesNotMatch(commands, /^docker$/m);
  assert.doesNotMatch(
    commands,
    /disposable-capiro-worker-prerequisite|research-portfolio-append-only-prerequisite/,
  );
});

test('Phase8 external URL without a safe restricted worker stops before migration', () => {
  const local = fixture();
  const result = spawnSync('bash', [phase8], {
    encoding: 'utf8',
    env: {
      ...local.env,
      REHEARSAL_DATABASE_URL: 'postgresql://fake:fake@unowned.invalid:5432/unowned',
    },
    timeout: 15000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /external rehearsal requires an existing safe capiro_worker prerequisite/);
  const commands = local.commands();
  assert.doesNotMatch(commands, /^npx$/m);
  assert.doesNotMatch(commands, /^docker$/m);
  assert.doesNotMatch(
    commands,
    /disposable-capiro-worker-prerequisite|research-portfolio-append-only-prerequisite/,
  );
});
