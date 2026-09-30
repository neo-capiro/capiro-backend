import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildFixtureManifest } from '../fixture-provisioning/manifest.mjs';
import { AUTHORIZED_TENANTS, FIXTURE_NAMESPACE } from '../fixture-provisioning/contract.mjs';

const cli = fileURLToPath(new URL('../fixture-provisioning/cli.mjs', import.meta.url));
const config = {
  target: 'capiro-dev',
  fixtureNamespace: FIXTURE_NAMESPACE,
  tenants: AUTHORIZED_TENANTS,
  clients: Object.fromEntries(
    ['ASTER', 'BLUEHAVEN', 'CEDAR'].map((name, index) => [
      name,
      {
        tenantId: name === 'CEDAR' ? 'T2' : 'T1',
        physicalId: `${String(index + 1).repeat(8)}-1111-4111-8111-111111111111`,
      },
    ]),
  ),
  actors: { PAT: { tenantId: 'T1', userId: '44444444-4444-4444-8444-444444444444' } },
  availableOwners: ['memory_candidate'],
};

async function withCli(work) {
  const root = resolve(process.cwd());
  const directory = await mkdtemp(join(root, '.meri-fixture-cli-'));
  try {
    await work(async (command, input) => {
      const configPath = join(directory, 'config.json');
      const outputPath = join(directory, 'receipt.json');
      await writeFile(configPath, JSON.stringify(input));
      const processResult = spawnSync(
        process.execPath,
        [cli, command, '--config', configPath, '--out', outputPath],
        {
          encoding: 'utf8',
          timeout: 20_000,
        },
      );
      assert.ifError(processResult.error);
      return { ...processResult, outputPath };
    });
  } finally {
    assert.equal(dirname(resolve(directory)), root);
    assert.ok(basename(directory).startsWith('.meri-fixture-cli-'));
    await rm(directory, { recursive: true, force: true });
  }
}

test('source-map CLI preserves configured fixture instances and exact library identities', async () => {
  await withCli(async (run) => {
    const input = { ...config, fixtureInstanceId: 'aaaaaaa1-1111-4111-8111-111111111111' };
    const result = await run('source-map', input);
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(await readFile(result.outputPath, 'utf8'));
    assert.deepEqual(actual, await buildFixtureManifest(input));
    assert.equal(actual.fixtureInstanceId, input.fixtureInstanceId);
  });
});

test('CLI offline plan binds the configured instance and retains unverified authority', async () => {
  await withCli(async (run) => {
    const input = { ...config, fixtureInstanceId: 'aaaaaaa2-1111-4111-8111-111111111111' };
    const result = await run('plan', input);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(await readFile(result.outputPath, 'utf8'));
    assert.equal(receipt.manifestContentSha256, (await buildFixtureManifest(input)).contentSha256);
    assert.equal(receipt.authority, 'offline_unverified');
    assert.equal(receipt.dryRun, true);
  });
});

test('source-map CLI keeps legacy identities when no instance is configured', async () => {
  await withCli(async (run) => {
    const result = await run('source-map', config);
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(await readFile(result.outputPath, 'utf8'));
    assert.deepEqual(actual, await buildFixtureManifest(config));
    assert.equal(Object.hasOwn(actual, 'fixtureInstanceId'), false);
  });
});

test('CLI rejects an invalid configured instance instead of silently using legacy identities', async () => {
  await withCli(async (run) => {
    const result = await run('source-map', { ...config, fixtureInstanceId: 'invalid' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /FIXTURE_INSTANCE_INVALID/u);
    await assert.rejects(readFile(result.outputPath), { code: 'ENOENT' });
  });
});
