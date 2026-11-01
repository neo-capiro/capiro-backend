import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { retainedMemoryInTx } from './memory-retention-selection.js';
import { memoryReceiptsAreContentFreeInTx } from './memory-receipt-retention.js';

/** Shared selection for current absence verification and finalization.
 * Explicit origins bind copied proposals; citations and published memory do not.
 * Both callers use system scope to see suppressed content, with tenant predicates.
 */
export async function conversationMemoryCandidatesInTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
  conversationId: string,
) {
  if (!await memoryReceiptsAreContentFreeInTx(tx, tenantId))
    throw new ConflictException('RETENTION_MEMORY_RECEIPT_DISPOSITION_REQUIRED');
  return tx.$queryRaw<Array<{ id: string; selected: boolean }>>`
    SELECT id, (
      memory_candidate_conversation_origin(provenance_jsonb)->>'kind'='conversation'
      AND memory_candidate_conversation_origin(provenance_jsonb)->>'conversationId'=${conversationId}
      AND status NOT IN ('approved','auto_committed')
      AND committed_memory_id IS NULL AND committed_memory_item_id IS NULL
      AND duplicate_memory_item_id IS NULL
    ) IS TRUE AS selected
    FROM memory_candidate WHERE tenant_id=${tenantId}::uuid ORDER BY id
  `;
}

/** Under the canonical memory table exclusion, a held/referenced pending copy
 * blocks completion. The finalizer retries after that dependency is resolved. */
export async function purgeConversationMemoryInTx(
  tx: Prisma.TransactionClient, tenantId: string, conversationId: string,
) {
  const candidates = await conversationMemoryCandidatesInTx(tx, tenantId, conversationId);
  const selected = candidates.filter(row => row.selected).map(row => row.id);
  if (!selected.length) return;
  const retained = await retainedMemoryInTx(
    tx, tenantId, null, candidates.filter(row => !row.selected).map(row => row.id),
  );
  if (selected.some(id => retained.candidateIds.includes(id)))
    throw new ConflictException('RETENTION_MEMORY_HELD_OR_REFERENCED');
  // Review titles/feedback are copies. Their existing notification FKs cascade
  // both delivery obligations and the in-app projection in this transaction.
  await tx.$executeRaw`DELETE FROM review_request WHERE tenant_id=${tenantId}::uuid
    AND surface='memory' AND subject_type='memory_candidate' AND subject_id=ANY(${selected}::text[])`;
  const deleted = await tx.$executeRaw`DELETE FROM memory_candidate
    WHERE tenant_id=${tenantId}::uuid AND id=ANY(${selected}::uuid[]) AND legal_hold=false`;
  if (deleted !== selected.length) throw new ConflictException('RETENTION_MEMORY_UNRESOLVED');
  // Existing row-deletion triggers retain memory_retention_tombstones; Meri's
  // content-free submission keys also remain, so old producer retries are Gone.
}
