import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { includePrePhase2PrismaPath } from './phase2-migration-baseline.mjs';

const boundary = '20260908010000_outreach_v3_campaign_state';
const prior = '20260908000000_prior';
const future = '20261001012000_outreach_v3_reasoning_conversations';

test('keeps a strict migration prefix with either platform separator', () => {
  for (const separator of ['/', '\\']) {
    for (const name of [prior, boundary, future]) {
      assert.equal(
        includePrePhase2PrismaPath(['migrations', name, 'migration.sql'].join(separator), boundary),
        name === prior,
      );
    }
    assert.equal(
      includePrePhase2PrismaPath(['migrations', 'migration_lock.toml'].join(separator), boundary),
      true,
    );
  }
  assert.equal(includePrePhase2PrismaPath('schema.prisma', boundary), true);
  assert.equal(includePrePhase2PrismaPath('', boundary), true);
  assert.throws(() => includePrePhase2PrismaPath('', '../wrong'), /Invalid/);
});

test('actual copy keeps original prior bytes and source intact while excluding all dependent descendants', () => {
  const base = process.platform === 'win32' ? 'C:\\dev' : tmpdir();
  const owned = mkdtempSync(join(base, 'cap-phase2-baseline-test-'));
  try {
    const source = join(owned, 'source');
    for (const name of [prior, boundary, future]) {
      mkdirSync(join(source, 'migrations', name), { recursive: true });
      writeFileSync(join(source, 'migrations', name, 'migration.sql'), `-- ${name}\n`);
    }
    writeFileSync(join(source, 'migrations', 'migration_lock.toml'), 'provider = "postgresql"\n');
    writeFileSync(join(source, 'schema.prisma'), '// unchanged schema\n');
    const target = join(owned, 'baseline');
    cpSync(source, target, {
      recursive: true,
      filter: (path) => includePrePhase2PrismaPath(relative(source, path), boundary),
    });
    assert.deepEqual(
      readdirSync(join(target, 'migrations')).sort(),
      [prior, 'migration_lock.toml'].sort(),
    );
    for (const path of [
      'schema.prisma',
      `migrations/${prior}/migration.sql`,
      'migrations/migration_lock.toml',
    ])
      assert.deepEqual(readFileSync(join(target, path)), readFileSync(join(source, path)));
    assert.equal(existsSync(join(source, 'migrations', boundary, 'migration.sql')), true);
    assert.equal(existsSync(join(source, 'migrations', future, 'migration.sql')), true);
  } finally {
    // Only this invocation's freshly created directory can be removed.
    assert.equal(dirname(resolve(owned)), resolve(base));
    assert.ok(owned.startsWith(join(base, 'cap-phase2-baseline-test-')));
    rmSync(owned, { recursive: true });
  }
});

test('real repository migrations retain every predecessor and reject the observed failing descendant', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const names = readdirSync(join(root, 'apps/api/prisma/migrations'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.ok(names.includes(boundary));
  assert.ok(names.includes(future));
  const selected = names.filter((name) =>
    includePrePhase2PrismaPath(`migrations/${name}`, boundary),
  );
  assert.deepEqual(selected, names.slice(0, names.indexOf(boundary)));
  assert.ok(selected.length > 0);
});
