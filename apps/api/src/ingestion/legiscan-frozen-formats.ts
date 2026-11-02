import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import {
  inspectFrozenStateDataset,
  type FrozenDatasetScope,
} from './legiscan-historical-research.js';
import { alternateDocumentFormats, stateDocumentCheckIdentity } from './state-document-formats.js';
import { mergeDocumentStubs } from './state-document-stub.js';
import { withStateBillWriter } from './state-bill-writer.js';

export async function inspectFrozenStateFormats(archive: Buffer, scope: FrozenDatasetScope) {
  const prepared = await inspectFrozenStateDataset(archive, scope);
  const primaryScope = {
    jurisdiction: scope.state,
    providerSessionId: scope.sessionId,
    sessionKey: prepared.sessionKey,
    fiscalYear: 2026,
    archiveHash: scope.archiveHash,
  };
  const primaryReceiptId = createHash('sha256')
    .update(JSON.stringify(['fy26-state-frozen-inventory', 1, primaryScope]))
    .digest('hex');
  const receiptScope = { ...primaryScope, primaryReceiptId };
  const receiptId = createHash('sha256')
    .update(JSON.stringify(['fy26-state-frozen-formats', 1, receiptScope]))
    .digest('hex');
  const bills = prepared.eligible.map(({ raw, bill }) => ({
    billKey: bill!.billKey,
    providerBillId: raw.bill_id,
    formats: alternateDocumentFormats(raw, { receiptId, archiveHash: scope.archiveHash }),
  }));
  const manifest = {
    schemaVersion: 1,
    sourceListComplete: true,
    archiveHash: scope.archiveHash,
    primaryReceiptId,
    bills,
  };
  return { prepared, primaryScope, receiptScope, receiptId, manifest };
}

/** Add format metadata and retry work only. Never reimport parents, votes or primary checks. */
export async function importFrozenStateFormats(
  prisma: PrismaClient,
  archive: Buffer,
  scope: FrozenDatasetScope,
  options: { limit: number },
) {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000)
    throw Error('FROZEN_FORMAT_LIMIT_INVALID');
  const { prepared, primaryScope, receiptScope, receiptId, manifest } =
    await inspectFrozenStateFormats(archive, scope);
  return withStateBillWriter(prisma, [scope.state], async (writer) => {
    const checkpoint = `fy26-state-formats:${scope.state}:${scope.sessionId}:${scope.archiveHash}`;
    const selected = manifest.bills.filter((bill) => bill.formats.length);
    await writer.$transaction(async (tx) => {
      const primary = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT p.id FROM legal_source_receipt p
        JOIN legal_dataset_archive a ON a.content_hash=p.scope->>'archiveHash'
        WHERE p.id=${manifest.primaryReceiptId} AND p.source='fy26-state-frozen-inventory' AND p.complete
        AND p.scope=${JSON.stringify(primaryScope)}::jsonb AND p.manifest=${JSON.stringify(prepared.manifest)}::jsonb
        AND a.original_bytes_base64=${archive.toString('base64')}`;
      if (primary.length !== 1) throw Error('FROZEN_PRIMARY_INVENTORY_REQUIRED');
      await tx.$executeRaw`INSERT INTO legal_source_receipt(id,source,scope,manifest,complete)
        VALUES(${receiptId},'fy26-state-frozen-formats',${JSON.stringify(receiptScope)}::jsonb,${JSON.stringify(manifest)}::jsonb,true) ON CONFLICT DO NOTHING`;
      const exact = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM legal_source_receipt WHERE id=${receiptId}
        AND source='fy26-state-frozen-formats' AND scope=${JSON.stringify(receiptScope)}::jsonb
        AND manifest=${JSON.stringify(manifest)}::jsonb AND complete`;
      if (exact.length !== 1) throw Error('FROZEN_FORMAT_INVENTORY_CONFLICT');
      await tx.$executeRaw`INSERT INTO federal_evidence_checkpoint(source,cursor_jsonb,status,completed_at)
        VALUES(${checkpoint},'{}'::jsonb || jsonb_build_object('offset',0,'queued',0),${selected.length ? 'running' : 'completed'},
        CASE WHEN ${selected.length === 0} THEN clock_timestamp() ELSE NULL END) ON CONFLICT DO NOTHING`;
    });
    const rows = await writer.$queryRaw<Array<{ cursor: { offset: number; queued: number } }>>`
      SELECT cursor_jsonb AS cursor FROM federal_evidence_checkpoint WHERE source=${checkpoint}`;
    const cursor = rows[0]?.cursor;
    if (
      !cursor ||
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 0 ||
      cursor.offset > selected.length ||
      !Number.isSafeInteger(cursor.queued) ||
      cursor.queued < 0
    )
      throw Error('FROZEN_FORMAT_CHECKPOINT_INVALID');
    let processed = 0;
    while (cursor.offset < selected.length && processed < options.limit) {
      const item = selected[cursor.offset]!;
      const queued = await writer.$transaction(async (tx) => {
        const parent = await tx.stateBill.findUnique({
          where: { id: item.billKey },
          select: { legiscanBillId: true, reportSourceFacts: true },
        });
        if (!parent || parent.legiscanBillId !== item.providerBillId)
          throw Error('FROZEN_FORMAT_PARENT_MISSING_OR_CHANGED');
        const facts = (parent.reportSourceFacts ?? {}) as Record<string, any>;
        const formats = mergeDocumentStubs(facts.retainedDocumentFormats, item.formats);
        await tx.stateBill.update({
          where: { id: item.billKey },
          select: { id: true },
          data: {
            reportSourceFacts: {
              ...facts,
              retainedDocumentFormats: formats.map((format) => ({ ...format })),
            },
          },
        });
        const checks = item.formats.map((stub) => ({ identity: stateDocumentCheckIdentity(stub) }));
        const added =
          await tx.$executeRaw`INSERT INTO state_bill_record_check(bill_key,kind,source_identity,state,attempts,next_check_at)
          SELECT ${item.billKey},'document',d.identity,'pending',0,clock_timestamp()
          FROM jsonb_to_recordset(${JSON.stringify(checks)}::jsonb) d(identity text) ON CONFLICT DO NOTHING`;
        const next = { offset: cursor.offset + 1, queued: cursor.queued + added };
        await tx.$executeRaw`UPDATE federal_evidence_checkpoint SET cursor_jsonb=${JSON.stringify(next)}::jsonb,
          status=${next.offset === selected.length ? 'completed' : 'running'},
          completed_at=CASE WHEN ${next.offset === selected.length} THEN clock_timestamp() ELSE NULL END,
          updated_at=clock_timestamp() WHERE source=${checkpoint}`;
        return added;
      });
      cursor.offset++;
      cursor.queued += queued;
      processed++;
    }
    return {
      receiptId,
      primaryReceiptId: manifest.primaryReceiptId,
      archiveHash: scope.archiveHash,
      formatDocuments: selected.reduce((n, b) => n + b.formats.length, 0),
      formatBills: selected.length,
      ...cursor,
      processed,
      complete: cursor.offset === selected.length,
      providerCalls: 0,
      primaryDocumentsChanged: 0,
    };
  });
}
