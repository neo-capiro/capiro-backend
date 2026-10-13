import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  discoverMigrationDirectories,
  expectedPeBranchNames,
  KNOWN_PE_MIGRATION_NAMES,
  parseMigrationList,
  validateMigrationNames,
} from './pe-phase-9-migration-discovery.mjs';

const FIRST = '20260501000000_init_identity_tenancy';
const SECOND = '20260502000000_user_admin_brand_clients';
const LATER = '20281012060000_federal_register_effective_evidence';
const CLI = fileURLToPath(new URL('./pe-phase-9-migration-discovery.mjs', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pe-phase9-discovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const migrations = join(root, 'migrations');
  mkdirSync(migrations);
  return { root, migrations };
}

function migration(root, name) {
  mkdirSync(join(root, name));
  writeFileSync(join(root, name, 'migration.sql'), '-- inert filesystem fixture\n');
}

function runCli(...args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: {} });
}

test('README regression: 469 SQL directories plus README are 469 migrations, not 470', (t) => {
  const { migrations } = fixture(t);
  const names = Array.from(
    { length: 469 },
    (_, index) => `${String(20260000000000 + index)}_fixture`,
  );
  for (const name of names) migration(migrations, name);
  writeFileSync(join(migrations, 'README.md'), 'migration notes\n');
  // The old ls/lockfile filter counted the README as an additional migration.
  const oldNames = readdirSync(migrations).filter((name) => name !== 'migration_lock.toml');
  assert.equal(oldNames.length, 470);
  assert.equal(oldNames.filter((name) => !names.includes(name)).join('\n'), 'README.md');
  assert.deepEqual(discoverMigrationDirectories(migrations), names);
});

test('discovers sorted direct SQL directories while excluding files, metadata, empty and nested directories', (t) => {
  const { migrations } = fixture(t);
  migration(migrations, SECOND);
  migration(migrations, FIRST);
  writeFileSync(join(migrations, 'README.md'), 'notes');
  writeFileSync(join(migrations, 'migration_lock.toml'), 'provider = "postgresql"');
  writeFileSync(join(migrations, LATER), 'a file cannot be a migration directory');
  mkdirSync(join(migrations, 'empty'));
  mkdirSync(join(migrations, 'nested'));
  migration(join(migrations, 'nested'), LATER);
  mkdirSync(join(migrations, '20260503000000_sql_is_a_directory'));
  mkdirSync(join(migrations, '20260503000000_sql_is_a_directory', 'migration.sql'));
  assert.deepEqual(discoverMigrationDirectories(migrations), [FIRST, SECOND]);
});

test('symlink migration directories fail qualification without following outside the root', (t) => {
  const { root, migrations } = fixture(t);
  const outside = join(root, 'outside');
  mkdirSync(outside);
  migration(outside, LATER);
  symlinkSync(join(outside, LATER), join(migrations, LATER), 'junction');
  migration(migrations, FIRST);
  assert.throws(() => discoverMigrationDirectories(migrations), /Symlink entries are unsupported/);
  const result = runCli('list', migrations);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Symlink entries are unsupported/);
});

test('symlink SQL files fail qualification without accepting outside SQL', (t) => {
  const { root, migrations } = fixture(t);
  const outsideSql = join(root, 'outside.sql');
  writeFileSync(outsideSql, '-- inert outside fixture');
  mkdirSync(join(migrations, SECOND));
  symlinkSync(outsideSql, join(migrations, SECOND, 'migration.sql'));
  migration(migrations, FIRST);
  assert.throws(
    () => discoverMigrationDirectories(migrations),
    /Symlink migration.sql is unsupported/,
  );
});

test('dangling symlink entries and symlink roots fail qualification', (t) => {
  const { root, migrations } = fixture(t);
  symlinkSync(join(root, 'absent'), join(migrations, '20260503000000_dangling_link'));
  assert.throws(() => discoverMigrationDirectories(migrations), /Symlink entries are unsupported/);
  const rootLink = join(root, 'migrations-link');
  symlinkSync(migrations, rootLink, 'junction');
  assert.throws(() => discoverMigrationDirectories(rootLink), /real directory/);
});

test('missing and non-directory roots fail instead of returning an empty discovery', (t) => {
  const { root } = fixture(t);
  assert.throws(() => discoverMigrationDirectories(join(root, 'absent')), /ENOENT/);
  const file = join(root, 'file');
  writeFileSync(file, 'not a directory');
  assert.throws(() => discoverMigrationDirectories(file), /real directory/);
});

for (const name of [
  'README.md',
  '20260503000000_bad*glob',
  '20260503000000_bad\nname',
  `${FIRST}\n`,
  '20260503000000_bad\\path',
]) {
  test(`SQL-bearing invalid directory fails closed: ${JSON.stringify(name)}`, (t) => {
    const { migrations } = fixture(t);
    migration(migrations, name);
    assert.throws(() => discoverMigrationDirectories(migrations), /invalid migration name/);
    const result = runCli('list', migrations);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /invalid migration name/);
  });
}

test('valid lists sort without mutating input and accept LF, CRLF, or no final newline', () => {
  const input = [SECOND, FIRST];
  assert.deepEqual(validateMigrationNames(input), [FIRST, SECOND]);
  assert.deepEqual(input, [SECOND, FIRST]);
  for (const contents of [
    `${SECOND}\n${FIRST}`,
    `${SECOND}\n${FIRST}\n`,
    `${SECOND}\r\n${FIRST}\r\n`,
  ]) {
    assert.deepEqual(parseMigrationList(contents), [FIRST, SECOND]);
  }
  assert.deepEqual(parseMigrationList(''), []);
});

for (const name of [
  '',
  '.',
  '..',
  '../outside',
  '/absolute',
  'C:\\outside',
  '20260503000000_bad/name',
  '20260503000000_bad?glob',
  '20260503000000_bad[glob]',
  '20260503000000_bad\rname',
  '20260503000000_bad\nname',
  '20260503000000_bad\u0000name',
  '20260503000000_bad name',
  `${FIRST} `,
  `${FIRST}\n`,
  `${FIRST}\r`,
  `${FIRST}\u2028`,
  `${FIRST}\u2029`,
  null,
]) {
  test(`list name validator refuses unsafe input: ${JSON.stringify(name)}`, () => {
    assert.throws(() => validateMigrationNames([name]), /invalid migration name/);
  });
}

test('duplicate entries, blank lines, and malformed input types fail closed', () => {
  assert.throws(() => validateMigrationNames([FIRST, FIRST]), /duplicate migration name/);
  assert.throws(() => parseMigrationList(`${FIRST}\n${FIRST}\n`), /duplicate migration name/);
  for (const contents of [
    '\n',
    `${FIRST}\n\n`,
    `\n${FIRST}`,
    `${FIRST}\n\n${SECOND}`,
    `${FIRST}\r`,
  ]) {
    assert.throws(() => parseMigrationList(contents), /invalid migration name/);
  }
  assert.throws(() => validateMigrationNames(FIRST), /must be an array/);
  assert.throws(() => parseMigrationList([FIRST]), /must be text/);
});

test('strict PE check requires only PE migrations introduced relative to the real main list', () => {
  const [outbox, issue] = KNOWN_PE_MIGRATION_NAMES;
  assert.deepEqual(
    expectedPeBranchNames({
      tipNames: [FIRST, outbox, issue, LATER],
      mainNames: [FIRST, outbox, issue],
    }),
    [],
  );
  assert.deepEqual(
    expectedPeBranchNames({ tipNames: [FIRST, outbox, issue], mainNames: [FIRST] }),
    [outbox, issue],
  );
  assert.deepEqual(
    expectedPeBranchNames({ tipNames: [FIRST, outbox, issue], mainNames: [FIRST, outbox] }),
    [issue],
  );
  assert.deepEqual(expectedPeBranchNames({ tipNames: [FIRST], mainNames: [FIRST] }), []);
  assert.deepEqual(expectedPeBranchNames({ tipNames: [FIRST], mainNames: [FIRST, outbox] }), []);
});

test('custom PE names are validated and every input list rejects duplicates or unsafe names', () => {
  assert.deepEqual(
    expectedPeBranchNames({
      tipNames: [SECOND, FIRST],
      mainNames: [FIRST],
      knownPeNames: [SECOND],
    }),
    [SECOND],
  );
  for (const key of ['tipNames', 'mainNames', 'knownPeNames']) {
    for (const names of [[FIRST, FIRST], ['../outside']]) {
      assert.throws(
        () =>
          expectedPeBranchNames({
            tipNames: [FIRST],
            mainNames: [],
            knownPeNames: [FIRST],
            [key]: names,
          }),
        /duplicate|invalid/,
      );
    }
  }
});

test('CLI list emits only sorted names and exactly one newline per migration', (t) => {
  const { migrations } = fixture(t);
  migration(migrations, SECOND);
  migration(migrations, FIRST);
  writeFileSync(join(migrations, 'README.md'), 'notes');
  const result = runCli('list', migrations);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${FIRST}\n${SECOND}\n`);
});

test('CLI required-pe uses supplied real comparator lists and emits nothing when both PE migrations are on main', (t) => {
  const { root } = fixture(t);
  const tipFile = join(root, 'head.txt');
  const mainFile = join(root, 'main.txt');
  const [outbox, issue] = KNOWN_PE_MIGRATION_NAMES;
  writeFileSync(tipFile, `${FIRST}\n${outbox}\n${issue}\n${LATER}\n`);
  writeFileSync(mainFile, `${FIRST}\r\n${outbox}\r\n${issue}\r\n`);
  let result = runCli('required-pe', tipFile, mainFile);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  writeFileSync(mainFile, `${FIRST}\n${outbox}\n`);
  result = runCli('required-pe', tipFile, mainFile);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${issue}\n`);
});

test('CLI comparator refuses duplicate, invalid, or missing input files without partial output', (t) => {
  const { root } = fixture(t);
  const tipFile = join(root, 'head.txt');
  const mainFile = join(root, 'main.txt');
  writeFileSync(tipFile, `${FIRST}\n`);
  for (const invalid of [`${FIRST}\n${FIRST}\n`, '../outside\n', `${FIRST}\n\n`]) {
    writeFileSync(mainFile, invalid);
    const result = runCli('required-pe', tipFile, mainFile);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /duplicate|invalid/);
  }
  const result = runCli('required-pe', tipFile, join(root, 'absent'));
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /ENOENT/);
});

test('CLI empty directory returns an empty list; malformed command lines fail', (t) => {
  const { migrations } = fixture(t);
  const empty = runCli('list', migrations);
  assert.equal(empty.status, 0);
  assert.equal(empty.stdout, '');
  for (const args of [
    [],
    ['unknown'],
    ['list'],
    ['list', migrations, 'extra'],
    ['required-pe', 'head'],
  ]) {
    const result = runCli(...args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Usage:/);
  }
});
