import type { Prisma } from '@prisma/client';
import { lockMemoryRetentionInTx, retainedMemoryInTx } from '../memory-retention-selection.js';

/** The existing daily worker retries expiration; receipts never retain sections. */
export async function expireSettingsMemoryDraftsInTx(
  tx: Prisma.TransactionClient,
  tenantId: string,
) {
  await lockMemoryRetentionInTx(tx);
  const retained = await retainedMemoryInTx(tx, tenantId);
  const erased =
    await tx.$executeRaw`UPDATE memory_settings_drafts SET sections=NULL,state='expired',revision=revision+1
    WHERE tenant_id=${tenantId}::uuid AND state='draft' AND expires_at<=clock_timestamp() AND legal_hold=false
      AND (base_item_id IS NULL OR base_item_id<>ALL(${retained.itemIds}::uuid[]))`;
  const held = await tx.$queryRaw<
    Array<{ count: bigint }>
  >`SELECT count(*) AS count FROM memory_settings_drafts
    WHERE tenant_id=${tenantId}::uuid AND state='draft' AND expires_at<=clock_timestamp()`;
  return { erased, retainedExpired: Number(held[0]?.count ?? 0) };
}
