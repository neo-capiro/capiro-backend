import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, renameSync, unlinkSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(new URL('./check-migration-integrity.mjs', import.meta.url));
const root = process.env.MIGRATION_INTEGRITY_TEST_ROOT || join(tmpdir(), 'migration-integrity-tests');
mkdirSync(root, { recursive: true });
const standard = 'apps/api/prisma/migrations/20260101000000_initial/migration.sql';
function fixture(sql = 'SELECT 1;\n', path = standard) {
  const cwd = mkdtempSync(join(root, 'case-'));
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Migration guard fixture');
  git('config', 'user.email', 'migration-guard@example.invalid');
  git('config', 'core.autocrlf', 'false');
  const write = (name, value) => { mkdirSync(dirname(join(cwd, name)), { recursive: true }); writeFileSync(join(cwd, name), value); };
  const commit = () => { git('add', '-A'); git('-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture'); };
  write(path, sql); commit();
  const base = git('rev-parse', 'HEAD');
  const run = (args = ['--base', base]) => spawnSync(process.execPath, [guard, ...args], { cwd, encoding: 'utf8' });
  return { cwd, git, write, commit, base, run, path };
}
function result(run, expected) {
  assert.equal(run.error, undefined);
  assert.equal(run.status, expected, run.stdout + run.stderr);
}

test('unchanged committed migration passes', () => result(fixture().run(), 0));
test('new migration is allowed', () => {
  const f = fixture(); f.write('new service/migrations/followup/migration.sql', 'SELECT 2;\n'); f.commit(); result(f.run(), 0);
});
for (const [name, original, changed] of [
  ['SQL modification', 'SELECT 1;\n', 'SELECT 2;\n'],
  ['trailing newline', 'SELECT 1;\n', 'SELECT 1;\n\n'],
  ['leading whitespace', 'SELECT 1;\n', ' SELECT 1;\n'],
  ['CRLF conversion', 'SELECT 1;\n', 'SELECT 1;\r\n'],
  ['empty SQL modification', '', 'SELECT 1;\n'],
]) test(name + ' fails exact-byte integrity', () => {
  const f = fixture(original); f.write(f.path, changed); f.commit(); result(f.run(), 1);
});
test('deleting migration SQL fails', () => {
  const f = fixture(); unlinkSync(join(f.cwd, f.path)); f.commit(); result(f.run(), 1);
});
test('renaming an existing migration fails', () => {
  const f = fixture(); renameSync(join(f.cwd, dirname(f.path)), join(f.cwd, dirname(f.path) + '_renamed')); f.commit(); result(f.run(), 1);
});
for (const path of ['service with spaces/migrations/initial setup/migration.sql', 'apps/new/prisma/migrations/init_without_timestamp/migration.sql']) {
  test('nonstandard migration path is checked: ' + path, () => {
    const f = fixture('SELECT 1;\n', path); f.write(path, 'SELECT 2;\n'); f.commit(); result(f.run(), 1);
  });
}
test('uncommitted edits are outside committed-history comparison', () => {
  const f = fixture(); f.write(f.path, 'SELECT 2;\n'); result(f.run(), 0);
});
test('migration mode changes fail', () => {
  const f = fixture(); f.git('update-index', '--chmod=+x', f.path); f.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'mode'); result(f.run(), 1);
});
test('missing base fails closed', () => result(fixture().run(['--base', 'missing-ref']), 2));
test('missing default origin/main fails closed', () => result(fixture().run([]), 2));
test('malformed arguments fail closed', () => {
  const f = fixture();
  for (const args of [['--base'], ['--base', '--all'], ['--unknown'], ['--base', f.base, 'extra']]) result(f.run(args), 2);
});
test('unrelated base fails closed', () => {
  const f = fixture(); f.git('checkout', '--orphan', 'unrelated'); f.git('rm', '-r', '--cached', '.');
  f.write('unrelated.txt', 'separate history\n'); f.git('add', 'unrelated.txt');
  f.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'unrelated'); result(f.run(), 2);
});
test('running outside a Git checkout fails closed', () => {
  const cwd = mkdtempSync(join(root, 'non-repo-'));
  result(spawnSync(process.execPath, [guard], { cwd, encoding: 'utf8' }), 2);
});


const repository = fileURLToPath(new URL('../', import.meta.url));
const incidentBase = '42942dedad59382f4b4aac6f904b9aee0e02efa6';
const incidentPaths = [
  'apps/api/prisma/migrations/20281002010000_research_portfolios_phase10_watch_delivery/migration.sql',
  'apps/api/prisma/migrations/20281003010000_dedup_client_intel_mapping/migration.sql',
];
function incidentBytes(path) {
  return {
    before: execFileSync('git', ['-C', repository, 'show', `${incidentBase}:${path}`]),
    after: readFileSync(join(repository, path)),
  };
}
for (const path of incidentPaths) {
  test('exact incident replacement is recognized: ' + path, () => {
    const sql = incidentBytes(path), f = fixture(sql.before, path);
    f.write(path, sql.after); f.commit();
    const actual = f.run(); result(actual, 0);
    assert.match(actual.stdout, /1 exact incident replacement/);
  });
  test('incident replacement with one extra newline fails: ' + path, () => {
    const sql = incidentBytes(path), f = fixture(sql.before, path);
    f.write(path, Buffer.concat([sql.after, Buffer.from('\n')])); f.commit(); result(f.run(), 1);
  });
  test('incident replacement cannot match a different original: ' + path, () => {
    const sql = incidentBytes(path), f = fixture(Buffer.concat([sql.before, Buffer.from('\n')]), path);
    f.write(path, sql.after); f.commit(); result(f.run(), 1);
  });
  test('future edits to the repaired migration fail: ' + path, () => {
    const sql = incidentBytes(path), f = fixture(sql.after, path);
    f.write(path, sql.before); f.commit(); result(f.run(), 1);
  });
}
test('incident SQL at another path has no exception', () => {
  const sql = incidentBytes(incidentPaths[0]), f = fixture(sql.before);
  f.write(f.path, sql.after); f.commit(); result(f.run(), 1);
});
test('recognized incident edit does not hide unrelated changes', () => {
  const path = incidentPaths[0], sql = incidentBytes(path), f = fixture(sql.before, path);
  f.write(standard, 'SELECT 1;\n'); f.commit();
  const base = f.git('rev-parse', 'HEAD');
  f.write(path, sql.after); f.write(standard, 'SELECT 2;\n'); f.commit();
  result(f.run(['--base', base]), 1);
});
test('recognized incident bytes do not permit a file-mode change', () => {
  const path = incidentPaths[0], sql = incidentBytes(path), f = fixture(sql.before, path);
  f.write(path, sql.after); f.commit(); f.git('update-index', '--chmod=+x', path);
  f.git('-c', 'commit.gpgsign=false', 'commit', '-m', 'mode'); result(f.run(), 1);
});
