import type { PrismaClient } from '@prisma/client';
import { isDeepStrictEqual } from 'node:util';
import type { FederalGeneration } from './federal-bill-inventory.js';
import { writeFederalInventory, type FederalReceipt } from './federal-billstatus-import.js';
import { parseFederalBillInventory } from './federal-bill-inventory-read.js';
import type { FederalAmendmentBinding } from './federal-billstatus.js';

/** Rebind only a list from a completed generation with the same official freshness/parent proof. */
export async function federalInventoryReuse(db: PrismaClient, generation: FederalGeneration) {
  const rows = await db.$queryRawUnsafe<FederalReceipt[]>(
    `SELECT id,scope,manifest,complete FROM legal_source_receipt WHERE source='fy26-federal-discovery'
     AND scope->>'congress'=$1 AND complete ORDER BY observed_at DESC,id DESC LIMIT 1`,
    String(generation.congress),
  );
  const old = rows[0];
  if (
    !old ||
    !Array.isArray(old.manifest.archiveReceiptIds) ||
    !Array.isArray(old.manifest.requiredInventoryReceiptIds)
  )
    return async () => false;
  const archives = await db.$queryRawUnsafe<FederalReceipt[]>(
    `SELECT r.id,r.scope,r.manifest,r.complete FROM legal_source_receipt r WHERE r.id=ANY($1::text[]) AND r.source='fy26-federal-billstatus-archive' AND r.complete
     AND EXISTS(SELECT 1 FROM legal_dataset_archive a WHERE a.content_hash=r.scope->>'archiveHash')`,
    old.manifest.archiveReceiptIds,
  );
  if (archives.length !== old.manifest.archiveReceiptIds.length) return async () => false;
  const previousBindings = new Map<string, FederalAmendmentBinding>();
  for (const archive of archives)
    for (const binding of archive.manifest.amendments ?? [])
      previousBindings.set(binding.id, binding);
  const discovery = {
    receiptId: old.id,
    congress: generation.congress,
    billIds: old.manifest.billIds,
    requiredInventoryReceiptIds: old.manifest.requiredInventoryReceiptIds,
    observedAt: old.observedAt,
  };
  return async (
    task: { kind: 'text' | 'amendment'; id: string; billId: string; updated: string | null },
    scope: Record<string, unknown>,
  ) => {
    if (task.kind !== 'amendment' || !task.updated) return false;
    const current = generation.amendments.find((a) => a.id === task.id),
      previous = previousBindings.get(task.id);
    if (
      !current ||
      !previous ||
      current.textVersionCount === null ||
      !isDeepStrictEqual(current, previous)
    )
      return false;
    const candidates = await db.$queryRawUnsafe<FederalReceipt[]>(
      `SELECT id,scope,manifest,complete,observed_at AS "observedAt" FROM legal_source_receipt
       WHERE id=ANY($1::text[]) AND source='fy26-federal-provider-inventory' AND scope->>'billId'=$2
       AND manifest->>'kind'='amendment' AND manifest->>'providerDocumentId'=$3 AND complete`,
      old.manifest.requiredInventoryReceiptIds,
      task.billId,
      task.id,
    );
    const receipt = candidates.find(
      (r) =>
        r.manifest.providerUpdatedAt === task.updated &&
        r.manifest.reportedCount === current.textVersionCount &&
        parseFederalBillInventory(r, discovery),
    );
    if (!receipt) return false;
    await writeFederalInventory(
      db,
      scope,
      {
        kind: 'amendment',
        providerDocumentId: task.id,
        providerUpdatedAt: task.updated,
        amendmentId: task.id,
        versions: receipt.manifest.versions,
        ...(receipt.manifest.exactDuplicateProof
          ? { exactDuplicateProof: receipt.manifest.exactDuplicateProof }
          : {}),
        reusedReceiptId: receipt.id,
      },
      true,
    );
    return true;
  };
}
