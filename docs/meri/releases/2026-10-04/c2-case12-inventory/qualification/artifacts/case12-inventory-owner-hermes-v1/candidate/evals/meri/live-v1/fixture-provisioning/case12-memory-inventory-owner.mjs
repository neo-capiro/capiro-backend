import { sha256Stable, stableJson } from '../lib/stable.mjs';
import { assertManifest } from './manifest.mjs';
import { approvedMemoryDefinitions } from './approved-memory-runtime.mjs';
import { expectedMemoryCandidatePayload } from './memory-candidate-owner.mjs';
import { FixtureProvisioningError } from './contract.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;
const RECEIPT_KIND = 'meri-approved-memory-local-bindings';
const ORDINARY_ROLES = new Set(['standard_user']);
const fail = (code, details) => {
  throw new FixtureProvisioningError(code, details ?? code);
};

function exactKeys(value, allowed, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.has(key))) fail(code);
}

function validRowVersion(value) {
  return typeof value === 'string' && /^[0-9]{1,10}$/u.test(value);
}

function resultBase(missing) {
  return {
    caseId: '12',
    fixtureReady: false,
    captureAuthority: false,
    inventoryVerified: false,
    olderThan500PermittedOwnerRowsVerified: false,
    retrievalEligibility: 'RETRIEVAL_ELIGIBILITY_NOT_QUALIFIED',
    liveAcceptance: 'NOT_RUN',
    observations: [],
    missing,
  };
}

function validateSeedEnvelope(seedInventory) {
  exactKeys(seedInventory, new Set(['kind', 'fixtureMapSha256', 'bindings', 'bindingsSha256']), 'CASE12_SEED_UNKNOWN_FIELDS');
  if (seedInventory.kind !== RECEIPT_KIND ||
      !SHA256.test(seedInventory.fixtureMapSha256 ?? '') ||
      !Array.isArray(seedInventory.bindings) ||
      seedInventory.bindingsSha256 !== sha256Stable(seedInventory.bindings)) {
    fail('CASE12_SEED_RECEIPT_INVALID');
  }
}

function validateSeed(seedInventory, manifest, definitions) {
  validateSeedEnvelope(seedInventory);
  if (seedInventory.fixtureMapSha256 !== manifest.contentSha256) {
    fail('CASE12_SEED_RECEIPT_INVALID');
  }
  const expectedIds = [...definitions.keys()].sort();
  const bindings = seedInventory.bindings;
  if (bindings.length !== expectedIds.length) fail('CASE12_SEED_INVENTORY_MISMATCH');
  const byLogicalId = new Map();
  const physicalIds = new Set();
  const candidateIds = new Set();
  for (const binding of bindings) {
    exactKeys(binding, new Set([
      'logicalId', 'supporting', 'owner', 'tenantId', 'clientId', 'physicalId',
      'proposedItemId', 'candidateId', 'ownershipMarkerSha256', 'candidatePayloadSha256',
      'candidateRowVersion', 'itemRowVersion', 'lifecycle',
    ]), 'CASE12_BINDING_UNKNOWN_FIELDS');
    if (typeof binding.logicalId !== 'string' || byLogicalId.has(binding.logicalId))
      fail('CASE12_DUPLICATE_LOGICAL_ID');
    const definition = definitions.get(binding.logicalId);
    if (!definition) fail('CASE12_SEED_INVENTORY_MISMATCH');
    const candidate = definition.candidate;
    if (binding.owner !== 'memory_item' || binding.lifecycle !== 'approved' ||
        binding.supporting !== definition.supporting ||
        binding.tenantId !== candidate.tenantId ||
        binding.clientId !== candidate.clientPhysicalId ||
        binding.candidateId !== candidate.physicalId ||
        binding.proposedItemId !== definition.proposedItemId ||
        binding.ownershipMarkerSha256 !== candidate.ownership.markerSha256 ||
        binding.candidatePayloadSha256 !== candidate.payloadSha256 ||
        !UUID.test(binding.physicalId ?? '') ||
        binding.physicalId === candidate.physicalId ||
        binding.physicalId === definition.proposedItemId ||
        !validRowVersion(binding.candidateRowVersion) ||
        !validRowVersion(binding.itemRowVersion)) {
      fail('CASE12_SEED_BINDING_MISMATCH', binding.logicalId);
    }
    if (physicalIds.has(binding.physicalId) || candidateIds.has(binding.candidateId))
      fail('CASE12_DUPLICATE_PHYSICAL_ID');
    physicalIds.add(binding.physicalId);
    candidateIds.add(binding.candidateId);
    byLogicalId.set(binding.logicalId, binding);
  }
  if (JSON.stringify([...byLogicalId.keys()].sort()) !== JSON.stringify(expectedIds) ||
      !byLogicalId.has('MA510')) fail('CASE12_SEED_INVENTORY_MISMATCH');
  return byLogicalId;
}

/**
 * Local, read-only Case12 inventory owner. Dependencies are private application
 * service composition inputs, never JSON/RPC authority. The seed receipt locates
 * current rows only; native canonical guards and current authorization prove them.
 */
export function createCase12MemoryInventoryOwner({
  manifest,
  seedInventory,
  proposerForTenant,
  assertSyntheticApprovedMemoryInTx,
  memoryAuthorization,
} = {}) {
  // Clone before validation or asynchronous composition so later caller mutation
  // cannot replace manifest/seed bindings underneath the owner.
  const snapshotManifest = manifest === undefined ? undefined : structuredClone(manifest);
  const snapshotSeed = seedInventory === undefined ? undefined : structuredClone(seedInventory);
  const prerequisitesMissing = [];
  let definitionsById = null;
  let bindingsById = null;

  if (snapshotManifest === undefined) prerequisitesMissing.push('EXACT_FIXTURE_MANIFEST_MISSING');
  else {
    assertManifest(snapshotManifest);
    if (typeof snapshotManifest.fixtureInstanceId !== 'string' || !snapshotManifest.fixtureInstanceId)
      fail('CASE12_EXACT_FIXTURE_INSTANCE_ID_REQUIRED');
    definitionsById = new Map(approvedMemoryDefinitions(snapshotManifest).map((entry) => [entry.logicalId, entry]));
  }
  if (snapshotSeed === undefined) prerequisitesMissing.push('EXACT_ORIGINAL_SEED_INVENTORY_MISSING');
  else {
    validateSeedEnvelope(snapshotSeed);
    if (definitionsById) bindingsById = validateSeed(snapshotSeed, snapshotManifest, definitionsById);
  }

  if (typeof proposerForTenant !== 'function' ||
      typeof assertSyntheticApprovedMemoryInTx !== 'function' ||
      typeof memoryAuthorization?.loadItemInTx !== 'function' ||
      typeof memoryAuthorization?.evaluateInTx !== 'function') {
    fail('CASE12_CANONICAL_INSPECTION_HELPERS_INCOMPLETE');
  }

  const inspectInTx = async (tx, ctx, { caseId, clientId } = {}) => {
    if (caseId !== '12') fail('CASE12_ONLY');
    if (prerequisitesMissing.length) return resultBase([...prerequisitesMissing]);
    if (!tx || typeof tx.$queryRawUnsafe !== 'function') fail('CASE12_TRANSACTION_REQUIRED');
    const client = snapshotManifest.clients?.ASTER;
    const tenantId = snapshotManifest.tenants?.T1?.id;
    const tenantKey = snapshotManifest.clients?.ASTER?.tenantId;
    const ordinaryPatId = snapshotManifest.actors?.PAT?.physicalId ?? snapshotManifest.actors?.PAT?.userId;
    if (!client || tenantKey !== 'T1' || !tenantId || client.tenantId !== 'T1' ||
        client.physicalId !== clientId ||
        ctx?.tenantId !== tenantId || typeof ctx?.userId !== 'string' ||
        !UUID.test(ctx.userId) || ctx.userId !== ordinaryPatId || !ORDINARY_ROLES.has(ctx.role)) {
      fail('CASE12_ORDINARY_ACTOR_SCOPE_MISMATCH');
    }

    const membership = await tx.$queryRawUnsafe(
      `SELECT tm.user_id::text AS user_id, tm.role::text AS role
       FROM tenant_memberships tm JOIN tenants t ON t.id=tm.tenant_id
       WHERE tm.tenant_id=$1::uuid AND tm.user_id=$2::uuid AND tm.status='active'
         AND t.slug=$3`,
      tenantId, ctx.userId, snapshotManifest.tenants.T1.slug,
    );
    if (membership.length !== 1 || membership[0].user_id !== ctx.userId ||
        !ORDINARY_ROLES.has(membership[0].role) || membership[0].role !== ctx.role) {
      fail('CASE12_ORDINARY_ACTOR_MEMBERSHIP_INVALID');
    }

    const orderedDefinitions = [...definitionsById.values()];
    const observations = [];
    for (const definition of orderedDefinitions) {
      const logicalId = definition.logicalId;
      const candidate = definition.candidate;
      const seeded = bindingsById.get(logicalId);
      if (!seeded || seeded.tenantId !== tenantId || seeded.clientId !== clientId ||
          candidate.tenantId !== tenantId || candidate.clientPhysicalId !== clientId) {
        fail('CASE12_SEED_SCOPE_MISMATCH', logicalId);
      }
      const proposerId = await proposerForTenant(tenantId);
      if (!UUID.test(proposerId ?? '')) fail('CASE12_PROPOSER_ID_INVALID', logicalId);
      const proposers = await tx.$queryRawUnsafe(
        `SELECT proposed_by::text AS proposed_by FROM memory_candidate
         WHERE tenant_id=$1::uuid AND id=$2::uuid AND proposed_by=$3::uuid
           AND xmin::text=$4 FOR UPDATE`,
        tenantId, seeded.candidateId, proposerId, seeded.candidateRowVersion,
      );
      if (proposers.length !== 1 || proposers[0].proposed_by !== proposerId)
        fail('CASE12_CANDIDATE_OWNER_OR_VERSION_CHANGED', logicalId);
      const guard = {
        candidateId: candidate.physicalId,
        expectedRowVersion: seeded.candidateRowVersion,
        expectedItemRowVersion: seeded.itemRowVersion,
        expectedPayload: expectedMemoryCandidatePayload(
          candidate, proposerId,
          stableJson({ ownership: candidate.ownership, payload: candidate.payload }),
        ),
      };
      const ownership = await assertSyntheticApprovedMemoryInTx(tx, ctx, seeded.physicalId, guard);
      if (!ownership || ownership.syntheticFixtureCandidateRowVersion !== seeded.candidateRowVersion ||
          (ownership.itemId !== undefined && ownership.itemId !== seeded.physicalId) ||
          (ownership.status !== undefined && ownership.status !== 'active') ||
          (ownership.governedStatus !== undefined && ownership.governedStatus !== 'active')) {
        fail('CASE12_CANONICAL_APPROVAL_OWNER_MISMATCH', logicalId);
      }
      const subject = await memoryAuthorization.loadItemInTx(tx, tenantId, seeded.physicalId);
      if (!subject || (await memoryAuthorization.evaluateInTx(tx, ctx, subject, 'read', {
        emitDenialMetrics: false,
      }))?.allowed !== true) fail('CASE12_CURRENT_READ_DENIED', logicalId);

      // Select by physical id, then verify actual returned scope. The transaction
      // and established owner helpers may lock rows; no READ ONLY mode is imposed.
      const actualRows = await tx.$queryRawUnsafe(
        `SELECT id::text AS id, tenant_id::text AS tenant_id, client_id::text AS client_id,
                status, source_version, source_content_hash, sections_jsonb,
                xmin::text AS row_version, created_at, updated_at
         FROM memory_items WHERE id=$1::uuid FOR UPDATE`,
        seeded.physicalId,
      );
      const item = actualRows[0];
      if (actualRows.length !== 1 || item.id !== seeded.physicalId || item.tenant_id !== tenantId ||
          item.client_id !== clientId || item.status !== 'active' ||
          item.row_version !== seeded.itemRowVersion ||
          typeof item.source_version !== 'string' || !item.source_version ||
          typeof item.source_content_hash !== 'string' || !SHA256.test(item.source_content_hash) ||
          !item.sections_jsonb || typeof item.sections_jsonb !== 'object' ||
          !item.created_at || !item.updated_at) {
        fail('CASE12_CANONICAL_ITEM_BINDING_MISMATCH', logicalId);
      }
      observations.push({
        logicalId,
        physicalId: item.id,
        candidateId: seeded.candidateId,
        tenantId: item.tenant_id,
        clientId: item.client_id,
        candidateRowVersion: ownership.syntheticFixtureCandidateRowVersion,
        itemRowVersion: item.row_version,
        sourceVersion: item.source_version,
        sourceContentSha256: item.source_content_hash,
        sectionsSha256: sha256Stable(item.sections_jsonb),
        ownershipMarkerSha256: candidate.ownership.markerSha256,
      });
    }

    const target = bindingsById.get('MA510');
    // Compare timestamps inside PostgreSQL (including microseconds), against the
    // exact canonical target. Require both updated_at and created_at to be newer;
    // ties do not count. Only individually owner-verified/permitted receipt IDs
    // are counted, and this does not qualify expiry/sensitivity/lifecycle policy.
    const newer = await tx.$queryRawUnsafe(
      `SELECT COUNT(DISTINCT inventory.id)::text AS count
       FROM memory_items AS inventory
       JOIN memory_items AS target ON target.id=$4::uuid AND target.tenant_id=$1::uuid
       WHERE inventory.tenant_id=$1::uuid AND inventory.client_id=$2::uuid
         AND inventory.status='active' AND inventory.id=ANY($3::uuid[])
         AND inventory.id<>target.id
         AND inventory.updated_at > target.updated_at
         AND inventory.created_at > target.created_at`,
      tenantId, clientId, [...bindingsById.values()].map((row) => row.physicalId), target.physicalId,
    );
    if (newer.length !== 1 || !/^[0-9]+$/u.test(newer[0].count ?? '') || Number(newer[0].count) < 500)
      fail('CASE12_500_NEWER_PERMITTED_ROWS_NOT_VERIFIED');

    return {
      ...resultBase(['RETRIEVAL_ELIGIBILITY_NOT_QUALIFIED', 'CASE12_CAPTURE_AND_LIVE_ACCEPTANCE_NOT_RUN']),
      inventoryVerified: true,
      olderThan500PermittedOwnerRowsVerified: true,
      newerPermittedAsterRecordCount: Number(newer[0].count),
      fixtureInstanceId: snapshotManifest.fixtureInstanceId,
      manifestContentSha256: snapshotManifest.contentSha256,
      seedInventorySha256: snapshotSeed.bindingsSha256,
      tenantId,
      actorUserId: ctx.userId,
      clientId,
      observations,
    };
  };
  return Object.freeze({ inspectInTx });
}

export { RECEIPT_KIND as CASE12_SEED_RECEIPT_KIND };
