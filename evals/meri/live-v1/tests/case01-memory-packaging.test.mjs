import assert from 'node:assert/strict';
import { it } from 'node:test';
import { mkdtemp, readFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

it('imports and verifies frozen assets using only the exact API Dockerfile fixture COPY graph', async () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const isolated = await mkdtemp(join(tmpdir(), 'meri-case01-package-'));
  try {
    const dockerfile = await readFile(join(root, 'apps/api/Dockerfile'), 'utf8');
    const copyLines = dockerfile
      .split(/\r?\n/u)
      .filter((line) => line.startsWith('COPY --chown=capiro:capiro evals/meri/live-v1/'));
    assert.equal(copyLines.length, 4);
    const staged = [];
    for (const line of copyLines) {
      const parts = line.split(/\s+/u);
      const target = parts.at(-1);
      assert.ok(target.startsWith('/app/evals/meri/live-v1/'));
      for (const source of parts.slice(2, -1)) {
        assert.equal(source.includes('*'), false);
        assert.equal(/tests|providers|\.env|runner|capture-adapter/u.test(source), false);
        const destination = join(isolated, target.slice('/app/'.length), basename(source));
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(join(root, source), destination);
        staged.push(source);
      }
    }
    assert.equal(new Set(staged).size, staged.length);
    const owner = await import(
      pathToFileURL(
        join(isolated, 'evals/meri/live-v1/fixture-provisioning/case01-memory-owner.mjs'),
      ).href
    );
    assert.equal(typeof owner.createHydratedCase01MemoryOwner, 'function');
    const setup = await import(
      pathToFileURL(
        join(isolated, 'evals/meri/live-v1/fixture-provisioning/case01-execution-setup.mjs'),
      ).href
    );
    assert.equal(typeof setup.executeCase01ExecutionSetup, 'function');
    const controlled = await import(pathToFileURL(join(isolated,
      'evals/meri/live-v1/fixture-provisioning/controlled-read-owner.mjs')).href);
    assert.equal(typeof controlled.qualifyControlledReadInTx, 'function');
    assert.equal(typeof controlled.executeControlledReadSetup, 'function');
    const pending = await import(
      pathToFileURL(
        join(isolated, 'evals/meri/live-v1/fixture-provisioning/memory-pending-execution.mjs'),
      ).href
    );
    assert.equal(typeof pending.executePendingMemorySetup, 'function');
    const { buildFixtureManifest } = await import(
      pathToFileURL(join(isolated, 'evals/meri/live-v1/fixture-provisioning/manifest.mjs')).href
    );
    const manifest = await buildFixtureManifest({ fixtureInstanceId: randomUUID() });
    assert.match(manifest.contentSha256, /^[a-f0-9]{64}$/u);
    assert.ok(manifest.records.length > 75);
  } finally {
    assert.ok(resolve(isolated).startsWith(resolve(tmpdir())));
    await rm(isolated, { recursive: true, force: true });
  }
});
