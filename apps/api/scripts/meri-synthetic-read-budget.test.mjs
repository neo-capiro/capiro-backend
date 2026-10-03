import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readSyntheticReadOperatorInput } from './meri-synthetic-read-budget.mjs';

// Actual CLI argument/input parser. No database, owner or provider is invoked.
test('fixed budget env and file ingress work for install and canonical read', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meri-read-cli-'));
  const keys = [
    'MERI_SYNTHETIC_FIXTURE_NAMESPACE',
    'DATABASE_URL',
    'MERI_SYNTHETIC_READ_BUDGET_INPUT',
  ];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE = 'meri-foundation-20260928';
  process.env.DATABASE_URL = 'postgresql://unit.invalid/NO_CONNECTION';
  const base = {
    target: 'capiro-dev',
    fixtureNamespace: 'meri-foundation-20260928',
    ctx: { role: 'standard_user' },
  };
  try {
    for (const command of ['install', 'read-corpus']) {
      const input =
        command === 'install'
          ? {
              ...base,
              confirmation: 'INSTALL_ONE_OWNED_SYNTHETIC_READ_BUDGET',
              qualification: {},
              rateEvidence: {},
            }
          : {
              ...base,
              confirmation: 'READ_CURRENT_OWNED_MEMORY_CORPUS',
              clientId: '11111111-1111-4111-8111-111111111111',
            };
      const file = join(directory, command + '.json'),
        out = join(directory, command + '-receipt.json');
      await writeFile(file, JSON.stringify(input));
      process.env.MERI_SYNTHETIC_READ_BUDGET_INPUT = JSON.stringify(input);
      for (const [flag, locator] of [
        ['--input', file],
        ['--input-env', 'MERI_SYNTHETIC_READ_BUDGET_INPUT'],
      ]) {
        const parsed = await readSyntheticReadOperatorInput([command, flag, locator, '--out', out]);
        assert.deepEqual(parsed, { command, input, outPath: out });
      }
    }
    const read = {
      ...base,
      confirmation: 'READ_CURRENT_OWNED_MEMORY_CORPUS',
      clientId: '11111111-1111-4111-8111-111111111111',
    };
    const parse = (input, command = 'read-corpus', env = 'MERI_SYNTHETIC_READ_BUDGET_INPUT') => {
      process.env.MERI_SYNTHETIC_READ_BUDGET_INPUT = JSON.stringify(input);
      return readSyntheticReadOperatorInput([
        command,
        '--input-env',
        env,
        '--out',
        join(directory, 'refused.json'),
      ]);
    };
    await assert.rejects(parse(read, 'execute'), /arguments/);
    await assert.rejects(parse(read, 'read-corpus', 'ARBITRARY_INPUT'), /INPUT_INVALID/);
    await assert.rejects(
      parse({ ...read, confirmation: 'INSTALL_ONE_OWNED_SYNTHETIC_READ_BUDGET' }),
      /scope/,
    );
    await assert.rejects(parse({ ...read, ctx: { role: 'capiro_admin' } }), /scope/);
    await assert.rejects(parse({ ...read, clientId: 'invalid' }), /corpus_scope/);
    await assert.rejects(parse({ ...read, fixtureReady: true }), /corpus_scope/);
    await assert.rejects(parse({ ...read, credential: 'UNIT_NOT_SECRET' }), /INPUT_INVALID/);
    for (const [command, confirmation] of [
      ['preview-corpus-metadata', 'PREVIEW_EXACT_OWNED_MEMORY_METADATA'],
      ['execute-corpus-metadata', 'RECONCILE_EXACT_OWNED_MEMORY_METADATA'],
    ]) {
      const repair = { ...read, confirmation, ...(command.startsWith('execute') ? { expectedPlanSha256: 'a'.repeat(64) } : {}) };
      assert.deepEqual((await parse(repair, command)).input, repair);
      await assert.rejects(parse({ ...repair, ids: ['caller-selected'] }, command), /corpus_scope/);
      await assert.rejects(parse({ ...repair, fixtureReady: true }, command), /corpus_scope/);
      await assert.rejects(parse({ ...repair, confirmation: read.confirmation }, command), /scope/);
      await assert.rejects(parse({ ...repair, expectedPlanSha256: 'invalid' }, command), /corpus_scope/);
      if (command.startsWith('execute')) {
        const { expectedPlanSha256, ...missing } = repair;
        await assert.rejects(parse(missing, command), /corpus_scope/);
      }
    }
  } finally {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
    await rm(directory, { recursive: true, force: true });
  }
});
