import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readLegacySourceInput } from '../../../../tests/support/legacy-web/inputs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const transport = resolve(here, 'hearing-recording-transport.ts');

test('Intel qualification preserves the sealed retired frontend transport bytes', () => {
  // This is a qualification-owned copy, not a new shared runtime authority.
  // The sealed source operand preserves parity after current-tip UI retirement.
  assert.deepEqual(readFileSync(transport), readLegacySourceInput('hearing-recording-transport.ts.txt'));
});

test('Intel browser qualification reads and fingerprints its owned transport', () => {
  const source = readFileSync(resolve(here, 'hearing-browser-run.ts'), 'utf8');
  assert.ok(
    source.includes(
      "readFileSync(resolve('test', 'qualification', 'hearing-recording-transport.ts'), 'utf8')",
    ),
  );
  assert.ok(source.includes("    'test/qualification/hearing-recording-transport.ts',"));
  assert.ok(!source.includes('../web/src/lib/hearing-recording-transport.ts'));
  assert.ok(!source.includes("resolve('..', 'web', 'src', 'lib', 'hearing-recording-transport.ts')"));
});
