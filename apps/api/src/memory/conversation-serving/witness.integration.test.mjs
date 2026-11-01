import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readMemoryRetentionWitness } from './witness.ts';

const nativeSource = process.env.MEMORY_RETENTION_NATIVE_SOURCE;
test(
  'Core consumes the native private witness and refuses restored-away suppression until native recovery',
  { skip: !nativeSource },
  async () => {
    // Cross-repository source imports are confined to this integration test.
    const native = (file) => import(pathToFileURL(join(nativeSource, file)).href);
    const { createRetentionWitnessApplication } = await native(
      'apps/control/retention/serving-witness.mjs',
    );
    const { composeStartup, subjectOf } = await native('apps/control/retention/test/fixture.mjs');
    const f = composeStartup(),
      secret = 'synthetic-retention-service-secret';
    const app = createRetentionWitnessApplication({
      startup: f.startup,
      getServiceSecret: async () => secret,
    });
    const configuration = {
      origin: 'https://control.example.invalid',
      secret,
      fetchImpl: (input, init) => app.handle(new Request(input, init)),
    };
    assert.equal(await readMemoryRetentionWitness(configuration), null);
    await f.startup.start();
    const saved = f.backup();
    assert.deepEqual(await readMemoryRetentionWitness(configuration), {
      sequence: 0,
      entrySha256: null,
    });
    await f.startup.suppression.suppress({
      principal: f.principal,
      subject: subjectOf(),
      reason: 'Synthetic retention test',
    });
    assert.deepEqual(
      await readMemoryRetentionWitness(configuration),
      await f.startup.ledger.head(),
    );
    f.restore(saved);
    assert.equal(await readMemoryRetentionWitness(configuration), null);
    assert.equal((await f.watermark.read()).sequence, 0);
    await f.startup.ensureServing();
    assert.deepEqual(
      await readMemoryRetentionWitness(configuration),
      await f.startup.ledger.head(),
    );
    assert.equal(
      await readMemoryRetentionWitness({
        ...configuration,
        secret: 'different-synthetic-service-secret',
      }),
      null,
    );
  },
);
