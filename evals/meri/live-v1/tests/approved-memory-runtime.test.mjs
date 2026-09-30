import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import { buildFixtureManifest } from '../fixture-provisioning/manifest.mjs';
import {
  approvedMemoryDefinitions,
  createApprovedMemoryFixtureRuntime,
} from '../fixture-provisioning/approved-memory-runtime.mjs';

const config = {
  clients: {
    ASTER: { tenantId: 'T1', physicalId: '11111111-1111-4111-8111-111111111111' },
    BLUEHAVEN: { tenantId: 'T1', physicalId: '22222222-2222-4222-8222-222222222222' },
    CEDAR: { tenantId: 'T2', physicalId: '33333333-3333-4333-8333-333333333333' },
  },
};

it('binds MA510 to deterministic owned candidates without modifying the frozen manifest or making availability claims', async () => {
  const manifest = await buildFixtureManifest({ ...config, fixtureInstanceId: randomUUID() });
  const before = JSON.stringify(manifest);
  const first = approvedMemoryDefinitions(manifest);
  assert.equal(first.length, 510);
  assert.equal(first[0].logicalId, 'MA510');
  assert.equal(first[0].candidate.payload.facts.text, 'autonomous maritime demo');
  assert.ok(
    first
      .slice(1)
      .every(
        (entry) => entry.supporting && !entry.candidate.payload.facts.text.includes('maritime'),
      ),
  );
  assert.equal(new Set(first.map((entry) => entry.candidate.physicalId)).size, 510);
  assert.deepEqual(approvedMemoryDefinitions(manifest), first);
  assert.equal(JSON.stringify(manifest), before);
  const other = await buildFixtureManifest({ ...config, fixtureInstanceId: randomUUID() });
  assert.notEqual(
    approvedMemoryDefinitions(other)[0].candidate.physicalId,
    first[0].candidate.physicalId,
  );
});

it('rejects a forged source map and an unbounded or insufficient distractor inventory', async () => {
  const manifest = await buildFixtureManifest(config);
  assert.throws(() => approvedMemoryDefinitions({ ...manifest, contentSha256: 'forged' }), {
    code: 'MANIFEST_HASH_MISMATCH',
  });
  for (const distractorCount of [0, 499, 601, 500.1, '509', NaN])
    assert.throws(() => approvedMemoryDefinitions(manifest, { distractorCount }), {
      code: 'APPROVED_MEMORY_DISTRACTOR_COUNT_INVALID',
    });
  for (const distractorCount of [500, 509, 600])
    assert.equal(
      approvedMemoryDefinitions(manifest, { distractorCount }).length,
      distractorCount + 1,
    );
  assert.throws(() => createApprovedMemoryFixtureRuntime({ manifest }), {
    code: 'APPROVED_MEMORY_RUNTIME_INCOMPLETE',
  });
  assert.throws(
    () =>
      createApprovedMemoryFixtureRuntime({
        manifest,
        memoryCandidates: { approveSyntheticFixture() {} },
        proposerForTenant() {},
        reviewerForTenant() {},
      }),
    { code: 'APPROVED_MEMORY_RUNTIME_INCOMPLETE' },
  );
});
