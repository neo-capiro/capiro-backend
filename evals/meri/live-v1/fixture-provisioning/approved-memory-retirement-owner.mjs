import { stableJson } from '../lib/stable.mjs';
import { FixtureProvisioningError } from './contract.mjs';
import {
  assertMemoryCandidateRecord,
  expectedMemoryCandidatePayload,
} from './memory-candidate-owner.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Read-only SQL resolves identities; canonical store methods own checks and mutations. */
export function createApprovedMemoryRetirementPort({
  prisma,
  memoryStore,
  tenantContext,
  proposerForTenant,
  retirementActorForTenant,
}) {
  const fail = (code, record) => {
    throw new FixtureProvisioningError(code, record.logicalId);
  };
  async function context(record) {
    assertMemoryCandidateRecord(record);
    const userId = await retirementActorForTenant(record.tenantId);
    if (!UUID.test(userId ?? '')) fail('APPROVED_RETIREMENT_ACTOR_UNAVAILABLE', record);
    const rows = await prisma.withTenantUser(record.tenantId, userId, (tx) =>
      tx.$queryRawUnsafe(
        `SELECT role FROM tenant_memberships WHERE tenant_id=$1::uuid AND user_id=$2::uuid AND status='active'`,
        record.tenantId,
        userId,
      ),
    );
    if (
      rows.length !== 1 ||
      !['standard_user', 'user_admin', 'capiro_admin'].includes(rows[0].role)
    )
      fail('APPROVED_RETIREMENT_ACTOR_UNAVAILABLE', record);
    return { tenantId: record.tenantId, userId, role: rows[0].role };
  }
  async function guard(record, operation, ctx) {
    const proposerId = await proposerForTenant(record.tenantId);
    if (!UUID.test(proposerId ?? '')) fail('APPROVED_RETIREMENT_PROPOSER_MISMATCH', record);
    // Bind the configured fixture actor even for shared payloads with no owner.
    // The canonical transaction rechecks this exact candidate version, so a
    // proposer change between this read and the mutation cannot pass the guard.
    const candidates = await prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      tx.$queryRawUnsafe(
        `SELECT id FROM memory_candidate WHERE tenant_id=$1::uuid AND id=$2::uuid AND proposed_by=$3::uuid AND xmin::text=$4`,
        record.tenantId,
        record.physicalId,
        proposerId,
        operation.expectedRowVersion,
      ),
    );
    if (candidates.length !== 1) fail('APPROVED_RETIREMENT_PROPOSER_MISMATCH', record);
    return {
      candidateId: record.physicalId,
      expectedRowVersion: operation.expectedRowVersion,
      expectedItemRowVersion: operation.expectedItemRowVersion,
      expectedPayload: expectedMemoryCandidatePayload(
        record,
        proposerId,
        stableJson({ ownership: record.ownership, payload: record.payload }),
      ),
    };
  }
  function identity(record) {
    return {
      physicalId: record.physicalId,
      tenantId: record.tenantId,
      owner: record.owner,
      ownership: record.ownership,
      payloadSha256: record.payloadSha256,
    };
  }
  async function readRetirement(record, operation) {
    const ctx = await context(record);
    const rows = await prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      tx.$queryRawUnsafe(
        `SELECT mi.status FROM memory_candidate mc JOIN memory_items mi ON mi.id=mc.committed_memory_item_id AND mi.tenant_id=mc.tenant_id WHERE mc.tenant_id=$1::uuid AND mc.id=$2::uuid AND mi.id=$3::uuid`,
        record.tenantId,
        record.physicalId,
        operation.approvedItemId,
      ),
    );
    if (rows.length === 1 && rows[0].status === 'active')
      fail('MEMORY_CANDIDATE_RETIREMENT_UNVERIFIED', record);
    const expected = await guard(record, operation, ctx);
    const proof = await tenantContext.run(ctx, () =>
      memoryStore.inspectSyntheticFixtureRetirement(operation.approvedItemId, expected),
    );
    return {
      ...identity(record),
      retained: true,
      status: 'approved',
      governedStatus: 'active',
      rowVersion: proof.syntheticFixtureCandidateRowVersion,
      priorRowVersion: proof.syntheticFixtureCandidateRowVersion,
      approvedItemId: proof.itemId,
      itemStatus: proof.status,
      itemGovernedStatus: proof.governedStatus,
      itemRowVersion: proof.rowVersion,
      priorItemRowVersion: proof.syntheticFixtureItemRowVersion,
      transitionAuditId: proof.transitionAuditId,
      cleanupIntentId: proof.cleanupIntentId,
    };
  }
  return {
    async inspect(record) {
      const ctx = await context(record);
      const rows = await prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
        tx.$queryRawUnsafe(
          `SELECT mc.status,mc.committed_memory_item_id::text AS item_id,mc.xmin::text AS candidate_version,mi.xmin::text AS item_version FROM memory_candidate mc LEFT JOIN memory_items mi ON mi.id=mc.committed_memory_item_id AND mi.tenant_id=mc.tenant_id WHERE mc.tenant_id=$1::uuid AND mc.id=$2::uuid`,
          record.tenantId,
          record.physicalId,
        ),
      );
      if (rows.length === 0 || rows[0].status !== 'approved') return null;
      const row = rows[0];
      const operation = {
        expectedRowVersion: row.candidate_version,
        expectedItemRowVersion: row.item_version,
      };
      const expected = await guard(record, operation, ctx);
      await tenantContext.run(ctx, () =>
        memoryStore.inspectSyntheticFixture(row.item_id, expected),
      );
      return {
        ...identity(record),
        lifecycle: 'approved',
        rowVersion: row.candidate_version,
        approvedItemId: row.item_id,
        itemRowVersion: row.item_version,
      };
    },
    readRetirement,
    async retire(record, operation) {
      const ctx = await context(record);
      const expected = await guard(record, operation, ctx);
      const result = await tenantContext.run(ctx, () =>
        memoryStore.forgetSyntheticFixture(operation.approvedItemId, expected),
      );
      if (result?.found !== true || result.blockedByLegalHold)
        fail('APPROVED_RETIREMENT_REFUSED', record);
      try {
        return await readRetirement(record, operation);
      } catch (error) {
        error.unknownCommit = true;
        throw error;
      }
    },
  };
}
