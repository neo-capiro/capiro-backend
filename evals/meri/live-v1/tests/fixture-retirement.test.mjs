import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { buildFixtureManifest } from '../fixture-provisioning/manifest.mjs';
import { applyFixture, planFixture } from '../fixture-provisioning/provisioner.mjs';
import {
  planOwnedRetirement,
  applyOwnedRetirement,
  verifyOwnedRetirement,
} from '../fixture-provisioning/retirement.mjs';
import {
  APPLY_CONFIRMATION,
  RETIRE_CONFIRMATION,
  FixtureProvisioningError,
  receiptWithHash,
  assertReceiptHash,
  fixtureReceiptId,
} from '../fixture-provisioning/contract.mjs';

const config = {
  clients: Object.fromEntries(
    ['ASTER', 'BLUEHAVEN', 'CEDAR'].map((name, index) => [
      name,
      {
        tenantId: name === 'CEDAR' ? 'T2' : 'T1',
        physicalId: `${String(index + 1).repeat(8)}-1111-4111-8111-111111111111`,
      },
    ]),
  ),
  actors: { PAT: { tenantId: 'T1', userId: '44444444-4444-4444-8444-444444444444' } },
  availableOwners: ['memory_candidate'],
};
const manifest = await buildFixtureManifest({ ...config, fixtureInstanceId: randomUUID() });
const replacementManifest = await buildFixtureManifest({
  ...config,
  fixtureInstanceId: randomUUID(),
});
const rehash = ({ contentSha256: _hash, ...body }) => receiptWithHash(body);

// In-memory state-machine adapter only; real service/database coverage is separate.
async function setup() {
  const rows = new Map();
  const calls = [];
  let failAfterCommit = 0;
  const adapter = {
    authority: 'canonical_readback',
    inspect: async (record) => structuredClone(rows.get(record.physicalId) ?? null),
    async createOwned(record) {
      rows.set(record.physicalId, {
        physicalId: record.physicalId,
        tenantId: record.tenantId,
        owner: record.owner,
        ownership: record.ownership,
        payloadSha256: record.payloadSha256,
        rowVersion: '1',
      });
    },
    replaceOwned: async () => assert.fail('replacement is outside retirement'),
    deleteOwned: async () => assert.fail('retirement must never delete'),
    async inspectRetirement(record) {
      const row = rows.get(record.physicalId);
      if (!row?.retained)
        throw new FixtureProvisioningError(
          'MEMORY_CANDIDATE_RETIREMENT_UNVERIFIED',
          record.logicalId,
        );
      return structuredClone(row);
    },
    async retireOwned(record, guards) {
      const row = rows.get(record.physicalId);
      assert.equal(row.retained, undefined);
      assert.equal(row.rowVersion, guards.expectedRowVersion);
      assert.equal(guards.expectedOwnershipMarkerSha256, record.ownership.markerSha256);
      rows.set(record.physicalId, {
        ...row,
        rowVersion: '2',
        priorRowVersion: '1',
        retained: true,
        status: 'withdrawn',
        governedStatus: 'rejected',
        transitionAuditId: randomUUID(),
      });
      calls.push(record.physicalId);
      if (failAfterCommit === calls.length) throw new Error('lost transport response after commit');
    },
  };
  const seedReceipt = await applyFixture({
    manifest,
    adapter,
    plan: await planFixture({ manifest, adapter }),
    confirmation: APPLY_CONFIRMATION,
  });
  assert.equal(seedReceipt.status, 'complete');
  const args = { manifest, replacementManifest, seedReceipt, adapter };
  const retirementPlan = await planOwnedRetirement(args);
  return {
    ...args,
    retirementPlan,
    rows,
    calls,
    confirmation: RETIRE_CONFIRMATION,
    failAt: (count) => {
      failAfterCommit = count;
    },
  };
}

test('retirement retains every available old row and binds both manifests without claiming full fixture completion', async () => {
  const h = await setup();
  const before = h.rows.size;
  const receipt = await applyOwnedRetirement(h);
  assert.equal(receipt.status, 'complete');
  assert.equal(h.rows.size, before);
  assert.equal(h.calls.length, before);
  assert.equal(receipt.manifestContentSha256, manifest.contentSha256);
  assert.equal(receipt.replacementManifestContentSha256, replacementManifest.contentSha256);
  assert.equal(receipt.fixtureComplete, false);
  assert.ok(receipt.unavailable.length > 0);
  assert.ok(receipt.records.some((record) => record.outcome === 'verified_absent'));
  assert.ok(
    receipt.records
      .filter((record) => record.outcome === 'retained_terminal')
      .every((record) => record.retained === true && record.transitionAuditId),
  );
  const verified = await verifyOwnedRetirement({ ...h, retirementReceipt: receipt });
  assert.equal(verified.status, 'complete');
  assert.equal(verified.retirementReceiptContentSha256, receipt.contentSha256);
  assert.match(
    fixtureReceiptId(receipt, receipt.kind),
    /^meri-synthetic-fixture-retirement-receipt:sha256:/u,
  );
  assert.throws(() => assertReceiptHash(receipt, 'meri-synthetic-fixture-reset-receipt'), {
    code: 'RECEIPT_KIND_MISMATCH',
  });
});

async function approvedSetup() {
  const h = await setup();
  const [id, row] = h.rows.entries().next().value;
  h.rows.set(id, {
    ...row,
    lifecycle: 'approved',
    rowVersion: '3',
    approvedItemId: randomUUID(),
    itemRowVersion: '4',
  });
  const retirePending = h.adapter.retireOwned;
  let loseResponse = false;
  h.adapter.retireOwned = async (record, guards) => {
    if (guards.action !== 'revoke_approved') return retirePending(record, guards);
    const active = h.rows.get(record.physicalId);
    assert.equal(active.approvedItemId, guards.approvedItemId);
    assert.equal(active.rowVersion, guards.expectedRowVersion);
    assert.equal(active.itemRowVersion, guards.expectedItemRowVersion);
    h.rows.set(record.physicalId, {
      ...active,
      retained: true,
      status: 'approved',
      governedStatus: 'active',
      priorRowVersion: active.rowVersion,
      itemStatus: 'revoked',
      itemGovernedStatus: 'revoked',
      itemRowVersion: '5',
      priorItemRowVersion: '4',
      transitionAuditId: randomUUID(),
      cleanupIntentId: randomUUID(),
    });
    h.calls.push(record.physicalId);
    if (loseResponse) throw new Error('lost approved revocation response');
  };
  h.retirementPlan = await planOwnedRetirement(h);
  return {
    ...h,
    approvedId: id,
    loseResponse: () => {
      loseResponse = true;
    },
  };
}

test('approved retirement uses current approved lineage and preserves candidate history in its typed proof', async () => {
  const h = await approvedSetup();
  const op = h.retirementPlan.operations.find((row) => row.physicalId === h.approvedId);
  assert.equal(op.action, 'revoke_approved');
  assert.equal(op.expectedRowVersion, '3');
  assert.equal(op.expectedItemRowVersion, '4');
  const receipt = await applyOwnedRetirement(h);
  assert.equal(receipt.status, 'complete');
  const proof = receipt.records.find((row) => row.physicalId === h.approvedId);
  assert.equal(proof.status, 'approved');
  assert.equal(proof.rowVersion, '3');
  assert.equal(proof.terminalSubject, 'memory_item');
  assert.equal(proof.itemStatus, 'revoked');
  assert.equal(proof.itemRowVersion, '5');
  assert.equal(
    (await verifyOwnedRetirement({ ...h, retirementReceipt: receipt })).status,
    'complete',
  );
});

test('approved retirement reconciles a lost response without revoking again', async () => {
  const h = await approvedSetup();
  h.loseResponse();
  assert.equal((await applyOwnedRetirement(h)).status, 'unknown_outcome');
  assert.equal((await applyOwnedRetirement(h)).status, 'complete');
  assert.equal(h.calls.filter((id) => id === h.approvedId).length, 1);
});

test('rehashing approved item identity or versions cannot bypass current canonical inspection', async () => {
  for (const [key, value] of [
    ['approvedItemId', randomUUID()],
    ['expectedItemRowVersion', '9'],
    ['expectedRowVersion', '9'],
  ]) {
    const h = await approvedSetup();
    const plan = structuredClone(h.retirementPlan);
    plan.operations.find((row) => row.physicalId === h.approvedId)[key] = value;
    const result = await applyOwnedRetirement({ ...h, retirementPlan: rehash(plan) });
    assert.equal(result.status, 'failed');
    assert.equal(h.calls.length, 0);
  }
});

test('approved retained proof refuses changed prior item version or missing cleanup intent', async () => {
  for (const change of [
    { priorItemRowVersion: '9' },
    { cleanupIntentId: null },
    { rowVersion: '9' },
  ]) {
    const h = await approvedSetup();
    const receipt = await applyOwnedRetirement(h);
    h.rows.set(h.approvedId, { ...h.rows.get(h.approvedId), ...change });
    assert.equal(
      (await verifyOwnedRetirement({ ...h, retirementReceipt: receipt })).status,
      'failed',
    );
  }
});

test('same-plan retry reconciles a lost committed response and never repeats retired writes', async () => {
  const h = await setup();
  h.failAt(2);
  const partial = await applyOwnedRetirement(h);
  assert.equal(partial.status, 'unknown_outcome');
  assert.equal(h.calls.length, 2);
  assert.ok(partial.records.length < h.retirementPlan.operations.length);
  const completed = await applyOwnedRetirement(h);
  assert.equal(completed.status, 'complete');
  assert.equal(new Set(h.calls).size, h.calls.length);
  assert.equal(h.calls.length, h.rows.size);
  assert.equal(
    (await verifyOwnedRetirement({ ...h, retirementReceipt: completed })).status,
    'complete',
  );
});

test('rehashing a plan cannot omit, duplicate, reorder or redirect its operations', async () => {
  for (const mutate of [
    (p) => p.operations.pop(),
    (p) => p.operations.push(p.operations[0]),
    (p) => p.operations.reverse(),
    (p) => {
      p.operations[0].action = 'delete_owned';
    },
    (p) => {
      p.operations[0].physicalId = randomUUID();
    },
    (p) => {
      p.operations[0].replacementPhysicalId = randomUUID();
    },
    (p) => {
      p.operations[0].expectedRowVersion = '9';
    },
  ]) {
    const h = await setup();
    const changed = structuredClone(h.retirementPlan);
    mutate(changed);
    await assert.rejects(applyOwnedRetirement({ ...h, retirementPlan: rehash(changed) }), {
      code: 'RETIREMENT_PLAN_MISMATCH',
    });
    assert.equal(h.calls.length, 0);
  }
});

test('partial, duplicate or foreign seed evidence cannot authorize retirement', async () => {
  for (const mutate of [
    (s) => {
      s.status = 'failed';
    },
    (s) => s.records.pop(),
    (s) => {
      s.records[1] = s.records[0];
    },
    (s) => {
      s.records[0].tenantId = randomUUID();
    },
    (s) => {
      s.manifestContentSha256 = replacementManifest.contentSha256;
    },
  ]) {
    const h = await setup();
    const changed = structuredClone(h.seedReceipt);
    mutate(changed);
    await assert.rejects(planOwnedRetirement({ ...h, seedReceipt: rehash(changed) }), (error) =>
      error.code.startsWith('RETIREMENT_SEED_'),
    );
    assert.equal(h.calls.length, 0);
  }
});

test('offline authority and missing confirmation fail before writes', async () => {
  const h = await setup();
  await assert.rejects(applyOwnedRetirement({ ...h, confirmation: undefined }), {
    code: 'RETIREMENT_CONFIRMATION_REQUIRED',
  });
  await assert.rejects(
    applyOwnedRetirement({ ...h, adapter: { ...h.adapter, authority: 'offline_unverified' } }),
    { code: 'RETIREMENT_OWNER_REQUIRED' },
  );
  assert.equal(h.calls.length, 0);
});

test('a changed row after planning stops retirement without silently accepting the new version', async () => {
  const h = await setup();
  const [id, row] = h.rows.entries().next().value;
  h.rows.set(id, { ...row, rowVersion: '9' });
  const receipt = await applyOwnedRetirement(h);
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.records.at(-1).errorCode, 'RETIREMENT_ROW_CHANGED');
  assert.equal(h.calls.length, 0);
});

test('verification rechecks canonical evidence and rejects truncated or substituted receipts', async () => {
  const h = await setup();
  const receipt = await applyOwnedRetirement(h);
  await assert.rejects(
    verifyOwnedRetirement({
      ...h,
      retirementReceipt: rehash({ ...receipt, records: receipt.records.slice(1) }),
    }),
    { code: 'RETIREMENT_RECEIPT_MISMATCH' },
  );
  const [id, row] = h.rows.entries().next().value;
  h.rows.set(id, { ...row, transitionAuditId: randomUUID() });
  assert.equal(
    (await verifyOwnedRetirement({ ...h, retirementReceipt: receipt })).status,
    'failed',
  );
});

test('replacement must preserve logical scope and availability while selecting a distinct instance', async () => {
  const h = await setup();
  await assert.rejects(planOwnedRetirement({ ...h, replacementManifest: manifest }), {
    code: 'RETIREMENT_INSTANCE_REQUIRED',
  });
  const narrower = await buildFixtureManifest({
    ...config,
    fixtureInstanceId: randomUUID(),
    availableOwners: [],
  });
  await assert.rejects(planOwnedRetirement({ ...h, replacementManifest: narrower }), {
    code: 'RETIREMENT_REPLACEMENT_MISMATCH',
  });
  assert.equal(h.calls.length, 0);
});

test('audit-bound resume refuses a retirement performed against a different prior row version', async () => {
  const h = await setup();
  h.failAt(1);
  assert.equal((await applyOwnedRetirement(h)).status, 'unknown_outcome');
  const [id, row] = h.rows.entries().next().value;
  h.rows.set(id, { ...row, priorRowVersion: '9' });
  const retry = await applyOwnedRetirement(h);
  assert.equal(retry.status, 'failed');
  assert.equal(retry.records.at(-1).errorCode, 'RETIREMENT_PROOF_MISMATCH');
  assert.equal(h.calls.length, 1);
});

test('readback failure after mutation remains unknown and can reconcile through the same plan', async () => {
  const h = await setup();
  const inspect = h.adapter.inspectRetirement;
  let missingAudit = true;
  h.adapter.inspectRetirement = async (record) => {
    const actual = await inspect(record);
    if (missingAudit)
      throw new FixtureProvisioningError(
        'MEMORY_CANDIDATE_RETIREMENT_AUDIT_MISSING',
        record.logicalId,
      );
    return actual;
  };
  const first = await applyOwnedRetirement(h);
  assert.equal(first.status, 'unknown_outcome');
  assert.equal(h.calls.length, 1);
  missingAudit = false;
  const retry = await applyOwnedRetirement(h);
  assert.equal(retry.status, 'complete');
  assert.equal(new Set(h.calls).size, h.calls.length);
});
