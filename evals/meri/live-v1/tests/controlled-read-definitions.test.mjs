import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlledReadDefinition } from '../fixture-provisioning/controlled-read-definitions.mjs';
import { sha256Stable, sha256Bytes } from '../artifact-collector.mjs';
import { AUTHORIZED_TENANTS } from '../fixture-provisioning/contract.mjs';
const base = {
  tenantId: AUTHORIZED_TENANTS.T1.id,
  clientId: '33333333-3333-4333-8333-333333333333',
  captureRunId: '44444444-4444-4444-8444-444444444444',
};
for (const caseId of ['20', '72', '74'])
  test(`case ${caseId} immutable typed definitions and actual hashes`, () => {
    const d = createControlledReadDefinition({ ...base, caseId });
    assert.equal(d.physicalMapSha256, sha256Stable(d.sourceMap));
    assert.deepEqual(d, createControlledReadDefinition({ ...base, caseId }));
    for (const read of d.reads) {
      assert.equal(read.contentSha256, sha256Bytes(read.content));
      assert.throws(() => {
        read.content = 'changed';
      });
    }
    assert.throws(() => {
      d.sourceMap.changed = {};
    });
    const other = createControlledReadDefinition({
      ...base,
      caseId,
      captureRunId: '55555555-5555-4555-8555-555555555555',
    });
    assert.notEqual(d.physicalMapSha256, other.physicalMapSha256);
  });
test('20 exact synthetic typed passage; no global client identity fabricated', () => {
  const d = createControlledReadDefinition({ ...base, caseId: '20' });
  assert.equal(
    d.reads[0].content,
    'R2-27, page 14. PE 0912345T. FY27 President’s Budget request: $42M.',
  );
  assert.equal(d.sourceMap['R2-27'].clientPhysicalId, null);
});
test('72 error fixture is not a successful source passage', () => {
  const d = createControlledReadDefinition({ ...base, caseId: '72' });
  assert.equal(d.reads[0].content, '');
  assert.deepEqual(d.reads[0].facts.adapterResponse, {
    httpStatus: 200,
    body: { error: 'document unavailable' },
  });
});
test('74 four distinct reads only, no simulated worker kill or durable-run receipt', () => {
  const d = createControlledReadDefinition({ ...base, caseId: '74' });
  assert.equal(d.reads.length, 4);
  assert.equal(new Set(d.reads.map((x) => x.physicalId)).size, 4);
  assert.equal(new Set(d.reads.map((x) => x.contentSha256)).size, 4);
  assert.equal(d.reads[0].facts.completedBeforeWorkerKill, 2);
  assert.equal(d.workerKilled, undefined);
});
for (const patch of [
  { caseId: '01' },
  { caseId: '75' },
  { tenantId: AUTHORIZED_TENANTS.T2.id },
  { clientId: 'bad' },
  { captureRunId: 'bad' },
])
  test(`reject foreign/unsupported input ${JSON.stringify(patch)}`, () =>
    assert.throws(() => createControlledReadDefinition({ ...base, caseId: '20', ...patch })));
