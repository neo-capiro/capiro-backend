import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';

const cli = fileURLToPath(new URL('./meri-case46-setup.mjs', import.meta.url));
for (const [name, args, input] of [
  ['unknown mode', ['approve'], '{}'],
  ['extra argument', ['execute', 'retry'], '{}'],
  ['oversized envelope', ['plan'], ' '.repeat(6001)],
  ['malformed envelope', ['plan'], '{not-json'],
  ['extra envelope authority', ['plan'], JSON.stringify({ recipe: {}, approved: true })],
]) {
  it(`fixed image CLI refuses ${name} before loading any database dependency`, () => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8', timeout: 10_000,
      env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, MERI_CASE46_SETUP_INPUT: input },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.trim(), 'MERI_CASE46_SETUP_RECEIPT ' + JSON.stringify({
      kind: 'meri-case46-setup-failure', version: 1, status: 'RECONCILIATION_REQUIRED',
      code: 'CASE46_SETUP_REFUSED', liveAcceptance: 'NOT_RUN',
    }));
  });
}
it('fixed entrypoint composes the database URL then executes the packaged operator', async () => {
  const source = await readFile(new URL('./entrypoint.sh', import.meta.url), 'utf8');
  assert.match(source, /meri-case46-setup\)\s+shift\s+compose_database_url\s+exec node scripts\/meri-case46-setup\.mjs "\$@"\s+;;/u);
});
