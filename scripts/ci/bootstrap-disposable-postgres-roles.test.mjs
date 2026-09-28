import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(scriptDir, 'bootstrap-disposable-postgres-roles.sh');
const prerequisiteSql = path.join(scriptDir, 'research-portfolio-append-only-prerequisite.sql');
const removedApplicationMigration = path.resolve(
  scriptDir,
  '../../apps/api/prisma/migrations/20281002000000_research_portfolio_append_only_prerequisite/migration.sql',
);
const migration = path.resolve(
  scriptDir,
  '../../apps/api/prisma/migrations/20281002010000_research_portfolios_phase10_watch_delivery/migration.sql',
);

function run(args = [], env = {}) {
  return spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function installEnvironmentRecordingPsql(prefix) {
  const fakeBin = mkdtempSync(path.join(tmpdir(), prefix));
  const invocations = path.join(fakeBin, 'psql-environment.log');
  const fakePsql = path.join(fakeBin, 'psql');
  writeFileSync(
    fakePsql,
    `#!/usr/bin/env bash
printf 'PGHOSTADDR=%s PGSERVICE_SET=%s PGSERVICEFILE_SET=%s PGOPTIONS_SET=%s ARGS=%s\\n' \
  "\${PGHOSTADDR-}" "\${PGSERVICE+x}" "\${PGSERVICEFILE+x}" "\${PGOPTIONS+x}" "$*" >> "${invocations}"
if [[ " $* " == *" --command "* ]]; then
  printf '%s\\n' 'capiro|postgres|5432|on'
else
  cat >/dev/null
fi
`,
    { mode: 0o755 },
  );
  return { fakeBin, invocations };
}

test('validation documents the fixed disposable target without contacting PostgreSQL', () => {
  const result = run(['--validate-only'], {
    GITHUB_ACTIONS: '',
    CI: '',
    CI_DISPOSABLE_POSTGRES: '',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /target=postgres@127\.0\.0\.1:5432\/capiro/);
  assert.match(result.stdout, /required role=capiro_worker NOLOGIN NOINHERIT NOBYPASSRLS/);
  assert.match(
    result.stdout,
    /append-only prerequisite=.*research-portfolio-append-only-prerequisite\.sql/,
  );
  assert.match(result.stdout, /no PostgreSQL command executed/);
});

test('database URLs and target overrides fail closed', () => {
  const result = run(['--database-url', 'postgresql://postgres@localhost/capiro']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /database URLs and target overrides are not accepted/);
});

test('mutating mode is unavailable outside an explicitly marked GitHub Actions fixture', () => {
  const result = run([], {
    GITHUB_ACTIONS: '',
    CI: 'true',
    CI_DISPOSABLE_POSTGRES: '1',
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /restricted to GitHub Actions/);
});

test('an unexpected connected database identity fails before role creation', () => {
  const fakeBin = mkdtempSync(path.join(tmpdir(), 'capiro-ci-role-wrong-target-'));
  const fakePsql = path.join(fakeBin, 'psql');
  writeFileSync(fakePsql, "#!/usr/bin/env bash\nprintf '%s\\n' 'capiro-dev|postgres|5432|on'\n", {
    mode: 0o755,
  });

  const result = run([], {
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    GITHUB_ACTIONS: 'true',
    CI: 'true',
    CI_DISPOSABLE_POSTGRES: '1',
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /refusing unexpected PostgreSQL target identity/);
  assert.doesNotMatch(result.stdout, /ready:/);
});

test('an inherited PGHOSTADDR cannot redirect any psql command', () => {
  const { fakeBin, invocations } = installEnvironmentRecordingPsql('capiro-ci-role-hostaddr-');
  const result = run([], {
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    GITHUB_ACTIONS: 'true',
    CI: 'true',
    CI_DISPOSABLE_POSTGRES: '1',
    PGHOSTADDR: '203.0.113.7',
  });

  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(invocations, 'utf8').trim().split('\n');
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.match(call, /^PGHOSTADDR=127\.0\.0\.1 /);
    assert.match(call, /ARGS=.*--host=127\.0\.0\.1/);
    assert.doesNotMatch(call, /203\.0\.113\.7/);
  }
});

test('inherited libpq service and option settings cannot influence any psql command', () => {
  const { fakeBin, invocations } = installEnvironmentRecordingPsql('capiro-ci-role-service-');
  const serviceFile = path.join(fakeBin, 'pg_service.conf');
  writeFileSync(serviceFile, '[redirect]\nhostaddr=203.0.113.8\nport=6543\n');
  const result = run([], {
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    GITHUB_ACTIONS: 'true',
    CI: 'true',
    CI_DISPOSABLE_POSTGRES: '1',
    PGSERVICE: 'redirect',
    PGSERVICEFILE: serviceFile,
    PGOPTIONS: '-c search_path=attacker',
  });

  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(invocations, 'utf8').trim().split('\n');
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.match(
      call,
      /^PGHOSTADDR=127\.0\.0\.1 PGSERVICE_SET= PGSERVICEFILE_SET= PGOPTIONS_SET= /,
    );
    assert.match(call, /ARGS=.*--host=127\.0\.0\.1.*--port=5432/);
    assert.doesNotMatch(call, /redirect|203\.0\.113\.8|6543|attacker/);
  }
});

test('the helper creates only the migration-required least-privilege role', () => {
  const fakeBin = mkdtempSync(path.join(tmpdir(), 'capiro-ci-role-bootstrap-'));
  const invocations = path.join(fakeBin, 'psql-invocations.log');
  const fakePsql = path.join(fakeBin, 'psql');
  writeFileSync(
    fakePsql,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${invocations}"\nif [[ " $* " == *" --command "* ]]; then\n  printf '%s\\n' 'capiro|postgres|5432|on'\nelse\n  input="$(cat)"\n  printf '%s\\n' "$input" >> "${invocations}"\nfi\n`,
    { mode: 0o755 },
  );

  const result = run([], {
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    GITHUB_ACTIONS: 'true',
    CI: 'true',
    CI_DISPOSABLE_POSTGRES: '1',
  });

  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(invocations, 'utf8');
  assert.match(calls, /--host=127\.0\.0\.1/);
  assert.match(calls, /--port=5432/);
  assert.match(calls, /--username=postgres/);
  assert.match(calls, /--dbname=capiro/);
  assert.match(
    calls,
    /CREATE ROLE capiro_worker\s+NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION/,
  );
  assert.match(calls, /IF NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'capiro_worker'\)/);
  assert.match(calls, /pg_auth_members/);
  assert.doesNotMatch(calls, /CREATE ROLE (?!capiro_worker)/);
  assert.doesNotMatch(calls, /\bSUPERUSER\b(?![\s\S]*NOSUPERUSER)/);
  assert.doesNotMatch(calls, /\bBYPASSRLS\b(?![\s\S]*NOBYPASSRLS)/);
  assert.match(
    calls,
    /--file=.*[\\/]scripts[\\/]ci[\\/]research-portfolio-append-only-prerequisite\.sql$/m,
  );
  assert.ok(calls.indexOf('DO $bootstrap$') < calls.indexOf('--file='));
});

test('the append-only prerequisite is a CI input, not an application migration', () => {
  assert.equal(existsSync(prerequisiteSql), true);
  assert.equal(existsSync(removedApplicationMigration), false);
});

test('the checked-in migration still requires the exact capiro_worker fixture role', () => {
  const sql = readFileSync(migration, 'utf8');
  assert.match(
    sql,
    /GRANT SELECT, INSERT ON "research_portfolio_subscription_deliveries" TO capiro_worker;/,
  );
  assert.doesNotMatch(sql, /CREATE ROLE capiro_worker/);

  const syntax = execFileSync('bash', ['-n', script], { encoding: 'utf8' });
  assert.equal(syntax, '');
});
