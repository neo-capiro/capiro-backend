import { sha256Stable, stableJson } from '../lib/stable.mjs';
import { assertManifest } from './manifest.mjs';
import { FIXTURE_NAMESPACE, FixtureProvisioningError, ownedIdentity } from './contract.mjs';
import {
  createMemoryCandidateOwnerPort,
  expectedMemoryCandidatePayload,
} from './memory-candidate-owner.mjs';
import { createApprovedMemoryRetirementPort } from './approved-memory-retirement-owner.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const fail = (code, logicalId) => {
  throw new FixtureProvisioningError(code, logicalId);
};

function approvedCandidateDefinition(manifest, source, { logicalId, facts, supporting }) {
  const ownership = ownedIdentity(
    // Canonical synthetic candidate markers accept uppercase identifiers. Keep
    // the frozen logical source ID unchanged in sourceLogicalId and receipts.
    `APPROVED-${logicalId.toUpperCase()}`,
    source.tenantId,
    'memory_candidate',
    manifest.fixtureVersion,
    manifest.fixtureInstanceId,
  );
  const payload = {
    fixtureKind: 'approved_memory_fixture',
    facts,
    sourceAsset: null,
    sourceLogicalId: logicalId,
    supporting,
  };
  return {
    logicalId,
    supporting,
    proposedItemId: supporting ? null : source.physicalId,
    candidate: {
      ...source,
      logicalId: ownership.marker.logicalId,
      owner: 'memory_candidate',
      physicalId: ownership.physicalId,
      ownership,
      payload,
      payloadSha256: sha256Stable(payload),
    },
  };
}

/** A selected approved source is activated through the same canonical owner.
 * Logical names such as MA1-v2 are not proof of a physical supersession chain.
 * Non-approved frozen sources require separate lifecycle compositions.
 */
export function selectedApprovedMemoryDefinitions(manifest, sourceIds) {
  assertManifest(manifest);
  if (
    !Array.isArray(sourceIds) ||
    sourceIds.length < 1 ||
    sourceIds.length > 20 ||
    sourceIds.some((id) => typeof id !== 'string' || !id.trim()) ||
    new Set(sourceIds).size !== sourceIds.length
  )
    fail('APPROVED_MEMORY_SOURCE_SELECTION_INVALID', 'sourceIds');
  return sourceIds.map((logicalId) => {
    const source = manifest.records.find((record) => record.logicalId === logicalId);
    if (!source || source.owner !== 'memory_item' || source.payload.facts.lifecycle !== 'approved')
      fail('APPROVED_MEMORY_SOURCE_INVALID', logicalId);
    return approvedCandidateDefinition(manifest, source, {
      logicalId,
      facts: source.payload.facts,
      supporting: false,
    });
  });
}

/** Intermediate approvals for the exact frozen lifecycle fixtures only.
 * A returned approved binding is not the requested final superseded/revoked state.
 */
export function lifecycleSeedMemoryDefinitions(manifest, sourceIds) {
  assertManifest(manifest);
  const expected = { 'MA1-v1': 'superseded', MA3: 'revoked' };
  if (
    !Array.isArray(sourceIds) ||
    !sourceIds.length ||
    new Set(sourceIds).size !== sourceIds.length
  )
    fail('LIFECYCLE_MEMORY_SOURCE_SELECTION_INVALID', 'sourceIds');
  return sourceIds.map((logicalId) => {
    const source = manifest.records.find((row) => row.logicalId === logicalId);
    if (
      !Object.hasOwn(expected, logicalId) ||
      !source ||
      source.owner !== 'memory_item' ||
      source.payload.facts.lifecycle !== expected[logicalId]
    )
      fail('LIFECYCLE_MEMORY_SOURCE_INVALID', logicalId);
    return approvedCandidateDefinition(manifest, source, {
      logicalId,
      facts: source.payload.facts,
      supporting: false,
    });
  });
}

/**
 * This composition deliberately does not substitute the manifest's proposed
 * memory_item UUID for the UUID allocated by canonical approval. Its receipts
 * bind the frozen logical source to that actual item and its owned candidate.
 * They are local qualification evidence, never LIVE capture attestations.
 */
export function approvedMemoryDefinitions(manifest, { distractorCount = 509 } = {}) {
  assertManifest(manifest);
  if (!Number.isInteger(distractorCount) || distractorCount < 500 || distractorCount > 600)
    fail('APPROVED_MEMORY_DISTRACTOR_COUNT_INVALID', 'MA510');
  const source = manifest.records.find((record) => record.logicalId === 'MA510');
  if (!source || source.owner !== 'memory_item' || source.payload.facts.lifecycle !== 'approved')
    fail('APPROVED_MEMORY_SOURCE_INVALID', 'MA510');
  const inputs = [
    { logicalId: 'MA510', facts: source.payload.facts, supporting: false },
    ...Array.from({ length: distractorCount }, (_, index) => ({
      logicalId: `MA510-DISTRACTOR-${String(index + 1).padStart(4, '0')}`,
      facts: {
        lifecycle: 'approved',
        text: `Synthetic archive preference ${String(index + 1).padStart(4, '0')}: use the routine quarterly checklist`,
      },
      supporting: true,
    })),
  ];
  return inputs.map((input) => approvedCandidateDefinition(manifest, source, input));
}

/**
 * Internal fixture runtime over actual application services. The caller owns an
 * isolated local transaction and the provider/embedding sink. This is not wired
 * to a public route or to shared DATABASE_URL, and does not change manifest owner
 * availability. Every operation resolves its actor again from current rows.
 */
export function createApprovedMemoryFixtureRuntime({
  manifest,
  distractorCount,
  sourceIds,
  lifecycleSeedSourceIds,
  memoryCandidates,
  memoryStore,
  tenantContext,
  prisma,
  proposerForTenant,
  reviewerForTenant,
  clientMemoryAllowed,
}) {
  // Keep the validated inventory private; later caller mutation must not change
  // the facts or actor/tenant bindings of an already constructed runtime.
  manifest = structuredClone(manifest);
  if (
    [sourceIds, distractorCount, lifecycleSeedSourceIds].filter((value) => value !== undefined)
      .length > 1
  )
    fail('APPROVED_MEMORY_SELECTION_OPTIONS_CONFLICT', 'sourceIds');
  const definitions =
    lifecycleSeedSourceIds !== undefined
      ? lifecycleSeedMemoryDefinitions(manifest, lifecycleSeedSourceIds)
      : sourceIds === undefined
        ? approvedMemoryDefinitions(manifest, { distractorCount })
        : selectedApprovedMemoryDefinitions(manifest, sourceIds);
  const byLogicalId = new Map(definitions.map((definition) => [definition.logicalId, definition]));
  if (
    typeof memoryCandidates?.approveSyntheticFixture !== 'function' ||
    typeof memoryStore?.inspectSyntheticFixture !== 'function' ||
    typeof memoryStore?.inspectSyntheticFixtureRetirement !== 'function' ||
    typeof memoryStore?.forgetSyntheticFixture !== 'function' ||
    typeof tenantContext?.run !== 'function' ||
    typeof reviewerForTenant !== 'function' ||
    typeof proposerForTenant !== 'function'
  )
    fail('APPROVED_MEMORY_RUNTIME_INCOMPLETE', 'MA510');

  function definition(logicalId) {
    if (
      process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE !== FIXTURE_NAMESPACE ||
      process.env.MEMORY_GOVERNANCE_LIFECYCLE !== 'enforce' ||
      process.env.MEMORY_GOVERNANCE_ENFORCE !== 'enforce' ||
      process.env.MEMORY_GOVERNANCE_CENTER !== 'enforce'
    )
      fail('APPROVED_MEMORY_GOVERNANCE_REQUIRED', logicalId);
    const found = byLogicalId.get(logicalId);
    if (!found) fail('APPROVED_MEMORY_SOURCE_UNKNOWN', logicalId);
    return found;
  }

  async function reviewer(record) {
    const userId = await reviewerForTenant(record.tenantId);
    if (!UUID.test(userId ?? '') || userId === record.tenantId)
      fail('APPROVED_MEMORY_REVIEWER_UNAVAILABLE', record.logicalId);
    return prisma.withTenantUser(record.tenantId, userId, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT tm.role FROM tenant_memberships tm JOIN tenants t ON t.id=tm.tenant_id
         WHERE tm.tenant_id=$1::uuid AND tm.user_id=$2::uuid AND tm.status='active' AND t.slug=$3`,
        record.tenantId,
        userId,
        manifest.tenants[record.tenantKey].slug,
      );
      if (
        rows.length !== 1 ||
        !['standard_user', 'user_admin', 'capiro_admin'].includes(rows[0].role)
      )
        fail('APPROVED_MEMORY_REVIEWER_UNAVAILABLE', record.logicalId);
      if (
        record.clientPhysicalId &&
        !(await clientMemoryAllowed(tx, record.tenantId, userId, record.clientPhysicalId))
      )
        fail('APPROVED_MEMORY_CLIENT_NOT_ALLOWED', record.logicalId);
      return { tenantId: record.tenantId, userId, role: rows[0].role };
    });
  }

  const retirement = createApprovedMemoryRetirementPort({
    prisma,
    memoryStore,
    tenantContext,
    proposerForTenant,
    retirementActorForTenant: reviewerForTenant,
  });
  const candidates = createMemoryCandidateOwnerPort({
    memoryCandidates,
    prisma,
    actorForTenant: proposerForTenant,
    clientMemoryAllowed,
    approvedRetirement: retirement,
  });

  function binding(entry, proof) {
    if (!proof || !UUID.test(proof.approvedItemId ?? ''))
      fail('APPROVED_MEMORY_READBACK_REQUIRED', entry.logicalId);
    return {
      logicalId: entry.logicalId,
      supporting: entry.supporting,
      owner: 'memory_item',
      tenantId: entry.candidate.tenantId,
      clientId: entry.candidate.clientPhysicalId,
      physicalId: proof.approvedItemId,
      proposedItemId: entry.proposedItemId,
      candidateId: entry.candidate.physicalId,
      ownershipMarkerSha256: entry.candidate.ownership.markerSha256,
      candidatePayloadSha256: entry.candidate.payloadSha256,
      candidateRowVersion: proof.rowVersion,
      itemRowVersion: proof.itemRowVersion,
      lifecycle: 'approved',
    };
  }

  async function inspect(logicalId) {
    const entry = definition(logicalId);
    await reviewer(entry.candidate);
    const proof = await retirement.inspect(entry.candidate);
    return proof ? binding(entry, proof) : null;
  }

  async function create(logicalId) {
    const entry = definition(logicalId);
    const record = entry.candidate;
    const ctx = await reviewer(record);
    const existing = await inspect(logicalId);
    if (existing) return existing;
    let pending = await candidates.read(record);
    if (!pending) {
      await candidates.create(record, {
        tenantId: record.tenantId,
        physicalId: record.physicalId,
        expectedOwnershipMarkerSha256: record.ownership.markerSha256,
        expectedRowVersion: null,
      });
      pending = await candidates.read(record);
    }
    if (
      pending?.payloadSha256 !== record.payloadSha256 ||
      pending?.ownership?.markerSha256 !== record.ownership.markerSha256
    )
      fail('APPROVED_MEMORY_PENDING_MISMATCH', logicalId);
    // Authorization, candidate lock, canonical insert, audit and outbox remain
    // the real service's transaction. A failure leaves only the owned pending
    // proposal, which a retry revalidates instead of overwriting or deleting.
    await memoryCandidates.approveSyntheticFixture(
      record.tenantId,
      record.physicalId,
      ctx.userId,
      ctx,
      {
        expectedRowVersion: pending.rowVersion,
        expectedPayload: expectedMemoryCandidatePayload(
          record,
          await proposerForTenant(record.tenantId),
          stableJson({ ownership: record.ownership, payload: record.payload }),
        ),
      },
    );
    try {
      const actual = await inspect(logicalId);
      if (!actual) fail('APPROVED_MEMORY_READBACK_REQUIRED', logicalId);
      return actual;
    } catch (error) {
      error.unknownCommit = true;
      throw error;
    }
  }

  function retirementOperation(logicalId, priorBinding) {
    const entry = definition(logicalId);
    if (
      !priorBinding ||
      priorBinding.logicalId !== logicalId ||
      priorBinding.candidateId !== entry.candidate.physicalId ||
      priorBinding.tenantId !== entry.candidate.tenantId ||
      priorBinding.clientId !== entry.candidate.clientPhysicalId ||
      priorBinding.ownershipMarkerSha256 !== entry.candidate.ownership.markerSha256 ||
      priorBinding.candidatePayloadSha256 !== entry.candidate.payloadSha256
    )
      fail('APPROVED_MEMORY_BINDING_MISMATCH', logicalId);
    const operation = {
      action: 'revoke_approved',
      approvedItemId: priorBinding.physicalId,
      expectedRowVersion: priorBinding.candidateRowVersion,
      expectedItemRowVersion: priorBinding.itemRowVersion,
    };
    return { entry, operation };
  }

  async function inspectRetirement(logicalId, priorBinding) {
    const { entry, operation } = retirementOperation(logicalId, priorBinding);
    await reviewer(entry.candidate);
    return retirement.readRetirement(entry.candidate, operation);
  }

  async function retire(logicalId, priorBinding) {
    const { entry, operation } = retirementOperation(logicalId, priorBinding);
    const ctx = await reviewer(entry.candidate);
    const rows = await prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      tx.$queryRawUnsafe(
        'SELECT status FROM memory_items WHERE tenant_id=$1::uuid AND id=$2::uuid',
        ctx.tenantId,
        operation.approvedItemId,
      ),
    );
    // A retained retirement is verified using its original guarded receipt.
    // This makes a partially completed reset resumable without reactivation.
    return rows[0]?.status === 'revoked'
      ? retirement.readRetirement(entry.candidate, operation)
      : retirement.retire(entry.candidate, operation);
  }

  return Object.freeze({
    logicalIds: Object.freeze(definitions.map((entry) => entry.logicalId)),
    inspect,
    create,
    retire,
    inspectRetirement,
    async createDataset() {
      const bindings = [];
      // MA510 must predate the supporting rows; do not parallelize this loop.
      for (const entry of definitions) bindings.push(await create(entry.logicalId));
      return Object.freeze({
        kind: 'meri-approved-memory-local-bindings',
        fixtureMapSha256: manifest.contentSha256,
        bindings,
        bindingsSha256: sha256Stable(bindings),
        liveAcceptance: 'NOT_RUN',
      });
    },
    async retireDataset(receipt) {
      if (
        receipt?.kind !== 'meri-approved-memory-local-bindings' ||
        receipt.fixtureMapSha256 !== manifest.contentSha256 ||
        !Array.isArray(receipt.bindings) ||
        receipt.bindingsSha256 !== sha256Stable(receipt.bindings) ||
        receipt.bindings.length !== definitions.length ||
        new Set(receipt.bindings.map((row) => row.physicalId)).size !== definitions.length ||
        new Set(receipt.bindings.map((row) => row.logicalId)).size !== definitions.length
      )
        fail('APPROVED_MEMORY_RECEIPT_MISMATCH', 'MA510');
      // Validate the entire supplied inventory before making any mutation.
      for (const row of receipt.bindings) retirementOperation(row.logicalId, row);
      const proofs = [];
      for (const row of receipt.bindings) proofs.push(await retire(row.logicalId, row));
      return { retained: true, proofs, liveAcceptance: 'NOT_RUN' };
    },
  });
}
