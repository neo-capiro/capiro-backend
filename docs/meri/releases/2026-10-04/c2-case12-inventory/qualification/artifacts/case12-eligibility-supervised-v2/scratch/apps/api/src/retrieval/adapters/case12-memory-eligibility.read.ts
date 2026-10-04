import { Prisma } from '@prisma/client';
import { clientMemoryAllowed } from '../../memory/memory-wall.helpers.js';
import {
  canonicalMemoryEligibilitySql,
  includeCanonicalGovernedMemoryRow,
} from './governed-memory-eligibility.helpers.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
type CurrentRow = Parameters<typeof includeCanonicalGovernedMemoryRow>[0] & {
  id: string; tenantId: string; clientId: string | null;
  rowVersion: string; newerThanTarget: boolean;
  databaseTransactionStartedAt: Date; databaseObservedAt: Date; databaseSnapshot: string;
};

/** Internal source composition only. No connection, provider call or capture authority. */
export async function readCase12CanonicalEligibilityInTx(
  tx: Prisma.TransactionClient,
  suppliedContext: { tenantId: string; userId: string; role: string },
  input: { clientId: string; targetItemId: string; inventoryItemIds: string[] },
) {
  const ctx = structuredClone(suppliedContext);
  const { clientId, targetItemId, inventoryItemIds } = structuredClone(input);
  const processStartedAt = new Date().toISOString();
  if (ctx.role !== 'standard_user' || ![ctx.tenantId, ctx.userId, clientId, targetItemId].every(v => UUID.test(v)) ||
      !Array.isArray(inventoryItemIds) || inventoryItemIds.length < 501 || inventoryItemIds.length > 601 ||
      inventoryItemIds.some(v => !UUID.test(v)) || new Set(inventoryItemIds).size !== inventoryItemIds.length ||
      !inventoryItemIds.includes(targetItemId)) throw new Error('CASE12_ELIGIBILITY_INPUT_INVALID');
  if (!(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, clientId)))
    throw new Error('CASE12_ELIGIBILITY_CLIENT_WALL_DENIED');
  const access = { tenantId: ctx.tenantId, userId: ctx.userId, allowedClientIds: [clientId] };
  const rows = await tx.$queryRaw<CurrentRow[]>(Prisma.sql`
    SELECT mi.id::text AS id,mi.tenant_id::text AS "tenantId",mi.client_id::text AS "clientId",
      mi.owner_user_id::text AS "ownerUserId",mi.visibility,mi.status AS "legacyStatus",
      mi.memory_class AS "memoryClass",mi.memory_authority AS authority,
      mi.memory_scope AS scope,mi.governed_status AS status,
      mi.conflict_status AS "conflictStatus",mi.controlling_item_id::text AS "controllingItemId",
      mi.sensitivity,mi.source_type AS "sourceType",mi.source_id AS "sourceId",mi.source_ref AS "sourceRef",
      mi.source_content_hash AS "sourceContentHash",mi.source_version AS "sourceVersion",
      mi.asserted_by_user_id::text AS "assertedByUserId",mi.approved_by_user_id::text AS "approvedByUserId",
      mi.approved_at AS "approvedAt",mi.second_approved_by_user_id::text AS "secondApprovedByUserId",
      mi.second_approved_at AS "secondApprovedAt",mi.effective_from AS "effectiveFrom",
      mi.valid_until AS "validUntil",mi.expires_at AS "expiresAt",mi.xmin::text AS "rowVersion",
      transaction_timestamp() AS "databaseTransactionStartedAt",statement_timestamp() AS "databaseObservedAt",
      txid_current_snapshot()::text AS "databaseSnapshot",
      (mi.id<>target.id AND mi.created_at>target.created_at AND mi.updated_at>target.updated_at) AS "newerThanTarget"
    FROM memory_items mi
    JOIN memory_items target ON target.id=${targetItemId}::uuid
      AND target.tenant_id=${ctx.tenantId}::uuid AND target.client_id=${clientId}::uuid
    WHERE ${canonicalMemoryEligibilitySql(access)}
      AND mi.id=ANY(${inventoryItemIds}::uuid[]) AND mi.client_id=${clientId}::uuid
  `);
  const eligible = rows.filter(row => includeCanonicalGovernedMemoryRow(row, access));
  const observation = rows[0] ? {
    databaseTransactionStartedAt: rows[0].databaseTransactionStartedAt.toISOString(),
    databaseObservedAt: rows[0].databaseObservedAt.toISOString(), databaseSnapshot: rows[0].databaseSnapshot,
    processStartedAt, processCompletedAt: new Date().toISOString(),
  } : null;
  if (observation && rows.some(row => row.databaseSnapshot !== observation.databaseSnapshot ||
      row.databaseObservedAt.toISOString() !== observation.databaseObservedAt ||
      row.databaseTransactionStartedAt.toISOString() !== observation.databaseTransactionStartedAt))
    throw new Error('CASE12_ELIGIBILITY_DATABASE_SNAPSHOT_MISMATCH');
  return {
    kind: 'case12-current-canonical-retrieval-eligibility',
    tenantId: ctx.tenantId, actorUserId: ctx.userId, clientId, targetItemId,
    comparisonClock: 'CURRENT_DATABASE_AND_PROCESS_CLOCK', semanticClockQualified: false,
    observation,
    observations: eligible.map(row => ({
      physicalId: row.id, tenantId: row.tenantId, clientId: row.clientId,
      itemRowVersion: row.rowVersion, sourceVersion: row.sourceVersion,
      sourceContentSha256: row.sourceContentHash, newerThanTarget: row.newerThanTarget,
    })),
  };
}
