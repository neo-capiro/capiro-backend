import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readLegacySourceInput, assertLegacySourceBytes, LEGACY_SOURCE_COMMIT } from './inputs.mjs';
import { requireLegacyWebWorkspace } from './workspace.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const seal = JSON.parse(readFileSync(new URL('./SOURCE-INPUTS.json', import.meta.url), 'utf8'));
assert.equal(seal.sourceCommit, LEGACY_SOURCE_COMMIT);
assert.equal(seal.files.filter(row => row.action === 'move').length, 13);
assert.equal(seal.files.filter(row => row.action === 'copy-as-historical-source-data').length, 3);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

for (const row of seal.files) {
  if (row.action === 'move') {
    test(`harness relocation preserves original bytes after exact path inverse: ${row.source}`, () => {
      const current = readFileSync(path.join(root, row.destination), 'utf8');
      const original = Buffer.from(current.replaceAll('tests/support/legacy-web/', 'apps/web/scripts/'));
      assert.equal(original.length, row.bytes);
      assert.equal(sha(original), row.sha256);
      assert.equal(createHash('sha1').update(`blob ${original.length}\0`).update(original).digest('hex'), row.gitBlob);
    });
  } else {
    const name = path.basename(row.destination);
    test(`historical operand retains source bytes and blob: ${row.source}`, () => {
      assert.equal(sha(readLegacySourceInput(name)), row.sha256);
    });
    test(`one-byte historical operand drift is refused: ${row.source}`, () => {
      const changed = Buffer.from(readLegacySourceInput(name));
      changed[0] ^= 1;
      assert.throws(() => assertLegacySourceBytes(row, changed), /identity drift/);
    });
  }
}
test('an undeclared historical operand is refused before reading it', () => {
  assert.throws(() => readLegacySourceInput('../inputs.mjs'), /Undeclared/);
});
test('a retired local browser runner refuses a missing Web tree', () => {
  assert.throws(() => requireLegacyWebWorkspace('/absent', () => false), /retired/);
});
test('the local browser preflight preserves an explicit full-source workspace', () => {
  assert.equal(requireLegacyWebWorkspace('/fixture', () => true), undefined);
});
