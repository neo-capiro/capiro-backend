import type { PrismaClient } from '@prisma/client';
import type { LegiscanBill } from '../external/legiscan/legiscan.client.js';

/** Metadata inventories are not documents. Seed the existing bounded document
 * refresh owner without claiming an attempt, a fetched hash, or success. */
export async function queueBillDocumentChecks(
  prisma: PrismaClient,
  billKey: string,
  raw: Pick<LegiscanBill, 'texts' | 'amendments' | 'supplements'>,
  options: { exactVersions?: boolean } = {},
) {
  const docs = [
    ...(raw.texts ?? []).map((d) => ({ identity: `text:${d.doc_id}`, hash: d.text_hash ?? null })),
    ...(raw.amendments ?? []).map((d) => ({
      identity: `amendment:${d.amendment_id}`,
      hash: d.amendment_hash ?? null,
    })),
    ...(raw.supplements ?? []).map((d) => ({
      identity: `supplement:${d.supplement_id}`,
      hash: d.supplement_hash ?? null,
    })),
  ];
  if (options.exactVersions)
    for (const doc of docs) doc.identity += ':' + (doc.hash?.toLowerCase() ?? 'unknown');
  if (!docs.length) return 0;
  return prisma.$executeRaw`INSERT INTO state_bill_record_check(bill_key,kind,source_identity,state,attempts,next_check_at)
    SELECT ${billKey},'document',d.identity,'pending',0,now()
    FROM jsonb_to_recordset(${JSON.stringify(docs)}::jsonb) AS d(identity text,hash text)
    ON CONFLICT(bill_key,kind,source_identity) DO UPDATE SET next_check_at=now()
    WHERE state_bill_record_check.state IN ('available','partial','metadata_only')
      AND state_bill_record_check.provider_hash IS DISTINCT FROM (
        SELECT x.hash FROM jsonb_to_recordset(${JSON.stringify(docs)}::jsonb) AS x(identity text,hash text)
        WHERE x.identity=EXCLUDED.source_identity LIMIT 1)`;
}
