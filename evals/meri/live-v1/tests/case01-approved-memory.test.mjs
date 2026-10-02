import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import { buildFixtureManifest } from '../fixture-provisioning/manifest.mjs';
import {
  createApprovedMemoryFixtureRuntime,
  selectedApprovedMemoryDefinitions,
} from '../fixture-provisioning/approved-memory-runtime.mjs';

const config = {
  clients: {
    ASTER: { tenantId: 'T1', physicalId: '11111111-1111-4111-8111-111111111111' },
    BLUEHAVEN: { tenantId: 'T1', physicalId: '22222222-2222-4222-8222-222222222222' },
    CEDAR: { tenantId: 'T2', physicalId: '33333333-3333-4333-8333-333333333333' },
  },
};

it('selects exact approved facts and client ownership without changing frozen availability', async () => {
  const manifest = await buildFixtureManifest({ ...config, fixtureInstanceId: randomUUID() });
  const before = JSON.stringify(manifest);
  const definitions = selectedApprovedMemoryDefinitions(manifest, ['MA1-v2', 'MB1']);
  assert.equal(definitions.length, 2);
  assert.equal(
    definitions[0].candidate.payload.facts.text,
    'Monthly briefs include fiscal year, budget stage, citations and action owner',
  );
  assert.equal(definitions[0].candidate.clientPhysicalId, config.clients.ASTER.physicalId);
  assert.equal(definitions[1].candidate.clientPhysicalId, config.clients.BLUEHAVEN.physicalId);
  assert.equal(definitions[0].supporting, false);
  assert.equal(definitions[0].candidate.logicalId, 'APPROVED-MA1-V2');
  assert.equal(definitions[0].candidate.payload.sourceLogicalId, 'MA1-v2');
  assert.notEqual(definitions[0].candidate.physicalId, definitions[0].proposedItemId);
  assert.deepEqual(selectedApprovedMemoryDefinitions(manifest, ['MA1-v2', 'MB1']), definitions);
  const next = await buildFixtureManifest({ ...config, fixtureInstanceId: randomUUID() });
  assert.notEqual(
    selectedApprovedMemoryDefinitions(next, ['MA1-v2'])[0].candidate.physicalId,
    definitions[0].candidate.physicalId,
  );
  assert.equal(JSON.stringify(manifest), before);
});

it('refuses activation of revoked, pending, superseded, unknown or non-memory sources', async () => {
  const manifest = await buildFixtureManifest(config);
  for (const source of ['MA3', 'MA2', 'MA1-v1', 'missing', 'R2-27']) {
    assert.throws(() => selectedApprovedMemoryDefinitions(manifest, [source]), {
      code: 'APPROVED_MEMORY_SOURCE_INVALID',
    });
  }
  for (const selection of [
    [],
    ['MA1-v2', 'MA1-v2'],
    'MA1-v2',
    [null],
    [''],
    Array.from({ length: 21 }, (_, i) => String(i)),
  ]) {
    assert.throws(() => selectedApprovedMemoryDefinitions(manifest, selection), {
      code: 'APPROVED_MEMORY_SOURCE_SELECTION_INVALID',
    });
  }
  assert.throws(
    () => selectedApprovedMemoryDefinitions({ ...manifest, contentSha256: 'forged' }, ['MA1-v2']),
    { code: 'MANIFEST_HASH_MISMATCH' },
  );
  assert.throws(
    () =>
      createApprovedMemoryFixtureRuntime({ manifest, sourceIds: ['MA1-v2'], distractorCount: 509 }),
    { code: 'APPROVED_MEMORY_SELECTION_OPTIONS_CONFLICT' },
  );
});
