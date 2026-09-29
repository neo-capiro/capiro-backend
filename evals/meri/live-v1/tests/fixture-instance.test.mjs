import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFixtureManifest, assertManifest } from '../fixture-provisioning/manifest.mjs';
import {
  createClientDocumentOwnerPort,
  clientDocumentPhysicalId,
} from '../fixture-provisioning/canonical-owner-adapter.mjs';
import { sha256Stable } from '../lib/stable.mjs';

const FIRST = 'aaaaaaa1-1111-4111-8111-111111111111';
const SECOND = 'aaaaaaa2-1111-4111-8111-111111111111';
const config = {
  clients: Object.fromEntries(
    ['ASTER', 'BLUEHAVEN', 'CEDAR'].map((name, index) => [
      name,
      {
        tenantId: name === 'CEDAR' ? 'T2' : 'T1',
        physicalId: String(index + 1).repeat(8) + '-1111-4111-8111-111111111111',
        name,
      },
    ]),
  ),
  actors: { PAT: { tenantId: 'T1', userId: '44444444-4444-4444-8444-444444444444' } },
  availableOwners: ['memory_candidate', 'engagement_attachment'],
};
function rehash({ contentSha256: _old, ...body }) {
  return { ...body, contentSha256: sha256Stable(body) };
}

test('legacy manifests retain their exact pre-extension content address', async () => {
  const manifest = await buildFixtureManifest(config);
  assert.equal(
    manifest.contentSha256,
    '576d896c14953cfac9262b450a0b5c698aa850cd6acefb78e7c38aacdfb6eb8b',
  );
  assert.equal(Object.hasOwn(manifest, 'fixtureInstanceId'), false);
  assertManifest(manifest);
});

test('run instances preserve frozen logical fixtures but use disjoint owned identities', async () => {
  const legacy = await buildFixtureManifest(config);
  const first = await buildFixtureManifest({ ...config, fixtureInstanceId: FIRST });
  const second = await buildFixtureManifest({ ...config, fixtureInstanceId: SECOND });
  assertManifest(first);
  assertManifest(second);
  assert.deepEqual(first, await buildFixtureManifest({ ...config, fixtureInstanceId: FIRST }));
  const priorIds = new Set(
    [...legacy.records, ...first.records].map((record) => record.physicalId),
  );
  for (let index = 0; index < second.records.length; index++) {
    const record = second.records[index];
    assert.equal(priorIds.has(record.physicalId), false, record.logicalId);
    assert.equal(record.logicalId, legacy.records[index].logicalId);
    assert.deepEqual(record.payload, legacy.records[index].payload);
    assert.equal(record.payloadSha256, legacy.records[index].payloadSha256);
    assert.equal(record.tenantId, legacy.records[index].tenantId);
    assert.deepEqual(record.references, legacy.records[index].references);
    assert.notEqual(record.ownership.markerSha256, first.records[index].ownership.markerSha256);
  }
  assert.equal(first.fixtureVersion, legacy.fixtureVersion);
  assert.equal(first.fixtureSha256, legacy.fixtureSha256);
  assert.equal(first.contractSourceSha256, legacy.contractSourceSha256);
});

test('a rehashed instance label cannot transplant old physical rows or ownership proofs', async () => {
  const first = await buildFixtureManifest({ ...config, fixtureInstanceId: FIRST });
  const second = await buildFixtureManifest({ ...config, fixtureInstanceId: SECOND });
  assert.throws(() => assertManifest(rehash({ ...first, fixtureInstanceId: SECOND })), {
    code: 'RECORD_OWNERSHIP_MISMATCH',
  });
  const mixed = structuredClone(second);
  mixed.records[0] = first.records[0];
  assert.throws(() => assertManifest(rehash(mixed)), { code: 'RECORD_OWNERSHIP_MISMATCH' });
});

test('instance validation rejects ambiguous or injected run identifiers before owner calls', async () => {
  for (const fixtureInstanceId of [
    null,
    '',
    FIRST.toUpperCase(),
    'run:1',
    `${FIRST}\n`,
    1,
    'aaaaaaa1-1111-5111-8111-111111111111',
  ]) {
    await assert.rejects(buildFixtureManifest({ ...config, fixtureInstanceId }), {
      code: 'FIXTURE_INSTANCE_INVALID',
    });
  }
});

test('document owner forwards distinct idempotency identities while preserving artifact bytes', async () => {
  const calls = [];
  const port = createClientDocumentOwnerPort({
    documentWriter: {
      async createAttachmentFromBuffer(ctx, input) {
        calls.push({ ctx, input });
        const id = clientDocumentPhysicalId({
          ...ctx,
          clientId: input.clientId,
          contentType: input.contentType,
          idempotencyKey: input.idempotencyKey,
          bytes: input.buffer,
        });
        return { id, s3Key: `stub/${id}` };
      },
    },
    reader: async () => null,
    actorForTenant: () => config.actors.PAT.userId,
    assetRoot: new URL('../source-binaries/', import.meta.url),
  });
  for (const fixtureInstanceId of [FIRST, SECOND]) {
    const manifest = await buildFixtureManifest({ ...config, fixtureInstanceId });
    const record = manifest.records.find(
      (row) =>
        row.owner === 'engagement_attachment' && typeof row.payload.facts.utf8Bytes === 'string',
    );
    assert.ok(record, 'frozen generated artifact must exist');
    const result = await port.create(record, {
      tenantId: record.tenantId,
      physicalId: record.physicalId,
      expectedOwnershipMarkerSha256: record.ownership.markerSha256,
      expectedRowVersion: null,
    });
    assert.equal(result.id, record.physicalId);
  }
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].input.idempotencyKey, calls[1].input.idempotencyKey);
  assert.deepEqual(calls[0].input.buffer, calls[1].input.buffer);
  assert.equal(calls[0].ctx.tenantId, calls[1].ctx.tenantId);
});
