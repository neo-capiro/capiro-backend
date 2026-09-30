import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  AUTHORIZED_TENANTS,
  FIXTURE_NAMESPACE,
  APPLY_CONFIRMATION,
} from '../fixture-provisioning/contract.mjs';

const cli = fileURLToPath(new URL('../fixture-provisioning/cli.mjs', import.meta.url));
for (const unknownCommit of [false, true]) {
  test(`CLI closes a failing runtime and exits nonzero (unknownCommit=${unknownCommit})`, async () => {
    const root = resolve(process.cwd());
    const dir = await mkdtemp(join(root, '.meri-fixture-cli-'));
    try {
      const config = join(dir, 'config.json');
      const adapter = join(dir, 'adapter.mjs');
      const closed = join(dir, 'closed.txt');
      const plan = join(dir, 'plan.json');
      const receipt = join(dir, 'receipt.json');
      await writeFile(
        config,
        JSON.stringify({
          target: 'capiro-dev',
          fixtureNamespace: FIXTURE_NAMESPACE,
          tenants: AUTHORIZED_TENANTS,
          clients: {
            ASTER: { tenantId: 'T1', physicalId: '11111111-1111-4111-8111-111111111111' },
            BLUEHAVEN: { tenantId: 'T1', physicalId: '22222222-2222-4222-8222-222222222222' },
            CEDAR: { tenantId: 'T2', physicalId: '33333333-3333-4333-8333-333333333333' },
          },
          availableOwners: ['memory_candidate'],
        }),
      );
      await writeFile(
        adapter,
        `import { writeFile } from 'node:fs/promises';
export function createAdapter() {
  const failure = async () => { const e = new Error('controlled failure'); e.unknownCommit = ${unknownCommit}; throw e; };
  return { authority: 'canonical_readback', inspect: async () => null, createOwned: failure,
    replaceOwned: failure, deleteOwned: failure,
    close: async () => writeFile(${JSON.stringify(closed)}, 'closed') };
}`,
      );
      const invoke = (args) =>
        spawnSync(process.execPath, [cli, ...args, '--config', config, '--adapter', adapter], {
          encoding: 'utf8',
          timeout: 20_000,
        });
      const planned = invoke(['plan', '--out', plan]);
      assert.equal(planned.status, 0, planned.stderr);
      assert.equal(await readFile(closed, 'utf8'), 'closed');
      await writeFile(closed, 'not-closed');
      const applied = invoke([
        'apply',
        '--plan',
        plan,
        '--confirm',
        APPLY_CONFIRMATION,
        '--out',
        receipt,
      ]);
      assert.equal(applied.status, 1, applied.stderr);
      assert.equal(await readFile(closed, 'utf8'), 'closed');
      const actual = JSON.parse(await readFile(receipt, 'utf8'));
      assert.equal(actual.status, unknownCommit ? 'unknown_outcome' : 'failed');
      assert.equal(actual.fixtureComplete, false);
    } finally {
      assert.equal(dirname(resolve(dir)), root);
      await rm(dir, { recursive: true, force: true });
    }
  });
}
