import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildFixtureManifest } from '../fixture-provisioning/manifest.mjs';
import { approvedMemoryDefinitions } from '../fixture-provisioning/approved-memory-runtime.mjs';
import { createCase12MemoryInventoryOwner, CASE12_SEED_RECEIPT_KIND } from '../fixture-provisioning/case12-memory-inventory-owner.mjs';
import { expectedMemoryCandidatePayload } from '../fixture-provisioning/memory-candidate-owner.mjs';
import { sha256Stable, stableJson } from '../lib/stable.mjs';

const INSTANCE = 'c924e861-06e5-4f26-a1b1-a7fc70840b35';
const id = () => randomUUID();

async function fixture() {
  const manifest = await buildFixtureManifest({
    fixtureInstanceId: INSTANCE,
    clients: {
      ASTER: { tenantId: 'T1', physicalId: id() },
      BLUEHAVEN: { tenantId: 'T1', physicalId: id() },
      CEDAR: { tenantId: 'T2', physicalId: id() },
    },
    actors: { PAT: { tenantId: 'T1', physicalId: id() } },
  });
  const definitions = approvedMemoryDefinitions(manifest);
  const bindings = definitions.map((entry) => ({
    logicalId: entry.logicalId,
    supporting: entry.supporting,
    owner: 'memory_item',
    tenantId: entry.candidate.tenantId,
    clientId: entry.candidate.clientPhysicalId,
    physicalId: id(), // UNIT ONLY allocated-row stand-in; distinct from proposals.
    proposedItemId: entry.proposedItemId,
    candidateId: entry.candidate.physicalId,
    ownershipMarkerSha256: entry.candidate.ownership.markerSha256,
    candidatePayloadSha256: entry.candidate.payloadSha256,
    candidateRowVersion: '101',
    itemRowVersion: '202',
    lifecycle: 'approved',
  }));
  const seedInventory = {
    kind: CASE12_SEED_RECEIPT_KIND,
    fixtureMapSha256: manifest.contentSha256,
    bindings,
    bindingsSha256: sha256Stable(bindings),
  };
  return { manifest, definitions, seedInventory };
}

function spies({ manifest, definitions, seedInventory, newer = 509, deniedId, changedItemRowVersionId, foreignId, membershipRole = 'standard_user' }) {
  const tenantId = manifest.tenants.T1.id;
  const clientId = manifest.clients.ASTER.physicalId;
  const byLogical = new Map(seedInventory.bindings.map((row) => [row.logicalId, row]));
  const byItem = new Map(seedInventory.bindings.map((row) => [row.physicalId, row]));
  const byCandidate = new Map(seedInventory.bindings.map((row) => [row.candidateId, row]));
  const calls = { membership: 0, candidate: 0, item: 0, newer: 0, owner: 0, load: 0, auth: 0 };
  const tx = {};
  // Capture stable proposer by call so the candidate query and helper share it.
  let proposerId;
  const stableProposer = async (value) => {
    assert.equal(value, tenantId);
    return (proposerId ??= id());
  };
  tx.$queryRawUnsafe = async (sql, ...args) => {
    if (sql.includes('FROM tenant_memberships')) {
      calls.membership++;
      return [{ user_id: args[1], role: membershipRole }];
    }
    if (sql.includes('FROM memory_candidate')) {
      calls.candidate++;
      const row = byCandidate.get(args[1]);
      return row && row.candidateRowVersion === args[3] && args[2] === proposerId
        ? [{ proposed_by: proposerId }]
        : [];
    }
    if (sql.includes('COUNT(DISTINCT')) {
      calls.newer++;
      assert.match(sql, /inventory\.updated_at\s*>\s*target\.updated_at/u);
      assert.match(sql, /inventory\.created_at\s*>\s*target\.created_at/u);
      assert.match(sql, /inventory\.id<>target\.id/u);
      return [{ count: String(newer) }];
    }
    if (sql.includes('FROM memory_items')) {
      calls.item++;
      const itemId = args[0];
      const row = byItem.get(itemId);
      if (!row) return [];
      return [{
        id: itemId,
        tenant_id: foreignId === itemId ? id() : tenantId,
        client_id: clientId,
        status: 'active',
        source_version: 'v1',
        source_content_hash: 'a'.repeat(64),
        sections_jsonb: { content: `unit:${row.logicalId}` },
        row_version: changedItemRowVersionId === itemId ? '999' : row.itemRowVersion,
        created_at: '2040-01-01T00:00:00.000001Z',
        updated_at: '2040-01-02T00:00:00.000001Z',
      }];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  const owner = async (txArg, ctx, candidateId, guard) => {
    calls.owner++;
    const row = byCandidate.get(candidateId);
    assert.ok(row);
    assert.equal(guard.expectedRowVersion, row.candidateRowVersion);
    assert.equal(guard.expectedItemRowVersion, row.itemRowVersion);
    assert.equal(guard.expectedPayload, (await import('../fixture-provisioning/memory-candidate-owner.mjs')).expectedMemoryCandidatePayload(
      definitions.find((entry) => entry.logicalId === row.logicalId).candidate,
      proposerId,
      stableJson({
        ownership: definitions.find((entry) => entry.logicalId === row.logicalId).candidate.ownership,
        payload: definitions.find((entry) => entry.logicalId === row.logicalId).candidate.payload,
      }),
    ));
    return {
      itemId: row.physicalId,
      syntheticFixtureCandidateRowVersion: row.candidateRowVersion,
      status: 'active',
      governedStatus: 'active',
    };
  };
  const memoryAuthorization = {
    async loadItemInTx(txArg, actualTenant, itemId) {
      calls.load++;
      assert.equal(actualTenant, tenantId);
      assert.ok(byItem.has(itemId));
      return { id: itemId, tenantId: actualTenant };
    },
    async evaluateInTx(txArg, ctx, subject, action, options) {
      calls.auth++;
      assert.equal(action, 'read');
      assert.deepEqual(options, { emitDenialMetrics: false });
      return { allowed: subject.id !== deniedId };
    },
  };
  return {
    tx, calls, proposerForTenant: stableProposer,
    owner: (txArg, ctx, candidateId, guard) => owner(txArg, ctx, candidateId, guard),
    memoryAuthorization,
    ctx: { tenantId, userId: manifest.actors.PAT.physicalId, role: 'standard_user' },
    clientId,
  };
}

function makeOwner(data, boundary) {
  return createCase12MemoryInventoryOwner({
    manifest: data.manifest,
    seedInventory: data.seedInventory,
    proposerForTenant: boundary.proposerForTenant,
    assertSyntheticApprovedMemoryInTx: boundary.owner,
    memoryAuthorization: boundary.memoryAuthorization,
  });
}

async function expectFailure(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code);
}

test('successful canonical inspection verifies all owner/auth rows but never readiness or retrieval eligibility', async () => {
  const data = await fixture();
  const boundary = spies(data);
  const owner = makeOwner(data, boundary);
  const result = await owner.inspectInTx(boundary.tx, boundary.ctx, { caseId: '12', clientId: boundary.clientId });
  assert.equal(result.inventoryVerified, true);
  assert.equal(result.fixtureReady, false);
  assert.equal(result.captureAuthority, false);
  assert.equal(result.liveAcceptance, 'NOT_RUN');
  assert.equal(result.retrievalEligibility, 'RETRIEVAL_ELIGIBILITY_NOT_QUALIFIED');
  assert.equal(result.olderThan500PermittedOwnerRowsVerified, true);
  assert.equal(result.observations.length, 510);
  for (const key of ['owner', 'load', 'auth', 'item', 'candidate']) assert.equal(boundary.calls[key], 510);
  assert.equal(boundary.calls.newer, 1);
  assert.equal(Object.keys(owner).join(','), 'inspectInTx');
});

test('missing exact manifest and seed reports NOT_READY without DB reads', async () => {
  const data = await fixture();
  const boundary = spies(data);
  const owner = createCase12MemoryInventoryOwner({
    seedInventory: undefined,
    proposerForTenant: boundary.proposerForTenant,
    assertSyntheticApprovedMemoryInTx: boundary.owner,
    memoryAuthorization: boundary.memoryAuthorization,
  });
  const result = await owner.inspectInTx(boundary.tx, boundary.ctx, { caseId: '12', clientId: boundary.clientId });
  assert.equal(result.fixtureReady, false);
  assert.equal(result.inventoryVerified, false);
  assert.ok(result.missing.includes('EXACT_FIXTURE_MANIFEST_MISSING'));
  assert.ok(result.missing.includes('EXACT_ORIGINAL_SEED_INVENTORY_MISSING'));
  assert.equal(boundary.calls.membership, 0);
});

test('a seed-only not-ready envelope does not imply a manifest or trigger reads', async () => {
  const data = await fixture();
  const boundary = spies(data);
  const owner = createCase12MemoryInventoryOwner({
    seedInventory: data.seedInventory,
    proposerForTenant: boundary.proposerForTenant,
    assertSyntheticApprovedMemoryInTx: boundary.owner,
    memoryAuthorization: boundary.memoryAuthorization,
  });
  const result = await owner.inspectInTx(boundary.tx, boundary.ctx, { caseId: '12', clientId: boundary.clientId });
  assert.ok(result.missing.includes('EXACT_FIXTURE_MANIFEST_MISSING'));
  assert.equal(boundary.calls.membership, 0);
});

test('malformed manifest content hash rejects before inspection', async () => {
  const data = await fixture();
  data.manifest.contentSha256 = '0'.repeat(64);
  const boundary = spies(data);
  assert.throws(() => makeOwner(data, boundary), (error) => error?.code === 'MANIFEST_HASH_MISMATCH');
  assert.equal(boundary.calls.membership, 0);
});

test('fixture instance is required exactly; generated/new locator is not accepted', async () => {
  const data = await fixture();
  delete data.manifest.fixtureInstanceId;
  const { contentSha256, ...body } = data.manifest;
  data.manifest = { ...body, contentSha256: sha256Stable(body) };
  data.seedInventory.fixtureMapSha256 = data.manifest.contentSha256;
  data.seedInventory.bindingsSha256 = sha256Stable(data.seedInventory.bindings);
  const boundary = spies(data);
  assert.throws(() => makeOwner(data, boundary), (error) => error?.code === 'CASE12_EXACT_FIXTURE_INSTANCE_ID_REQUIRED');
});

test('receipt hash or manifest binding mismatch rejects supplied seed evidence', async () => {
  const data = await fixture();
  data.seedInventory.bindingsSha256 = 'f'.repeat(64);
  const boundary = spies(data);
  assert.throws(() => makeOwner(data, boundary), (error) => error?.code === 'CASE12_SEED_RECEIPT_INVALID');
});

test('duplicate logical id is rejected even with rehashed receipt', async () => {
  const data = await fixture();
  data.seedInventory.bindings[1].logicalId = data.seedInventory.bindings[0].logicalId;
  data.seedInventory.bindingsSha256 = sha256Stable(data.seedInventory.bindings);
  const boundary = spies(data);
  assert.throws(() => makeOwner(data, boundary), (error) => error?.code === 'CASE12_DUPLICATE_LOGICAL_ID');
});

test('duplicate actual physical item id is rejected', async () => {
  const data = await fixture();
  data.seedInventory.bindings[1].physicalId = data.seedInventory.bindings[0].physicalId;
  data.seedInventory.bindingsSha256 = sha256Stable(data.seedInventory.bindings);
  const boundary = spies(data);
  assert.throws(() => makeOwner(data, boundary), (error) => error?.code === 'CASE12_DUPLICATE_PHYSICAL_ID');
});

test('missing MA510 or distractor rejects complete inventory', async () => {
  for (const missingId of ['MA510', 'MA510-DISTRACTOR-0001']) {
    const data = await fixture();
    data.seedInventory.bindings = data.seedInventory.bindings.filter((row) => row.logicalId !== missingId);
    data.seedInventory.bindingsSha256 = sha256Stable(data.seedInventory.bindings);
    const boundary = spies(data);
    assert.throws(() => makeOwner(data, boundary), (error) => error?.code === 'CASE12_SEED_INVENTORY_MISMATCH');
  }
});

test('unknown row fields and caller-claimed eligibility flags are refused', async () => {
  const data = await fixture();
  data.seedInventory.bindings[0].eligible = true;
  data.seedInventory.bindingsSha256 = sha256Stable(data.seedInventory.bindings);
  const boundary = spies(data);
  assert.throws(() => makeOwner(data, boundary), (error) => error?.code === 'CASE12_BINDING_UNKNOWN_FIELDS');
});

test('altered marker binding is rejected before any database call', async () => {
  const data = await fixture();
  data.seedInventory.bindings[0].ownershipMarkerSha256 = 'b'.repeat(64);
  data.seedInventory.bindingsSha256 = sha256Stable(data.seedInventory.bindings);
  const boundary = spies(data);
  assert.throws(() => makeOwner(data, boundary), (error) => error?.code === 'CASE12_SEED_BINDING_MISMATCH');
  assert.equal(boundary.calls.membership, 0);
});

test('proposed rather than allocated physical ID is refused', async () => {
  const data = await fixture();
  const entry = data.definitions.find((row) => row.proposedItemId);
  const binding = data.seedInventory.bindings.find((row) => row.logicalId === entry.logicalId);
  binding.physicalId = entry.proposedItemId;
  data.seedInventory.bindingsSha256 = sha256Stable(data.seedInventory.bindings);
  const boundary = spies(data);
  assert.throws(() => makeOwner(data, boundary), (error) => error?.code === 'CASE12_SEED_BINDING_MISMATCH');
});

test('wrong case, tenant, client, actor role and reviewer role cannot inspect', async () => {
  const data = await fixture();
  const boundary = spies(data);
  const owner = makeOwner(data, boundary);
  await expectFailure(owner.inspectInTx(boundary.tx, boundary.ctx, { caseId: '01', clientId: boundary.clientId }), 'CASE12_ONLY');
  await expectFailure(owner.inspectInTx(boundary.tx, { ...boundary.ctx, tenantId: id() }, { caseId: '12', clientId: boundary.clientId }), 'CASE12_ORDINARY_ACTOR_SCOPE_MISMATCH');
  await expectFailure(owner.inspectInTx(boundary.tx, boundary.ctx, { caseId: '12', clientId: id() }), 'CASE12_ORDINARY_ACTOR_SCOPE_MISMATCH');
  await expectFailure(owner.inspectInTx(boundary.tx, { ...boundary.ctx, role: 'institutional_memory_reviewer' }, { caseId: '12', clientId: boundary.clientId }), 'CASE12_ORDINARY_ACTOR_SCOPE_MISMATCH');
  assert.equal(boundary.calls.membership, 0);
});

test('active ordinary membership must match actor context', async () => {
  const data = await fixture();
  const boundary = spies({ ...data, membershipRole: 'user_admin' });
  const owner = makeOwner(data, boundary);
  await expectFailure(owner.inspectInTx(boundary.tx, boundary.ctx, { caseId: '12', clientId: boundary.clientId }), 'CASE12_ORDINARY_ACTOR_MEMBERSHIP_INVALID');
  assert.equal(boundary.calls.candidate, 0);
});

test('foreign canonical tenant row is refused with no partial inventory result', async () => {
  const data = await fixture();
  const target = data.seedInventory.bindings.find((row) => row.logicalId === 'MA510');
  const boundary = spies({ ...data, foreignId: target.physicalId });
  const owner = makeOwner(data, boundary);
  await expectFailure(owner.inspectInTx(boundary.tx, boundary.ctx, { caseId: '12', clientId: boundary.clientId }), 'CASE12_CANONICAL_ITEM_BINDING_MISMATCH');
  assert.equal(boundary.calls.owner, 1);
});

test('current permission denial blocks inventory and is evaluated without denial metrics', async () => {
  const data = await fixture();
  const denied = data.seedInventory.bindings[0].physicalId;
  const boundary = spies({ ...data, deniedId: denied });
  const owner = makeOwner(data, boundary);
  await expectFailure(owner.inspectInTx(boundary.tx, boundary.ctx, { caseId: '12', clientId: boundary.clientId }), 'CASE12_CURRENT_READ_DENIED');
  assert.equal(boundary.calls.auth, 1);
  assert.equal(boundary.calls.item, 0);
});

test('changed canonical item row version is rejected', async () => {
  const data = await fixture();
  const changed = data.seedInventory.bindings[0].physicalId;
  const boundary = spies({ ...data, changedItemRowVersionId: changed });
  const owner = makeOwner(data, boundary);
  await expectFailure(owner.inspectInTx(boundary.tx, boundary.ctx, { caseId: '12', clientId: boundary.clientId }), 'CASE12_CANONICAL_ITEM_BINDING_MISMATCH');
});

test('retired canonical item is not treated as approved current owner', async () => {
  const data = await fixture();
  const boundary = spies(data);
  const original = boundary.tx.$queryRawUnsafe;
  boundary.tx.$queryRawUnsafe = async (sql, ...args) => {
    const rows = await original(sql, ...args);
    if (sql.includes('FROM memory_items') && !sql.includes('COUNT(DISTINCT')) rows[0].status = 'revoked';
    return rows;
  };
  const owner = makeOwner(data, boundary);
  await expectFailure(owner.inspectInTx(boundary.tx, boundary.ctx, { caseId: '12', clientId: boundary.clientId }), 'CASE12_CANONICAL_ITEM_BINDING_MISMATCH');
});

test('fewer than 500 strictly newer rows blocks age claim; timestamp ties do not count', async () => {
  const data = await fixture();
  const boundary = spies({ ...data, newer: 499 });
  const owner = makeOwner(data, boundary);
  await expectFailure(owner.inspectInTx(boundary.tx, boundary.ctx, { caseId: '12', clientId: boundary.clientId }), 'CASE12_500_NEWER_PERMITTED_ROWS_NOT_VERIFIED');
  assert.equal(boundary.calls.newer, 1);
});

test('caller mutation after construction cannot alter snapshotted manifest or seed', async () => {
  const data = await fixture();
  const boundary = spies(data);
  const owner = makeOwner(data, boundary);
  data.manifest.clients.ASTER.physicalId = id();
  data.seedInventory.bindings[0].physicalId = id();
  const result = await owner.inspectInTx(boundary.tx, boundary.ctx, { caseId: '12', clientId: boundary.clientId });
  assert.equal(result.inventoryVerified, true);
  assert.equal(result.observations.length, 510);
});

test('owner exposes no seed, write, capture, provider or readiness-authority entrypoint', async () => {
  const data = await fixture();
  const boundary = spies(data);
  const owner = makeOwner(data, boundary);
  assert.deepEqual(Object.keys(owner), ['inspectInTx']);
  assert.equal('createDataset' in owner, false);
  assert.equal('approve' in owner, false);
  assert.equal('seed' in owner, false);
  assert.equal('capture' in owner, false);
  assert.equal('search' in owner, false);
  assert.equal('provider' in owner, false);
});

test('arbitrary seed receipt alone is not accepted as current owner proof', async () => {
  const data = await fixture();
  const boundary = spies(data);
  const owner = makeOwner(data, boundary);
  const altered = structuredClone(data.seedInventory);
  altered.bindings[0].candidateRowVersion = '999';
  altered.bindingsSha256 = sha256Stable(altered.bindings);
  assert.throws(() => createCase12MemoryInventoryOwner({
    manifest: data.manifest,
    seedInventory: altered,
    proposerForTenant: boundary.proposerForTenant,
    assertSyntheticApprovedMemoryInTx: boundary.owner,
    memoryAuthorization: boundary.memoryAuthorization,
  }), (error) => error?.code === 'CASE12_SEED_BINDING_MISMATCH');
  assert.equal(boundary.calls.owner, 0);
  assert.equal(boundary.calls.auth, 0);
  assert.equal(typeof owner.inspectInTx, 'function');
});

// Keep imports exercised as real-source contract dependencies, not static text assertions.
assert.equal(typeof sha256Stable, 'function');
assert.equal(typeof stableJson, 'function');
