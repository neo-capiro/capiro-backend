import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readMeriOperatorInput } from '../../../../apps/api/scripts/meri-operator-json-input.mjs';
const key = 'MERI_CASE01_SETUP_INPUT';
test('only fixed bounded nonsecret JSON environment ingress is accepted', async () => {
  const before = process.env[key];
  try {
    process.env[key] = JSON.stringify({ recipe: { target: 'capiro-dev' } });
    assert.equal(
      (await readMeriOperatorInput('--input-env', key, key)).recipe.target,
      'capiro-dev',
    );
    await assert.rejects(readMeriOperatorInput('--input-env', 'DATABASE_URL', key));
    await assert.rejects(readMeriOperatorInput('--input-env', key, 'UNREVIEWED_INPUT'));
    for (const value of [
      '[]',
      'invalid',
      JSON.stringify({ nested: { password: 'do-not-output' } }),
      JSON.stringify({ data: 'x'.repeat(6000) }),
    ]) {
      process.env[key] = value;
      await assert.rejects(readMeriOperatorInput('--input-env', key, key));
    }
  } finally {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
});
test('entrypoint exposes the fixed setup scripts with existing database composer', async () => {
  const shell = await readFile(
    new URL('../../../../apps/api/scripts/entrypoint.sh', import.meta.url),
    'utf8',
  );
  for (const verb of [
    'meri-case01-setup',
    'meri-capture-provider-budget',
    'meri-pending-memory-setup',
    'meri-synthetic-read-budget',
  ]) {
    const escaped = verb.replaceAll('-', '\\-');
    const matches = shell.match(
      new RegExp(
        `  ${escaped}\\)\\s+shift\\s+compose_database_url\\s+exec node scripts/${escaped}\\.mjs "\\$@"\\s+;;`,
        'g',
      ),
    );
    assert.equal(matches?.length, 1);
  }
});
