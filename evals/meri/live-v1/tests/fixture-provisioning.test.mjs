import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { frozenFixture } from '../fixture.mjs';
import { clientDocumentPhysicalId } from '../fixture-provisioning/canonical-owner-adapter.mjs';
import {
  APPLY_CONFIRMATION,
  AUTHORIZED_TENANTS,
  RESET_CONFIRMATION,
} from '../fixture-provisioning/contract.mjs';
import { assertManifest, buildFixtureManifest } from '../fixture-provisioning/manifest.mjs';
import {
  applyFixture,
  applyOwnedReset,
  planFixture,
  planOwnedReset,
  verifyFixture,
} from '../fixture-provisioning/provisioner.mjs';
import { sha256Stable } from '../lib/stable.mjs';

const CLIENTS = Object.freeze({
  ASTER: {
    tenantId: 'T1',
    physicalId: '11111111-1111-4111-8111-111111111111',
    name: 'Aster Defense',
  },
  BLUEHAVEN: {
    tenantId: 'T1',
    physicalId: '22222222-2222-4222-8222-222222222222',
    name: 'Bluehaven Robotics',
  },
  CEDAR: {
    tenantId: 'T2',
    physicalId: '33333333-3333-4333-8333-333333333333',
    name: 'Cedar Aviation',
  },
});
const ACTORS = Object.freeze({
  PAT: {
    tenantId: 'T1',
    userId: '44444444-4444-4444-8444-444444444444',
  },
});

class TestCanonicalOwnerAdapter {
  constructor({ failLogicalId = null, unknownCommit = false } = {}) {
    this.rows = new Map();
    this.failLogicalId = failLogicalId;
    this.unknownCommit = unknownCommit;
    this.createCalls = 0;
    this.deleteCalls = 0;
  }

  async inspect(record) {
    return structuredClone(this.rows.get(record.physicalId) ?? null);
  }

  async createOwned(record, guards) {
    assert.equal(guards.tenantId, record.tenantId);
    assert.equal(guards.expectedRowVersion, null);
    if (record.logicalId === this.failLogicalId) {
      const error = new Error('controlled write boundary failure');
      error.code = 'CONTROLLED_FAILURE';
      error.unknownCommit = this.unknownCommit;
      throw error;
    }
    this.createCalls += 1;
    this.rows.set(record.physicalId, this.row(record, 1));
  }

  async replaceOwned(record, guards) {
    const previous = this.rows.get(record.physicalId);
    assert.equal(String(previous.rowVersion), guards.expectedRowVersion);
    this.rows.set(record.physicalId, this.row(record, Number(previous.rowVersion) + 1));
  }

  async deleteOwned(record, guards) {
    const previous = this.rows.get(record.physicalId);
    assert.equal(String(previous.rowVersion), guards.expectedRowVersion);
    this.deleteCalls += 1;
    this.rows.delete(record.physicalId);
  }

  row(record, version) {
    const asset = record.payload.sourceAsset;
    return {
      physicalId: record.physicalId,
      tenantId: record.tenantId,
      owner: record.owner,
      ownership: record.ownership,
      payloadSha256: record.payloadSha256,
      rowVersion: String(version),
      byteSha256: asset?.byteSha256 ?? null,
      byteSize: asset?.byteSize ?? null,
      storageReceiptId: asset ? `test-storage-receipt:${record.logicalId}` : null,
    };
  }
}

async function manifest(availableOwners = ['memory_item']) {
  return buildFixtureManifest({
    tenants: AUTHORIZED_TENANTS,
    clients: CLIENTS,
    actors: ACTORS,
    availableOwners,
  });
}

function rehash(changed) {
  const { contentSha256: _old, ...body } = changed;
  return { ...body, contentSha256: sha256Stable(body) };
}

test('source map covers frozen sources plus CD7/CW8 additions and is honest about subsets', async () => {
  const mapped = await manifest(['memory_item', 'engagement_attachment']);
  assert.equal(
    mapped.records.filter((record) => frozenFixture.sources[record.logicalId]).length,
    Object.keys(frozenFixture.sources).length,
  );
  for (let index = 1; index <= 8; index += 1) {
    assert.ok(
      mapped.records.some(
        (record) => record.logicalId === `CW-${String(index).padStart(2, '0')}-FAULT-ADAPTER`,
      ),
    );
  }
  assert.ok(mapped.records.some((record) => record.logicalId === 'CD-MONDAY-AVAILABILITY'));
  assert.ok(mapped.records.some((record) => record.logicalId === 'CD-MAIL-AVAILABILITY'));
  assert.equal(
    mapped.records.find((record) => record.logicalId === 'CD-MONDAY-AVAILABILITY').availability
      .status,
    'unavailable',
  );
  assert.match(
    mapped.records.find((record) => record.logicalId === 'CD-MONDAY-AVAILABILITY').availability
      .reason,
    /test adapter.*not configured/i,
  );
  assert.equal(
    mapped.records.find((record) => record.logicalId === 'D-A-1').availability.status,
    'available',
  );
  const document = mapped.records.find((record) => record.logicalId === 'D-A-1');
  assert.equal(
    document.physicalId,
    clientDocumentPhysicalId({
      tenantId: AUTHORIZED_TENANTS.T1.id,
      userId: ACTORS.PAT.userId,
      clientId: CLIENTS.ASTER.physicalId,
      idempotencyKey: 'meri-foundation-20260928:D-A-1',
      contentType: document.payload.sourceAsset.mediaType,
      byteSha256: document.payload.sourceAsset.byteSha256,
    }),
  );
  assert.equal(
    mapped.records.find((record) => record.logicalId === 'HR8123-119-INTRO').availability.status,
    'unavailable',
  );
});

test('unconfigured native owners always explain their unavailability', async () => {
  const mapped = await manifest([]);
  for (const record of mapped.records) {
    assert.equal(record.availability.status, 'unavailable');
    assert.equal(typeof record.availability.reason, 'string');
    assert.ok(record.availability.reason.length > 0, record.logicalId);
  }
});

test('document uploader binding cannot borrow an actor from another tenant', async () => {
  const mapped = await buildFixtureManifest({
    clients: CLIENTS,
    actors: { PAT: { ...ACTORS.PAT, tenantId: 'T2' } },
    availableOwners: ['engagement_attachment'],
  });
  const record = mapped.records.find((entry) => entry.logicalId === 'D-A-1');
  assert.equal(record.availability.status, 'unavailable');
  assert.equal(record.uploaderActorId, null);
  assert.match(record.availability.reason, /crosses tenants/);
  assertManifest(mapped);
});

test('explicit uploader binding uses the selected same-tenant actor', async () => {
  const userId = '55555555-5555-4555-8555-555555555555';
  const mapped = await buildFixtureManifest({
    clients: CLIENTS,
    actors: { ...ACTORS, UPLOADER: { tenantId: 'T1', userId } },
    uploaderActors: { T1: 'UPLOADER' },
    availableOwners: ['engagement_attachment'],
  });
  const record = mapped.records.find((entry) => entry.logicalId === 'D-A-1');
  assert.equal(record.uploaderActorId, userId);
  assert.equal(record.availability.status, 'available');
  assert.equal(
    record.physicalId,
    clientDocumentPhysicalId({
      tenantId: AUTHORIZED_TENANTS.T1.id,
      userId,
      clientId: CLIENTS.ASTER.physicalId,
      idempotencyKey: 'meri-foundation-20260928:D-A-1',
      contentType: record.payload.sourceAsset.mediaType,
      byteSha256: record.payload.sourceAsset.byteSha256,
    }),
  );
  assertManifest(mapped);
});

test('rehashing a manifest cannot conceal a changed ownership or uploader identity', async (t) => {
  const base = await manifest(['engagement_attachment']);
  const mutations = [
    [
      'ownership marker',
      'RECORD_OWNERSHIP_MISMATCH',
      (record) => {
        record.ownership.marker.tenantId = AUTHORIZED_TENANTS.T2.id;
      },
    ],
    [
      'physical identity',
      'RECORD_PHYSICAL_ID_MISMATCH',
      (record) => {
        record.physicalId = CLIENTS.CEDAR.physicalId;
      },
    ],
    [
      'uploader actor',
      'DOCUMENT_ACTOR_BINDING_MISMATCH',
      (record) => {
        record.uploaderActorId = CLIENTS.CEDAR.physicalId;
      },
    ],
  ];
  for (const [label, code, mutate] of mutations) {
    await t.test(label, () => {
      const changed = structuredClone(base);
      mutate(changed.records.find((record) => record.logicalId === 'D-A-1'));
      assert.throws(() => assertManifest(rehash(changed)), { code });
    });
  }
});

test('absent proposal is checked without creating it, and reset never deletes it', async () => {
  const mapped = await manifest(['memory_candidate']);
  const record = mapped.records.find((entry) => entry.logicalId === 'MEM-PROPOSAL-13');
  const adapter = new TestCanonicalOwnerAdapter();
  const plan = await planFixture({ manifest: mapped, adapter });
  assert.equal(record.expectedPresence, 'absent');
  assert.equal(
    plan.operations.find((op) => op.logicalId === record.logicalId).action,
    'assert_absent',
  );
  assert.equal(plan.summary.absent, 1);
  const receipt = await applyFixture({
    manifest: mapped,
    plan,
    adapter,
    confirmation: APPLY_CONFIRMATION,
  });
  assert.equal(receipt.status, 'complete');
  assert.equal(
    receipt.records.find((entry) => entry.logicalId === record.logicalId).outcome,
    'verified_absent',
  );
  assert.equal(adapter.rows.has(record.physicalId), false);
  const verified = await verifyFixture({ manifest: mapped, adapter });
  assert.equal(verified.status, 'complete');
  assert.equal(
    verified.records.find((entry) => entry.logicalId === record.logicalId).outcome,
    'verified_absent',
  );
  const reset = await planOwnedReset({ manifest: mapped, seedReceipt: receipt, adapter });
  assert.equal(
    reset.operations.some((entry) => entry.logicalId === record.logicalId),
    false,
  );
});

test('an unexpectedly present proposal stops planning and verification without deleting it', async () => {
  const mapped = await manifest(['memory_candidate']);
  const record = mapped.records.find((entry) => entry.logicalId === 'MEM-PROPOSAL-13');
  const adapter = new TestCanonicalOwnerAdapter();
  adapter.rows.set(record.physicalId, adapter.row(record, 1));
  await assert.rejects(planFixture({ manifest: mapped, adapter }), {
    code: 'EXPECTED_ABSENT_ROW_PRESENT',
  });
  const verified = await verifyFixture({ manifest: mapped, adapter });
  assert.equal(verified.status, 'failed');
  assert.equal(
    verified.records.find((entry) => entry.logicalId === record.logicalId).errorCode,
    'EXPECTED_ABSENT_ROW_PRESENT',
  );
  assert.equal(adapter.deleteCalls, 0);
  assert.equal(adapter.createCalls, 0);
});

test('proposal appearing after planning fails at apply without overwriting it', async () => {
  const mapped = await manifest(['memory_candidate']);
  const record = mapped.records.find((entry) => entry.logicalId === 'MEM-PROPOSAL-13');
  const adapter = new TestCanonicalOwnerAdapter();
  const plan = await planFixture({ manifest: mapped, adapter });
  const appeared = adapter.row(record, 7);
  adapter.rows.set(record.physicalId, appeared);
  const receipt = await applyFixture({
    manifest: mapped,
    plan,
    adapter,
    confirmation: APPLY_CONFIRMATION,
  });
  assert.equal(receipt.status, 'failed');
  assert.equal(
    receipt.records.find((entry) => entry.logicalId === record.logicalId).errorCode,
    'EXPECTED_ABSENT_ROW_PRESENT',
  );
  assert.deepEqual(adapter.rows.get(record.physicalId), appeared);
  assert.equal(adapter.deleteCalls, 0);
});

test('absence semantics cannot be replaced by a rehashed manifest or create operation', async () => {
  const mapped = await manifest(['memory_candidate']);
  const changed = structuredClone(mapped);
  changed.records.find((entry) => entry.logicalId === 'MEM-PROPOSAL-13').expectedPresence =
    'present';
  assert.throws(() => assertManifest(rehash(changed)), { code: 'RECORD_PRESENCE_MISMATCH' });
  const adapter = new TestCanonicalOwnerAdapter();
  const plan = structuredClone(await planFixture({ manifest: mapped, adapter }));
  plan.operations.find((entry) => entry.logicalId === 'MEM-PROPOSAL-13').action = 'create';
  const receipt = await applyFixture({
    manifest: mapped,
    plan: rehash(plan),
    adapter,
    confirmation: APPLY_CONFIRMATION,
  });
  assert.equal(receipt.status, 'failed');
  assert.equal(
    receipt.records.find((entry) => entry.logicalId === 'MEM-PROPOSAL-13').errorCode,
    'PLAN_PRESENCE_MISMATCH',
  );
  assert.equal(
    adapter.rows.has(
      mapped.records.find((entry) => entry.logicalId === 'MEM-PROPOSAL-13').physicalId,
    ),
    false,
  );
});

test('manifest rejects cross-client, tenant, and content-hash mismatches', async (t) => {
  const base = await manifest();
  await t.test('cross-client reference', () => {
    const records = structuredClone(base.records);
    const index = records.findIndex((record) => record.clientLogicalId === 'ASTER');
    records[index].references[0].physicalId = CLIENTS.BLUEHAVEN.physicalId;
    assert.throws(() => assertManifest(rehash({ ...base, records })), {
      code: 'CROSS_CLIENT_REFERENCE',
    });
  });
  await t.test('record tenant', () => {
    const records = structuredClone(base.records);
    records[0].tenantId = AUTHORIZED_TENANTS.T2.id;
    assert.throws(() => assertManifest(rehash({ ...base, records })), {
      code: 'RECORD_TENANT_MISMATCH',
    });
  });
  await t.test('manifest content address', () => {
    assert.throws(() => assertManifest({ ...base, fixtureNamespace: 'foreign' }), {
      code: 'MANIFEST_FIXTURE_MISMATCH',
    });
  });
});

test('plan refuses an existing unowned marker before any write', async () => {
  const sourceMap = await manifest();
  const adapter = new TestCanonicalOwnerAdapter();
  const record = sourceMap.records.find((entry) => entry.availability.status === 'available');
  adapter.rows.set(record.physicalId, {
    ...adapter.row(record, 7),
    ownership: { marker: { logicalId: record.logicalId }, markerSha256: 'f'.repeat(64) },
  });
  await assert.rejects(() => planFixture({ manifest: sourceMap, adapter }), {
    code: 'UNOWNED_ROW_COLLISION',
  });
  assert.equal(adapter.createCalls, 0);
});

test('duplicate apply is idempotent with stable physical IDs and actual readback', async () => {
  const sourceMap = await manifest();
  const adapter = new TestCanonicalOwnerAdapter();
  const firstPlan = await planFixture({ manifest: sourceMap, adapter });
  const first = await applyFixture({
    manifest: sourceMap,
    plan: firstPlan,
    adapter,
    confirmation: APPLY_CONFIRMATION,
  });
  assert.equal(first.status, 'complete');
  assert.equal(first.fixtureComplete, false);
  assert.ok(first.unavailable.length > 0);
  const ids = first.records.map((record) => record.physicalId);
  const creates = adapter.createCalls;

  const secondPlan = await planFixture({ manifest: sourceMap, adapter });
  assert.equal(secondPlan.summary.creates, 0);
  assert.equal(secondPlan.summary.replacements, 0);
  assert.ok(secondPlan.summary.stable > 0);
  const second = await applyFixture({
    manifest: sourceMap,
    plan: secondPlan,
    adapter,
    confirmation: APPLY_CONFIRMATION,
  });
  assert.deepEqual(
    second.records.map((record) => record.physicalId),
    ids,
  );
  assert.equal(adapter.createCalls, creates);
  const verified = await verifyFixture({ manifest: sourceMap, adapter });
  assert.equal(verified.status, 'complete');
  assert.ok(verified.records.every((record) => record.outcome === 'verified'));
});

test('apply records unknown partial writes without claiming completion', async () => {
  const sourceMap = await manifest();
  const firstAvailable = sourceMap.records.find(
    (record) => record.availability.status === 'available',
  );
  const adapter = new TestCanonicalOwnerAdapter({
    failLogicalId: firstAvailable.logicalId,
    unknownCommit: true,
  });
  const plan = await planFixture({ manifest: sourceMap, adapter });
  const receipt = await applyFixture({
    manifest: sourceMap,
    plan,
    adapter,
    confirmation: APPLY_CONFIRMATION,
  });
  assert.equal(receipt.status, 'unknown_outcome');
  assert.equal(receipt.records.at(-1).outcome, 'unknown_outcome');
  assert.equal(receipt.fixtureComplete, false);
});

test('owned reset is manifest-limited and blocks a changed row version', async () => {
  const sourceMap = await manifest();
  const adapter = new TestCanonicalOwnerAdapter();
  const plan = await planFixture({ manifest: sourceMap, adapter });
  const seed = await applyFixture({
    manifest: sourceMap,
    plan,
    adapter,
    confirmation: APPLY_CONFIRMATION,
  });
  const seeded = seed.records[0];
  adapter.rows.get(seeded.physicalId).rowVersion = '99';
  await assert.rejects(() => planOwnedReset({ manifest: sourceMap, seedReceipt: seed, adapter }), {
    code: 'RESET_ROW_VERSION_CHANGED',
  });
  assert.equal(adapter.deleteCalls, 0);

  adapter.rows.get(seeded.physicalId).rowVersion = seeded.rowVersion;
  const resetPlan = await planOwnedReset({ manifest: sourceMap, seedReceipt: seed, adapter });
  const firstReset = seed.records.find(
    (record) => record.physicalId === resetPlan.operations[0].physicalId,
  );
  adapter.rows.get(firstReset.physicalId).rowVersion = '99';
  const refused = await applyOwnedReset({
    manifest: sourceMap,
    seedReceipt: seed,
    resetPlan,
    adapter,
    confirmation: RESET_CONFIRMATION,
  });
  assert.equal(refused.status, 'failed', 'pre-mutation version refusal is not an unknown write');
  assert.equal(adapter.deleteCalls, 0);
  adapter.rows.get(firstReset.physicalId).rowVersion = firstReset.rowVersion;
  const reset = await applyOwnedReset({
    manifest: sourceMap,
    seedReceipt: seed,
    resetPlan,
    adapter,
    confirmation: RESET_CONFIRMATION,
  });
  assert.equal(reset.status, 'complete');
  assert.equal(adapter.rows.size, 0);
  assert.equal(adapter.deleteCalls, seed.records.length);
});

test('reset treats a lost acknowledgement after canonical deletion as an unknown outcome', async () => {
  const sourceMap = await manifest();
  const adapter = new TestCanonicalOwnerAdapter();
  const plan = await planFixture({ manifest: sourceMap, adapter });
  const seed = await applyFixture({
    manifest: sourceMap,
    plan,
    adapter,
    confirmation: APPLY_CONFIRMATION,
  });
  const resetPlan = await planOwnedReset({ manifest: sourceMap, seedReceipt: seed, adapter });
  const originalDelete = adapter.deleteOwned.bind(adapter);
  adapter.deleteOwned = async (record, guards) => {
    await originalDelete(record, guards);
    throw new Error('acknowledgement lost after committed deletion');
  };
  const reset = await applyOwnedReset({
    manifest: sourceMap,
    seedReceipt: seed,
    resetPlan,
    adapter,
    confirmation: RESET_CONFIRMATION,
  });
  assert.equal(reset.status, 'unknown_outcome');
  assert.equal(reset.records[0].outcome, 'unknown_outcome');
  assert.equal(adapter.deleteCalls, 1);
  adapter.deleteOwned = originalDelete;
  const reconciled = await applyOwnedReset({
    manifest: sourceMap,
    seedReceipt: seed,
    resetPlan,
    adapter,
    confirmation: RESET_CONFIRMATION,
  });
  assert.equal(reconciled.status, 'complete');
  assert.equal(reconciled.records[0].outcome, 'already_absent');
  assert.equal(
    adapter.deleteCalls,
    seed.records.length,
    'retry does not delete the missing row twice',
  );
});

test('immutable source-byte mismatch fails before planning or uploader access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meri-fixture-assets-'));
  try {
    const original = JSON.parse(
      await (
        await import('node:fs/promises')
      ).readFile(new URL('../source-binaries/asset-manifest.json', import.meta.url), 'utf8'),
    );
    original.assets[0].byteSha256 = '0'.repeat(64);
    const changed = join(directory, 'asset-manifest.json');
    await writeFile(changed, `${JSON.stringify(original)}\n`, 'utf8');
    await assert.rejects(
      () =>
        buildFixtureManifest({
          tenants: AUTHORIZED_TENANTS,
          clients: CLIENTS,
          actors: ACTORS,
          availableOwners: ['engagement_attachment'],
          assetManifestUrl: pathToFileURL(changed),
        }),
      { code: 'ASSET_BYTE_HASH_MISMATCH' },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('verification grades canonical readback rather than writer return values', async () => {
  const sourceMap = await manifest();
  const adapter = new TestCanonicalOwnerAdapter();
  const plan = await planFixture({ manifest: sourceMap, adapter });
  const first = plan.operations.find((operation) => operation.action === 'create');
  const originalCreate = adapter.createOwned.bind(adapter);
  adapter.createOwned = async (record, guards) => {
    await originalCreate(record, guards);
    if (record.logicalId === first.logicalId) {
      adapter.rows.get(record.physicalId).payloadSha256 = 'a'.repeat(64);
    }
  };
  const receipt = await applyFixture({
    manifest: sourceMap,
    plan,
    adapter,
    confirmation: APPLY_CONFIRMATION,
  });
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.records[0].errorCode, 'ACTUAL_READBACK_MISMATCH');
});
