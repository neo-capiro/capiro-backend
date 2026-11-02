import type { Prisma } from '@prisma/client';
import { lockMemoryRetentionInTx, retainedMemoryInTx } from './memory-retention-selection.js';

interface DueOwner {
  id: string;
  tenantId: string;
  ownerKind: string;
  ownerId: string;
  closedAt: string;
}

/** Existing daily memory worker owns retries. Periods remain immutable; selecting
 * only periods that still have rows makes a crash/retry resume the remaining work.
 * Counts describe Core stores only, not external Meri cleanup completion. */
export async function purgeMemoryOwnerRetentionInTx(
  tx: Prisma.TransactionClient,
  tenantId: string | null = null,
) {
  await lockMemoryRetentionInTx(tx);
  const due = await tx.$queryRaw<DueOwner[]>`
    SELECT s.id, s.tenant_id AS "tenantId", s.owner_kind AS "ownerKind",
      s.owner_id AS "ownerId", s.closed_at::text AS "closedAt"
    FROM memory_retention_subjects s
    WHERE s.closed_at IS NOT NULL AND s.purge_after <= clock_timestamp()
      AND (${tenantId}::uuid IS NULL OR s.tenant_id=${tenantId}::uuid)
      AND (EXISTS(SELECT 1 FROM memory_items m WHERE m.tenant_id=s.tenant_id AND m.retention_subject_id=s.id)
        OR EXISTS(SELECT 1 FROM memory_candidate c WHERE c.tenant_id=s.tenant_id AND c.retention_subject_id=s.id)
        OR EXISTS(SELECT 1 FROM clio_memory c WHERE c.tenant_id=s.tenant_id AND c.retention_subject_id=s.id))
    ORDER BY s.purge_after,s.id LIMIT 100
  `;
  const total = {
    periods: due.length,
    items: 0,
    candidates: 0,
    clio: 0,
    embeddings: 0,
    edges: 0,
    grants: 0,
    remainingCoreRows: 0,
  };
  for (const owner of due) {
    const counts = await purgeOwnerPeriod(tx, owner);
    for (const key of Object.keys(counts) as Array<keyof typeof counts>) total[key] += counts[key];
  }
  return total;
}

async function purgeOwnerPeriod(tx: Prisma.TransactionClient, owner: DueOwner) {
  const outside = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM memory_candidate WHERE tenant_id=${owner.tenantId}::uuid
      AND retention_subject_id IS DISTINCT FROM ${owner.id}::uuid
  `;
  const retained = await retainedMemoryInTx(
    tx,
    owner.tenantId,
    null,
    outside.map((row) => row.id),
  );
  const selected = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM memory_items WHERE tenant_id=${owner.tenantId}::uuid
      AND retention_subject_id=${owner.id}::uuid AND legal_hold=false
      AND id<>ALL(${retained.itemIds}::uuid[]) ORDER BY id FOR UPDATE
  `;
  const itemIds = selected.map((row) => row.id);
  const embeddings = await tx.$executeRaw`
    DELETE FROM context_embeddings WHERE tenant_id=${owner.tenantId}::uuid
      AND source_type='memory_item' AND source_id=ANY(${itemIds}::text[])
  `;
  const edges = await tx.$executeRaw`
    DELETE FROM memory_edges edge USING memory_items item
    WHERE item.tenant_id=${owner.tenantId}::uuid AND edge.tenant_id=item.tenant_id
      AND item.id=ANY(${itemIds}::uuid[])
      AND (edge.src_item_id=item.id OR (edge.dst_type=item.type AND edge.dst_slug=item.slug
        AND edge.src_item_id<>ALL(${retained.itemIds}::uuid[])))
  `;
  const candidates = await tx.$executeRaw`
    DELETE FROM memory_candidate WHERE tenant_id=${owner.tenantId}::uuid
      AND retention_subject_id=${owner.id}::uuid AND legal_hold=false
      AND id<>ALL(${retained.candidateIds}::uuid[])
  `;
  const items = await tx.$executeRaw`
    DELETE FROM memory_items WHERE tenant_id=${owner.tenantId}::uuid
      AND retention_subject_id=${owner.id}::uuid AND id=ANY(${itemIds}::uuid[]) AND legal_hold=false
  `;
  const clio = await tx.$executeRaw`
    DELETE FROM clio_memory WHERE tenant_id=${owner.tenantId}::uuid
      AND retention_subject_id=${owner.id}::uuid AND id<>ALL(${retained.clioIds}::uuid[])
  `;
  const grants = await purgeDepartedOwnerGrants(tx, owner);
  const remaining = await tx.$queryRaw<Array<{ count: bigint }>>`
    SELECT ((SELECT count(*) FROM memory_items WHERE tenant_id=${owner.tenantId}::uuid AND retention_subject_id=${owner.id}::uuid)
      +(SELECT count(*) FROM memory_candidate WHERE tenant_id=${owner.tenantId}::uuid AND retention_subject_id=${owner.id}::uuid)
      +(SELECT count(*) FROM clio_memory WHERE tenant_id=${owner.tenantId}::uuid AND retention_subject_id=${owner.id}::uuid)) AS count
  `;
  const counts = {
    items,
    candidates,
    clio,
    embeddings,
    edges,
    grants,
    remainingCoreRows: Number(remaining[0]?.count ?? 0),
  };
  await tx.auditLog.create({
    data: {
      tenantId: owner.tenantId,
      action: 'memory.owner_retention.purge',
      entityType: 'memory_owner_period',
      entityId: owner.id,
      after: counts,
    },
  });
  return counts;
}

/** A reactivated owner can have current grants serving new content. Only clear
 * pre-closure grants while that owner is still inactive; membership and client
 * authorization already stop use immediately when the owner is removed/closed. */
async function purgeDepartedOwnerGrants(tx: Prisma.TransactionClient, owner: DueOwner) {
  if (owner.ownerKind === 'personal') {
    const members = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT status::text FROM tenant_memberships WHERE tenant_id=${owner.tenantId}::uuid
        AND user_id=${owner.ownerId}::uuid FOR SHARE
    `;
    if (members.some((member) => member.status === 'active')) return 0;
    const wall =
      await tx.$executeRaw`DELETE FROM client_memory_access WHERE tenant_id=${owner.tenantId}::uuid
      AND user_id=${owner.ownerId}::uuid AND created_at<=${owner.closedAt}::timestamptz`;
    return (
      wall +
      (await tx.$executeRaw`DELETE FROM memory_access_grant WHERE tenant_id=${owner.tenantId}::uuid
      AND user_id=${owner.ownerId}::uuid AND created_at<=${owner.closedAt}::timestamptz`)
    );
  }
  if (owner.ownerKind === 'client') {
    const clients = await tx.$queryRaw<Array<{ status: string }>>`
      SELECT status FROM clients WHERE tenant_id=${owner.tenantId}::uuid AND id=${owner.ownerId}::uuid FOR SHARE
    `;
    if (clients.some((client) => client.status === 'active')) return 0;
    const wall =
      await tx.$executeRaw`DELETE FROM client_memory_access WHERE tenant_id=${owner.tenantId}::uuid
      AND client_id=${owner.ownerId}::uuid AND created_at<=${owner.closedAt}::timestamptz`;
    return (
      wall +
      (await tx.$executeRaw`DELETE FROM memory_access_grant WHERE tenant_id=${owner.tenantId}::uuid
      AND client_id=${owner.ownerId}::uuid AND created_at<=${owner.closedAt}::timestamptz`)
    );
  }
  return 0;
}
