import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFixtureManifest,
  assertManifest,
  fixturePhysicalMapSha256,
} from '../fixture-provisioning/manifest.mjs';
import {
  receiptWithHash,
  fixtureReceiptId,
  assertFixtureReceiptId,
  ownedIdentity,
} from '../fixture-provisioning/contract.mjs';
import { sha256Stable } from '../lib/stable.mjs';

const clients = Object.fromEntries(
  ['ASTER', 'BLUEHAVEN', 'CEDAR'].map((name, index) => [
    name,
    {
      tenantId: name === 'CEDAR' ? 'T2' : 'T1',
      physicalId: `${index + 1}`.repeat(8) + '-1111-4111-8111-111111111111',
      name,
    },
  ]),
);
const rehash = ({ contentSha256: _old, ...body }) => ({
  ...body,
  contentSha256: sha256Stable(body),
});
const create = () => buildFixtureManifest({ clients, availableOwners: ['memory_candidate'] });

test('full physical-map address is the validated manifest, not a caller projection', async () => {
  const manifest = await create();
  assert.equal(fixturePhysicalMapSha256(manifest), manifest.contentSha256);
  assert.notEqual(fixturePhysicalMapSha256(manifest), sha256Stable(manifest.records));
});

test('rehashing empty, omitted, duplicate or foreign source inventories cannot admit them', async () => {
  const manifest = await create();
  const variants = [
    [],
    manifest.records.slice(1),
    [...manifest.records, manifest.records[0]],
    manifest.records.map((row, index) => (index ? row : { ...row, logicalId: 'invented-source' })),
  ];
  for (const records of variants)
    assert.throws(() => assertManifest(rehash({ ...manifest, records })), {
      code: 'MANIFEST_INVENTORY_MISMATCH',
    });
});

test('a self-consistently rehashed owner or frozen payload substitution is rejected', async () => {
  const manifest = await create();
  for (const mutation of ['owner', 'facts', 'asset', 'client']) {
    const changed = structuredClone(manifest);
    const record = changed.records.find(
      (row) => row.logicalId === (mutation === 'asset' ? 'D-A-1' : 'MA1-v2'),
    );
    if (mutation === 'owner') {
      record.owner = 'invented_owner';
      record.ownership = ownedIdentity(
        record.logicalId,
        record.tenantId,
        record.owner,
        manifest.fixtureVersion,
      );
      record.physicalId = record.ownership.physicalId;
    }
    if (mutation === 'facts') record.payload.facts.text = 'invented approved content';
    if (mutation === 'asset') record.payload.sourceAsset.byteSha256 = 'a'.repeat(64);
    if (mutation === 'client') {
      record.clientLogicalId = 'BLUEHAVEN';
      record.clientPhysicalId = clients.BLUEHAVEN.physicalId;
      record.references[0].logicalId = 'BLUEHAVEN';
      record.references[0].physicalId = clients.BLUEHAVEN.physicalId;
    }
    record.payloadSha256 = sha256Stable(record.payload);
    assert.throws(
      () => assertManifest(rehash(changed)),
      { code: 'RECORD_FROZEN_DEFINITION_MISMATCH' },
      mutation,
    );
  }
});

test('manifest contract version is checked independently of its recomputed hash', async () => {
  const manifest = await create();
  for (const changed of [
    { ...manifest, schemaVersion: 2 },
    { ...manifest, contractVersion: 'unknown' },
  ]) {
    assert.throws(() => assertManifest(rehash(changed)), { code: 'MANIFEST_VERSION_MISMATCH' });
  }
});

test('seed, reset and verify IDs bind exact kind and stable versioned content', () => {
  for (const kind of ['seed', 'reset', 'verify'].map(
    (name) => `meri-synthetic-fixture-${name}-receipt`,
  )) {
    const receipt = receiptWithHash({ kind, status: 'complete', records: [] });
    const id = fixtureReceiptId(receipt, kind);
    assert.equal(id, `${kind}:sha256:${receipt.contentSha256}`);
    assert.equal(assertFixtureReceiptId(id, receipt, kind), receipt);
    assert.throws(() => assertFixtureReceiptId(receipt.contentSha256, receipt, kind), {
      code: 'RECEIPT_ID_MISMATCH',
    });
    assert.throws(
      () =>
        assertFixtureReceiptId(id, receiptWithHash({ kind, status: 'failed', records: [] }), kind),
      { code: 'RECEIPT_ID_MISMATCH' },
    );
    assert.throws(() => fixtureReceiptId(rehash({ ...receipt, schemaVersion: 2 }), kind), {
      code: 'RECEIPT_VERSION_MISMATCH',
    });
    assert.throws(() => fixtureReceiptId({ ...receipt, records: ['tampered'] }, kind), {
      code: 'RECEIPT_HASH_MISMATCH',
    });
    assert.throws(() => fixtureReceiptId(receipt, 'meri-synthetic-fixture-plan'), {
      code: 'RECEIPT_KIND_MISMATCH',
    });
  }
});

test('content identity does not assert lifecycle completion or canonical authority', () => {
  const kind = 'meri-synthetic-fixture-seed-receipt';
  const incomplete = receiptWithHash({
    kind,
    status: 'unknown_outcome',
    fixtureComplete: false,
    unavailable: ['owner'],
  });
  assert.match(
    fixtureReceiptId(incomplete, kind),
    /^meri-synthetic-fixture-seed-receipt:sha256:[a-f0-9]{64}$/,
  );
  assert.equal(incomplete.fixtureComplete, false);
  assert.equal(incomplete.status, 'unknown_outcome');
  assert.throws(() => fixtureReceiptId(incomplete, 'unrecognized'), {
    code: 'RECEIPT_KIND_UNSUPPORTED',
  });
});
