import assert from 'node:assert/strict';
import { it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { buildFixtureManifest } from '../fixture-provisioning/manifest.mjs';
import { selectPendingMemoryFixturePlan as select } from '../fixture-provisioning/memory-pending-fixture-plan.mjs';

const input = () => ({
  fixtureInstanceId: randomUUID(),
  clients: {
    ASTER: { tenantId: 'T1', physicalId: randomUUID() },
    BLUEHAVEN: { tenantId: 'T1', physicalId: randomUUID() },
    CEDAR: { tenantId: 'T2', physicalId: randomUUID() },
  },
  actors: {
    PAT: { tenantId: 'T1', physicalId: randomUUID() },
    PRIYA: { tenantId: 'T1', physicalId: randomUUID() },
  },
});

it('selects the exact six frozen scopes for Priya and clones without claiming authority', async () => {
  const manifest = await buildFixtureManifest(input());
  const before = structuredClone(manifest),
    plan = select(manifest, '17');
  assert.equal(plan.proposerUserId, manifest.actors.PRIYA.physicalId);
  assert.equal(plan.reviewerUserId, null);
  assert.deepEqual(
    plan.records.map((row) => row.logicalId),
    [...'ABCDEF'].map((s) => `MEM-PENDING-17-${s}`),
  );
  assert.deepEqual(
    plan.records.map((row) => row.clientPhysicalId),
    [
      manifest.clients.ASTER.physicalId,
      manifest.clients.ASTER.physicalId,
      manifest.clients.ASTER.physicalId,
      manifest.clients.BLUEHAVEN.physicalId,
      null,
      null,
    ],
  );
  assert.equal(plan.records[5].payload.facts.scope, 'private');
  assert.equal(Object.hasOwn(plan, 'ready'), false);
  plan.records[0].payload.facts.changed = true;
  assert.deepEqual(manifest, before);
});
it('case14 has Pat proposer and a distinct Priya reviewer', async () => {
  const manifest = await buildFixtureManifest(input()),
    plan = select(manifest, '14');
  assert.equal(plan.proposerUserId, manifest.actors.PAT.physicalId);
  assert.equal(plan.reviewerUserId, manifest.actors.PRIYA.physicalId);
  assert.deepEqual(
    plan.records.map((row) => row.logicalId),
    ['MEM-PROPOSAL-14'],
  );
});
it('rejects unsupported cases, legacy instances, missing or identical actors, and tampered manifests', async () => {
  const options = input(),
    manifest = await buildFixtureManifest(options);
  for (const id of ['12', 17, null]) assert.throws(() => select(manifest, id));
  delete options.fixtureInstanceId;
  assert.throws(() => select(null, '17'));
  assert.throws(() => select({ ...manifest, contentSha256: '0'.repeat(64) }, '17'));
  const legacy = await buildFixtureManifest(options);
  assert.throws(() => select(legacy, '17'));
  for (const actors of [{}, { PAT: options.actors.PAT, PRIYA: options.actors.PAT }]) {
    const invalid = await buildFixtureManifest({
      ...options,
      fixtureInstanceId: randomUUID(),
      actors,
    });
    assert.throws(() => select(invalid, '17'));
  }
});
