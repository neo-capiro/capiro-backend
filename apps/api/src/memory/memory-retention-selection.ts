import type { Prisma } from '@prisma/client';

/** Hold changes and new held revisions must finish before a destructive snapshot.
 * Candidate activation also takes candidate locks before canonical item locks.
 * EXCLUSIVE waits for SELECT FOR UPDATE holders without blocking plain reads. */
export async function lockMemoryRetentionInTx(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`LOCK TABLE memory_candidate, memory_items IN EXCLUSIVE MODE`;
}

/** Preserve held content and its provenance. Revision references are restrictive
 * FKs, so a retained revision retains its connected family. During client purge,
 * rows outside that client are also roots: deleting their dependencies would
 * otherwise mutate another client's lineage or abort the entire transaction.
 * Call after lockMemoryRetentionInTx for execution; a dry-run is advisory only. */
export async function retainedMemoryInTx(
  tx: Prisma.TransactionClient,
  tenantId: string | null = null,
  clientId: string | null = null,
) {
  const rows = await tx.$queryRaw<Array<{ kind: string; id: string }>>`
    WITH RECURSIVE
    candidates AS (
      SELECT tenant_id, id, client_id, legal_hold, revision_root_id,
        predecessor_candidate_id, superseded_by_id, duplicate_of_id,
        committed_memory_item_id, duplicate_memory_item_id,
        contradicts_memory_item_id, committed_memory_id FROM memory_candidate
      WHERE (${tenantId}::uuid IS NULL OR tenant_id = ${tenantId}::uuid)
    ), items AS (
      SELECT tenant_id, id, legal_hold, slug FROM memory_items
      WHERE (${tenantId}::uuid IS NULL OR tenant_id = ${tenantId}::uuid)
    ), links(tenant_id, from_kind, from_id, to_kind, to_id) AS (
      SELECT c.tenant_id, 'candidate', c.id, 'candidate', r.id
      FROM candidates c CROSS JOIN LATERAL unnest(ARRAY[
        c.revision_root_id, c.predecessor_candidate_id, c.superseded_by_id, c.duplicate_of_id
      ]) AS reference(id)
      JOIN candidates r ON r.tenant_id = c.tenant_id AND r.id = reference.id
      UNION
      SELECT c.tenant_id, 'candidate', reference.id, 'candidate', c.id
      FROM candidates c CROSS JOIN LATERAL unnest(ARRAY[
        c.revision_root_id, c.predecessor_candidate_id, c.superseded_by_id
      ]) AS reference(id)
      WHERE reference.id IS NOT NULL
      UNION
      SELECT c.tenant_id, 'candidate', c.id, 'item', m.id
      FROM candidates c JOIN items m ON m.tenant_id = c.tenant_id
        AND m.id IN (c.committed_memory_item_id, c.duplicate_memory_item_id, c.contradicts_memory_item_id)
      UNION
      SELECT m.tenant_id, 'item', m.id, 'candidate', c.id
      FROM items m JOIN candidates c ON c.tenant_id = m.tenant_id
        AND (c.committed_memory_item_id = m.id OR m.slug = 'clio:' || c.committed_memory_id::text)
      UNION
      SELECT c.tenant_id, 'candidate', c.id, 'clio', c.committed_memory_id
      FROM candidates c WHERE c.committed_memory_id IS NOT NULL
      UNION
      SELECT m.tenant_id, 'item', m.id, 'clio', cm.id
      FROM items m JOIN clio_memory cm ON cm.tenant_id = m.tenant_id AND m.slug = 'clio:' || cm.id::text
      UNION
      SELECT m.tenant_id, 'clio', cm.id, 'item', m.id
      FROM items m JOIN clio_memory cm ON cm.tenant_id = m.tenant_id AND m.slug = 'clio:' || cm.id::text
    ), retained(tenant_id, kind, id) AS (
      SELECT tenant_id, 'item'::text, id FROM items WHERE legal_hold = true
      UNION
      SELECT tenant_id, 'candidate'::text, id FROM candidates
      WHERE legal_hold = true
        OR (${clientId}::uuid IS NOT NULL AND client_id IS DISTINCT FROM ${clientId}::uuid)
      UNION
      SELECT l.tenant_id, l.to_kind, l.to_id
      FROM links l JOIN retained r
        ON l.tenant_id = r.tenant_id AND l.from_kind = r.kind AND l.from_id = r.id
    )
    SELECT kind, id::text FROM retained
  `;
  return {
    itemIds: rows.filter((row) => row.kind === 'item').map((row) => row.id),
    candidateIds: rows.filter((row) => row.kind === 'candidate').map((row) => row.id),
    clioIds: rows.filter((row) => row.kind === 'clio').map((row) => row.id),
  };
}
