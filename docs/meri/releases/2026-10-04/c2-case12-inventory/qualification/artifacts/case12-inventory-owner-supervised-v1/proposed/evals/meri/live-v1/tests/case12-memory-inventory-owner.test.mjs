import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildFixtureManifest } from '../fixture-provisioning/manifest.mjs';
import { approvedMemoryDefinitions } from '../fixture-provisioning/approved-memory-runtime.mjs';
import {
  createCase12MemoryInventoryOwner,
  CASE12_SEED_RECEIPT_KIND,
} from '../fixture-provisioning/case12-memory-inventory-owner.mjs';
import { expectedMemoryCandidatePayload } from '../fixture-provisioning/memory-candidate-owner.mjs';
import { sha256Stable, stableJson } from '../lib/stable.mjs';

const INSTANCE = 'c924e861-06e5-4f26-a1b1-a7fc70840b35';
const id = () => randomUUID();

async function fixture(count = 509) {
  const manifest = structuredClone(
    await buildFixtureManifest({
      fixtureInstanceId: INSTANCE,
      clients: {
        ASTER: { tenantId: 'T1', physicalId: id() },
        BLUEHAVEN: { tenantId: 'T1', physicalId: id() },
        CEDAR: { tenantId: 'T2', physicalId: id() },
      },
      actors: { PAT: { tenantId: 'T1', physicalId: id() } },
    }),
  );
  const definitions = approvedMemoryDefinitions(manifest, { distractorCount: count });
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
    liveAcceptance: 'NOT_RUN',
  };
  return { manifest, definitions, seedInventory };
}

function spies(input) {
  const {
    manifest,
    definitions,
    seedInventory,
    newer = input.seedInventory.bindings.length - 1,
    deniedId,
    changedVersionId,
    foreignId,
    membershipRole = 'standard_user',
  } = structuredClone(input);
  const tenantId = manifest.tenants.T1.id;
  const clientId = manifest.clients.ASTER.physicalId;
  const byCandidate = new Map(seedInventory.bindings.map((row) => [row.candidateId, row]));
  const byItem = new Map(seedInventory.bindings.map((row) => [row.physicalId, row]));
  const calls = { membership: 0, candidate: 0, item: 0, newer: 0, owner: 0, load: 0, auth: 0 };
  const tx = {};
  // Capture stable proposer by call so the candidate query and helper share it.
  let proposerId;
  const stableProposer = async (value) => {
    assert.equal(value, tenantId);
    return (proposerId ??= id());
  };
  tx.$queryRawUnsafe = async (sql, ...args) => {
    assert.match(sql.trim(), /^SELECT/u);
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
      assert.match(sql, /updated_at\s*>\s*\(SELECT updated_at/u);
      assert.match(sql, /created_at\s*>\s*\(SELECT created_at/u);
      assert.match(sql, /id<>\$4::uuid/u);
      return [{ count: String(newer) }];
    }
    if (sql.includes('FROM memory_items')) {
      calls.item++;
      const itemId = args[0];
      const row = byItem.get(itemId);
      if (!row) return [];
      return [
        {
          id: itemId,
          tenant_id: foreignId === itemId ? id() : tenantId,
          client_id: clientId,
          status: 'active',
          source_version:
            changedVersionId === itemId ? 'unexpected-v9' : `candidate:${row.candidateId}`,
          source_content_hash: 'a'.repeat(64),
          sections_jsonb: [{ key: 'memory', body: `unit:${row.logicalId}` }],
          row_version: row.itemRowVersion,
          created_at: '2040-01-01T00:00:00.000001Z',
          updated_at: '2040-01-02T00:00:00.000001Z',
        },
      ];
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };
  const owner = async (txArg, ctx, candidateId, guard) => {
    calls.owner++;
    const row = byItem.get(candidateId);
    assert.ok(row);
    assert.equal(guard.expectedRowVersion, row.candidateRowVersion);
    assert.equal(guard.expectedItemRowVersion, row.itemRowVersion);
    assert.deepEqual(
      guard.expectedPayload,
      (
        await import('../fixture-provisioning/memory-candidate-owner.mjs')
      ).expectedMemoryCandidatePayload(
        definitions.find((entry) => entry.logicalId === row.logicalId).candidate,
        proposerId,
        stableJson({
          ownership: definitions.find((entry) => entry.logicalId === row.logicalId).candidate
            .ownership,
          payload: definitions.find((entry) => entry.logicalId === row.logicalId).candidate.payload,
        }),
      ),
    );
    return {
      syntheticFixtureCandidateId: row.candidateId,
      syntheticFixtureMarkerSha256: row.ownershipMarkerSha256,
      syntheticFixtureCandidateRowVersion: row.candidateRowVersion,
      syntheticFixtureItemRowVersion: row.itemRowVersion,
    };
  };
  const memoryAuthorization = {
    async loadItemInTx(txArg, actualTenant, itemId) {
      calls.load++;
      assert.equal(actualTenant, tenantId);
      assert.ok(byItem.has(itemId));
      return { id: itemId, tenantId: actualTenant, clientId, status: 'active' };
    },
    async evaluateInTx(txArg, ctx, subject, action, options) {
      calls.auth++;
      assert.equal(action, 'read');
      assert.deepEqual(options, { emitDenialMetrics: false });
      return { allowed: subject.id !== deniedId };
    },
  };
  return {
    tx,
    calls,
    proposerForTenant: stableProposer,
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
  const result = await owner.inspectInTx(boundary.tx, boundary.ctx, {
    caseId: '12',
    clientId: boundary.clientId,
  });
  assert.equal(result.inventoryVerified, true);
  assert.equal(result.fixtureReady, false);
  assert.equal(result.captureAuthority, false);
  assert.equal(result.liveAcceptance, 'NOT_RUN');
  assert.equal(result.retrievalEligibility, 'RETRIEVAL_ELIGIBILITY_NOT_QUALIFIED');
  assert.equal(result.olderThan500PermittedOwnerRowsVerified, true);
  assert.equal(result.observations.length, 510);
  for (const key of ['owner', 'load', 'auth', 'item', 'candidate'])
    assert.equal(boundary.calls[key], 510);
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
  const result = await owner.inspectInTx(boundary.tx, boundary.ctx, {
    caseId: '12',
    clientId: boundary.clientId,
  });
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
  const result = await owner.inspectInTx(boundary.tx, boundary.ctx, {
    caseId: '12',
    clientId: boundary.clientId,
  });
  assert.ok(result.missing.includes('EXACT_FIXTURE_MANIFEST_MISSING'));
  assert.equal(boundary.calls.membership, 0);
});

test('malformed manifest content hash rejects before inspection', async () => {
  const data = await fixture();
  data.manifest.contentSha256 = '0'.repeat(64);
  const boundary = spies(data);
  assert.throws(
    () => makeOwner(data, boundary),
    (error) => error?.code === 'MANIFEST_HASH_MISMATCH',
  );
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
  assert.throws(
    () => makeOwner(data, boundary),
    (error) => error?.code === 'CASE12_EXACT_FIXTURE_INSTANCE_ID_REQUIRED',
  );
});

test('receipt hash or manifest binding mismatch rejects supplied seed evidence', async () => {
  const data = await fixture();
  data.seedInventory.bindingsSha256 = 'f'.repeat(64);
  const boundary = spies(data);
  assert.throws(
    () => makeOwner(data, boundary),
    (error) => error?.code === 'CASE12_SEED_RECEIPT_INVALID',
  );
});

test('duplicate logical id is rejected even with rehashed receipt', async () => {
  const data = await fixture();
  data.seedInventory.bindings[1].logicalId = data.seedInventory.bindings[0].logicalId;
  data.seedInventory.bindingsSha256 = sha256Stable(data.seedInventory.bindings);
  const boundary = spies(data);
  assert.throws(
    () => makeOwner(data, boundary),
    (error) => error?.code === 'CASE12_DUPLICATE_LOGICAL_ID',
  );
});

test('duplicate actual physical item id is rejected', async () => {
  const data = await fixture();
  data.seedInventory.bindings[1].physicalId = data.seedInventory.bindings[0].physicalId;
  data.seedInventory.bindingsSha256 = sha256Stable(data.seedInventory.bindings);
  const boundary = spies(data);
  assert.throws(
    () => makeOwner(data, boundary),
    (error) => error?.code === 'CASE12_DUPLICATE_PHYSICAL_ID',
  );
});

test('missing MA510 or distractor rejects complete inventory', async () => {
  for (const missingId of ['MA510', 'MA510-DISTRACTOR-0001']) {
    const data = await fixture();
    data.seedInventory.bindings = data.seedInventory.bindings.filter(
      (row) => row.logicalId !== missingId,
    );
    data.seedInventory.bindingsSha256 = sha256Stable(data.seedInventory.bindings);
    const boundary = spies(data);
    assert.throws(
      () => makeOwner(data, boundary),
      (error) => error?.code === 'CASE12_SEED_INVENTORY_MISMATCH',
    );
  }
});

test('unknown row fields and caller-claimed eligibility flags are refused', async () => {
  const data = await fixture();
  data.seedInventory.bindings[0].eligible = true;
  data.seedInventory.bindingsSha256 = sha256Stable(data.seedInventory.bindings);
  const boundary = spies(data);
  assert.throws(
    () => makeOwner(data, boundary),
    (error) => error?.code === 'CASE12_BINDING_UNKNOWN_FIELDS',
  );
});

test('altered marker binding is rejected before any database call', async () => {
  const data = await fixture();
  data.seedInventory.bindings[0].ownershipMarkerSha256 = 'b'.repeat(64);
  data.seedInventory.bindingsSha256 = sha256Stable(data.seedInventory.bindings);
  const boundary = spies(data);
  assert.throws(
    () => makeOwner(data, boundary),
    (error) => error?.code === 'CASE12_SEED_BINDING_MISMATCH',
  );
  assert.equal(boundary.calls.membership, 0);
});

test('proposed rather than allocated physical ID is refused', async () => {
  const data = await fixture();
  const entry = data.definitions.find((row) => row.proposedItemId);
  const binding = data.seedInventory.bindings.find((row) => row.logicalId === entry.logicalId);
  binding.physicalId = entry.proposedItemId;
  data.seedInventory.bindingsSha256 = sha256Stable(data.seedInventory.bindings);
  const boundary = spies(data);
  assert.throws(
    () => makeOwner(data, boundary),
    (error) => error?.code === 'CASE12_SEED_BINDING_MISMATCH',
  );
});

test('wrong case, tenant, client, actor role and reviewer role cannot inspect', async () => {
  const data = await fixture();
  const boundary = spies(data);
  const owner = makeOwner(data, boundary);
  await expectFailure(
    owner.inspectInTx(boundary.tx, boundary.ctx, { caseId: '01', clientId: boundary.clientId }),
    'CASE12_ONLY',
  );
  await expectFailure(
    owner.inspectInTx(
      boundary.tx,
      { ...boundary.ctx, tenantId: id() },
      { caseId: '12', clientId: boundary.clientId },
    ),
    'CASE12_ORDINARY_ACTOR_SCOPE_MISMATCH',
  );
  await expectFailure(
    owner.inspectInTx(boundary.tx, boundary.ctx, { caseId: '12', clientId: id() }),
    'CASE12_ORDINARY_ACTOR_SCOPE_MISMATCH',
  );
  await expectFailure(
    owner.inspectInTx(
      boundary.tx,
      { ...boundary.ctx, role: 'institutional_memory_reviewer' },
      { caseId: '12', clientId: boundary.clientId },
    ),
    'CASE12_ORDINARY_ACTOR_SCOPE_MISMATCH',
  );
  assert.equal(boundary.calls.membership, 0);
});

test('active ordinary membership must match actor context', async () => {
  const data = await fixture();
  const boundary = spies({ ...data, membershipRole: 'user_admin' });
  const owner = makeOwner(data, boundary);
  await expectFailure(
    owner.inspectInTx(boundary.tx, boundary.ctx, { caseId: '12', clientId: boundary.clientId }),
    'CASE12_ORDINARY_ACTOR_MEMBERSHIP_INVALID',
  );
  assert.equal(boundary.calls.candidate, 0);
});

test('foreign canonical tenant row is refused with no partial inventory result', async () => {
  const data = await fixture();
  const target = data.seedInventory.bindings.find((row) => row.logicalId === 'MA510');
  const boundary = spies({ ...data, foreignId: target.physicalId });
  const owner = makeOwner(data, boundary);
  await expectFailure(
    owner.inspectInTx(boundary.tx, boundary.ctx, { caseId: '12', clientId: boundary.clientId }),
    'CASE12_CANONICAL_ITEM_BINDING_MISMATCH',
  );
  assert.equal(boundary.calls.owner, 1);
});

test('current permission denial blocks inventory and is evaluated without denial metrics', async () => {
  const data = await fixture();
  const denied = data.seedInventory.bindings[0].physicalId;
  const boundary = spies({ ...data, deniedId: denied });
  const owner = makeOwner(data, boundary);
  await expectFailure(
    owner.inspectInTx(boundary.tx, boundary.ctx, { caseId: '12', clientId: boundary.clientId }),
    'CASE12_CURRENT_READ_DENIED',
  );
  assert.equal(boundary.calls.auth, 1);
  assert.equal(boundary.calls.item, 0);
});

test('changed source row version and source identity are rejected', async () => {
  const data = await fixture();
  const changed = data.seedInventory.bindings[0].physicalId;
  const boundary = spies({ ...data, changedVersionId: changed });
  const owner = makeOwner(data, boundary);
  await expectFailure(
    owner.inspectInTx(boundary.tx, boundary.ctx, { caseId: '12', clientId: boundary.clientId }),
    'CASE12_CANONICAL_ITEM_BINDING_MISMATCH',
  );
});

test('retired canonical item is not treated as approved current owner', async () => {
  const data = await fixture();
  const boundary = spies(data);
  const original = boundary.tx.$queryRawUnsafe;
  boundary.tx.$queryRawUnsafe = async (sql, ...args) => {
    const rows = await original(sql, ...args);
    if (sql.includes('FROM memory_items') && !sql.includes('COUNT(DISTINCT'))
      rows[0].status = 'revoked';
    return rows;
  };
  const owner = makeOwner(data, boundary);
  await expectFailure(
    owner.inspectInTx(boundary.tx, boundary.ctx, { caseId: '12', clientId: boundary.clientId }),
    'CASE12_CANONICAL_ITEM_BINDING_MISMATCH',
  );
});

test('fewer than 500 strictly newer rows blocks age claim; timestamp ties do not count', async () => {
  const data = await fixture();
  const boundary = spies({ ...data, newer: 499 });
  const owner = makeOwner(data, boundary);
  await expectFailure(
    owner.inspectInTx(boundary.tx, boundary.ctx, { caseId: '12', clientId: boundary.clientId }),
    'CASE12_500_NEWER_PERMITTED_ROWS_NOT_VERIFIED',
  );
  assert.equal(boundary.calls.newer, 1);
});

test('caller mutation after construction cannot alter snapshotted manifest or seed', async () => {
  const data = await fixture();
  const boundary = spies(data);
  const owner = makeOwner(data, boundary);
  data.manifest.clients.ASTER.physicalId = id();
  data.seedInventory.bindings[0].physicalId = id();
  const result = await owner.inspectInTx(boundary.tx, boundary.ctx, {
    caseId: '12',
    clientId: boundary.clientId,
  });
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
  const staleOwner = createCase12MemoryInventoryOwner({
    manifest: data.manifest,
    seedInventory: altered,
    proposerForTenant: boundary.proposerForTenant,
    assertSyntheticApprovedMemoryInTx: boundary.owner,
    memoryAuthorization: boundary.memoryAuthorization,
  });
  await expectFailure(
    staleOwner.inspectInTx(boundary.tx, boundary.ctx, {
      caseId: '12',
      clientId: boundary.clientId,
    }),
    'CASE12_CANDIDATE_OWNER_OR_VERSION_CHANGED',
  );
  assert.equal(boundary.calls.owner, 0);
  assert.equal(boundary.calls.auth, 0);
  assert.equal(typeof owner.inspectInTx, 'function');
});

// Keep imports exercised as real-source contract dependencies, not static text assertions.
assert.equal(typeof sha256Stable, 'function');
assert.equal(typeof stableJson, 'function');

for (const count of [500, 600])
  test(`accepts exact native receipt for ${count} defined distractors only as inventory`, async () => {
    const data = await fixture(count),
      b = spies(data);
    const r = await makeOwner(data, b).inspectInTx(b.tx, b.ctx, {
      caseId: '12',
      clientId: b.clientId,
    });
    assert.equal(r.observations.length, count + 1);
    assert.equal(r.newerPermittedAsterRecordCount, count);
    assert.equal(r.fixtureReady, false);
    assert.equal(r.captureAuthority, false);
  });
test('requires the native receipt NOT_RUN boundary, even if the receipt otherwise hashes', async () => {
  const d = await fixture(),
    b = spies(d);
  d.seedInventory.liveAcceptance = 'PASS';
  assert.throws(() => makeOwner(d, b), { code: 'CASE12_SEED_RECEIPT_INVALID' });
});
test('malformed seed cannot hide behind a missing manifest', async () => {
  const d = await fixture(),
    b = spies(d);
  d.seedInventory.bindingsSha256 = 'f'.repeat(64);
  assert.throws(
    () =>
      createCase12MemoryInventoryOwner({
        seedInventory: d.seedInventory,
        proposerForTenant: b.proposerForTenant,
        assertSyntheticApprovedMemoryInTx: b.owner,
        memoryAuthorization: b.memoryAuthorization,
      }),
    { code: 'CASE12_SEED_RECEIPT_INVALID' },
  );
});
test('all four native canonical proof fields must join, not just candidate row version', async () => {
  for (const field of [
    'syntheticFixtureCandidateId',
    'syntheticFixtureMarkerSha256',
    'syntheticFixtureCandidateRowVersion',
    'syntheticFixtureItemRowVersion',
  ]) {
    const d = await fixture(),
      b = spies(d),
      original = b.owner;
    b.owner = async (...args) => {
      const proof = await original(...args);
      delete proof[field];
      return proof;
    };
    await expectFailure(
      makeOwner(d, b).inspectInTx(b.tx, b.ctx, { caseId: '12', clientId: b.clientId }),
      'CASE12_CANONICAL_APPROVAL_OWNER_MISMATCH',
    );
    assert.equal(b.calls.auth, 0);
  }
});
test('canonical helper rejection is not converted to a partial positive receipt', async () => {
  const d = await fixture(),
    b = spies(d);
  b.owner = () => {
    throw Object.assign(new Error('denied'), { code: 'NATIVE_OWNER_DENIED' });
  };
  await expectFailure(
    makeOwner(d, b).inspectInTx(b.tx, b.ctx, { caseId: '12', clientId: b.clientId }),
    'NATIVE_OWNER_DENIED',
  );
  assert.equal(b.calls.auth, 0);
});
test('foreign authorization subjects are rejected before evaluating read permission', async () => {
  for (const field of ['id', 'tenantId', 'clientId', 'status']) {
    const d = await fixture(),
      b = spies(d),
      load = b.memoryAuthorization.loadItemInTx;
    b.memoryAuthorization.loadItemInTx = async (...args) => ({
      ...(await load(...args)),
      [field]: 'foreign',
    });
    await expectFailure(
      makeOwner(d, b).inspectInTx(b.tx, b.ctx, { caseId: '12', clientId: b.clientId }),
      'CASE12_CURRENT_READ_DENIED',
    );
    assert.equal(b.calls.auth, 0);
  }
});
test('caller context mutation and replaced auth methods cannot change an in-flight inspection', async () => {
  const d = await fixture(),
    b = spies(d),
    owner = makeOwner(d, b),
    sql = b.tx.$queryRawUnsafe;
  const originalUser = b.ctx.userId;
  b.tx.$queryRawUnsafe = async (...args) => {
    const r = await sql(...args);
    b.ctx.userId = id();
    return r;
  };
  b.memoryAuthorization.evaluateInTx = () => {
    throw new Error('replaced');
  };
  const r = await owner.inspectInTx(b.tx, b.ctx, { caseId: '12', clientId: b.clientId });
  assert.equal(r.actorUserId, originalUser);
});
test('a different ordinary user cannot substitute for manifest Pat', async () => {
  const d = await fixture(),
    b = spies(d);
  b.ctx.userId = id();
  await expectFailure(
    makeOwner(d, b).inspectInTx(b.tx, b.ctx, { caseId: '12', clientId: b.clientId }),
    'CASE12_ORDINARY_ACTOR_SCOPE_MISMATCH',
  );
  assert.equal(b.calls.membership, 0);
});
test('row versions outside PostgreSQL xid range reject before any native read', async () => {
  const d = await fixture(),
    b = spies(d);
  d.seedInventory.bindings[0].itemRowVersion = '4294967296';
  d.seedInventory.bindingsSha256 = sha256Stable(d.seedInventory.bindings);
  assert.throws(() => makeOwner(d, b), { code: 'CASE12_SEED_BINDING_MISMATCH' });
  assert.equal(b.calls.membership, 0);
});
test('missing actual canonical row cannot be reported as inspected', async () => {
  const d = await fixture(),
    b = spies(d),
    sql = b.tx.$queryRawUnsafe;
  b.tx.$queryRawUnsafe = async (text, ...args) =>
    text.includes('FROM memory_items') && !text.includes('COUNT(DISTINCT')
      ? []
      : sql(text, ...args);
  await expectFailure(
    makeOwner(d, b).inspectInTx(b.tx, b.ctx, { caseId: '12', clientId: b.clientId }),
    'CASE12_CANONICAL_ITEM_BINDING_MISMATCH',
  );
});
test('impossible or fractional newer count is refused', async () => {
  for (const newer of [510, 500.5, NaN]) {
    const d = await fixture(),
      b = spies({ ...d, newer });
    await expectFailure(
      makeOwner(d, b).inspectInTx(b.tx, b.ctx, { caseId: '12', clientId: b.clientId }),
      'CASE12_500_NEWER_PERMITTED_ROWS_NOT_VERIFIED',
    );
  }
});
