'use strict';

// This verifier is used at image build and again immediately before any DB
// connection. The receipt migration must never see the API's full migration tree.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATION = '20281016020000_clio_conversation_bootstrap_receipts';
const EXPECTED = Object.freeze({
  'schema.prisma': [989415, 'b532f09179cdba78145816650512424188180b06a89c956150d9955c5009913b'],
  'migrations/migration_lock.toml': [126, '693566b52c49db47a2b0901d12400aa3d710d13a49f4a2a154b80c0505ed737c'],
  [`migrations/${MIGRATION}/migration.sql`]: [2422, '31a1dac55108a3f1300e4e6533e4f7f7be738438a89715179ee695f38928b211'],
});
const EXPECTED_DIRS = new Set(['', 'migrations', `migrations/${MIGRATION}`]);

function verifyBundle(root) {
  const observedFiles = new Set();
  const observedDirs = new Set();
  function walk(relative) {
    const absolute = path.join(root, ...relative.split('/').filter(Boolean));
    const stat = fs.lstatSync(absolute);
    assert.equal(stat.isSymbolicLink(), false, 'receipt bundle contains a symlink');
    if (stat.isDirectory()) {
      assert(EXPECTED_DIRS.has(relative), 'receipt bundle contains an unexpected directory');
      observedDirs.add(relative);
      for (const child of fs.readdirSync(absolute)) {
        assert(child !== '.' && child !== '..' && !child.includes('/'), 'invalid bundle entry');
        walk(relative ? `${relative}/${child}` : child);
      }
      return;
    }
    assert(stat.isFile(), 'receipt bundle contains a non-regular file');
    assert(Object.hasOwn(EXPECTED, relative), 'receipt bundle contains an unexpected file');
    const [bytes, sha256] = EXPECTED[relative];
    assert.equal(stat.size, bytes, 'receipt bundle byte length changed');
    const actual = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
    assert.equal(actual, sha256, 'receipt bundle hash changed');
    observedFiles.add(relative);
  }
  walk('');
  assert.deepEqual([...observedDirs].sort(), [...EXPECTED_DIRS].sort(), 'receipt bundle directory inventory changed');
  assert.deepEqual([...observedFiles].sort(), Object.keys(EXPECTED).sort(), 'receipt bundle file inventory changed');
  return { migration: MIGRATION, migrationSha256: EXPECTED[`migrations/${MIGRATION}/migration.sql`][1] };
}

if (require.main === module) {
  try {
    assert.equal(process.argv.length, 2, 'arguments are forbidden');
    verifyBundle('/receipt-only/prisma');
    process.stdout.write('RECEIPT_ONLY_BUNDLE_VERIFIED\n');
  } catch {
    process.stderr.write('BLOCK: receipt-only bundle verification failed\n');
    process.exitCode = 1;
  }
}

module.exports = { EXPECTED, MIGRATION, verifyBundle };
