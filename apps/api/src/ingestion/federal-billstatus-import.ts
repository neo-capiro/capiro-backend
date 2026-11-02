import type { PrismaClient } from '@prisma/client';
import { isDeepStrictEqual } from 'node:util';
import { replaceCongressBillClassificationsAtomically } from './congress-classifications.js';
import { FEDERAL_FY26_SQL } from './bill-text-scope.js';
import { withFederalBillWriter } from './federal-bill-writer.js';
import {
  federalDate,
  federalHash,
  federalIdentity,
  inspectFrozenFederalBillStatus,
  type FederalBulkScope,
  type FederalBulkBill,
  type FederalTextVersion,
  replayFederalExactDuplicates,
  type FederalExactDuplicateProof,
} from './federal-billstatus.js';

export type FederalReceipt = {
  id: string;
  source: string;
  scope: Record<string, any>;
  manifest: Record<string, any>;
  complete: boolean;
  observedAt: Date | string;
};
export type ReceiptWriter = Pick<PrismaClient, '$executeRawUnsafe' | '$queryRawUnsafe'>;
/** Existing immutable receipt owner; retries verify the same content instead of replacing it. */
export async function writeFederalReceipt(
  db: ReceiptWriter,
  source: string,
  scope: Record<string, unknown>,
  manifest: Record<string, unknown>,
  complete: boolean,
): Promise<string> {
  const id = federalHash(JSON.stringify([source, scope, manifest, complete]));
  await db.$executeRawUnsafe(
    'INSERT INTO legal_source_receipt(id,source,scope,manifest,complete) VALUES($1,$2,$3::jsonb,$4::jsonb,$5) ON CONFLICT DO NOTHING',
    id,
    source,
    JSON.stringify(scope),
    JSON.stringify(manifest),
    complete,
  );
  const rows = await db.$queryRawUnsafe<Array<{ id: string }>>(
    'SELECT id FROM legal_source_receipt WHERE id=$1 AND source=$2 AND scope=$3::jsonb AND manifest=$4::jsonb AND complete=$5',
    id,
    source,
    JSON.stringify(scope),
    JSON.stringify(manifest),
    complete,
  );
  if (rows.length !== 1) throw Error('FEDERAL_RECEIPT_CONFLICT');
  return id;
}
export function federalInventoryManifest(input: {
  kind: 'text' | 'amendment';
  providerDocumentId: string;
  providerUpdatedAt: string | null;
  versions: FederalTextVersion[];
  amendmentId?: string;
  exactDuplicateProof?: FederalExactDuplicateProof;
}) {
  const replay =
    input.exactDuplicateProof === undefined
      ? null
      : replayFederalExactDuplicates(
          input.providerDocumentId,
          input.kind,
          input.exactDuplicateProof,
        );
  if (replay && !isDeepStrictEqual(replay.versions, input.versions))
    throw Error('FEDERAL_DUPLICATE_PROOF_VERSION_MISMATCH');
  return {
    schemaVersion: 1,
    ...input,
    reportedCount: replay?.reportedCount ?? input.versions.length,
    enumeratedCount: replay?.enumeratedCount ?? input.versions.length,
    ...(replay
      ? { distinctVersionCount: input.versions.length, exactDuplicateCount: replay.duplicateCount }
      : {}),
  };
}
export async function writeFederalInventory(
  db: ReceiptWriter,
  scope: Record<string, unknown>,
  input: Parameters<typeof federalInventoryManifest>[0],
  complete: boolean,
) {
  return writeFederalReceipt(
    db,
    'fy26-federal-provider-inventory',
    scope,
    federalInventoryManifest(input),
    complete,
  );
}
export async function stageFederalAmendmentList(
  db: PrismaClient,
  bytes: Buffer,
  hash: string,
  congress: number,
  expectedCount: number,
) {
  if (bytes.length > 10_000_000 || !/^[a-f0-9]{64}$/.test(hash) || federalHash(bytes) !== hash)
    throw Error('FEDERAL_AMENDMENT_LIST_HASH_MISMATCH');
  const list: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!Array.isArray(list) || list.length !== expectedCount)
    throw Error('FEDERAL_AMENDMENT_LIST_COUNT_MISMATCH');
  const ids = list.map((value) => federalIdentity(value, true)).sort();
  if (ids.some((id) => !id.startsWith(`${congress}-`)) || new Set(ids).size !== ids.length)
    throw Error('FEDERAL_AMENDMENT_LIST_IDENTITY_MISMATCH');
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      'INSERT INTO legal_dataset_archive(content_hash,original_bytes_base64) VALUES($1,$2) ON CONFLICT DO NOTHING',
      hash,
      bytes.toString('base64'),
    );
    const retained = await tx.$queryRawUnsafe<unknown[]>(
      'SELECT content_hash FROM legal_dataset_archive WHERE content_hash=$1 AND original_bytes_base64=$2',
      hash,
      bytes.toString('base64'),
    );
    if (retained.length !== 1) throw Error('FEDERAL_AMENDMENT_LIST_ARCHIVE_CONFLICT');
    return writeFederalReceipt(
      tx,
      'fy26-federal-amendment-list',
      { fiscalYear: 2026, congress, archiveHash: hash },
      { schemaVersion: 1, ids, reportedCount: expectedCount, enumeratedCount: ids.length },
      true,
    );
  });
}

/** Apply only the two historically partial subresources, under the standard Congress writer lease. */
export async function enrichFederalBulkMetadata(
  db: PrismaClient,
  bill: FederalBulkBill,
  archiveHash: string,
  acquisitionSource: 'govinfo-billstatus' | 'congress-api' = 'govinfo-billstatus',
) {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe<Array<{ updateDate: Date | null }>>(
      'SELECT update_date AS "updateDate" FROM congress_bill WHERE id=$1 FOR UPDATE',
      bill.id,
    );
    if (rows.length !== 1) throw Error('BILLSTATUS_CANONICAL_PARENT_MISSING');
    const sourceDate = federalDate(bill.metadataUpdatedAt);
    const receipts = await tx.$queryRawUnsafe<Array<{ providerUpdatedAt: string | null }>>(
      `SELECT manifest->>'providerUpdatedAt' AS "providerUpdatedAt" FROM legal_source_receipt
       WHERE source='fy26-federal-metadata' AND scope->>'billId'=$1 AND complete`,
      bill.id,
    );
    const held =
      !sourceDate ||
      Boolean(rows[0]!.updateDate && rows[0]!.updateDate.getTime() > sourceDate.getTime()) ||
      receipts.some(
        (receipt) =>
          (federalDate(receipt.providerUpdatedAt)?.getTime() ?? 0) > sourceDate!.getTime(),
      );
    if (!held) {
      await replaceCongressBillClassificationsAtomically(tx as unknown as PrismaClient, bill.id, {
        subjects: bill.subjects,
      });
      await tx.congressBillCosponsor.deleteMany({ where: { billId: bill.id } });
      if (bill.cosponsors.length)
        await tx.congressBillCosponsor.createMany({
          data: bill.cosponsors.map((c) => ({
            ...c,
            billId: bill.id,
            sponsorshipDate: federalDate(c.sponsorshipDate),
            withdrawnDate: federalDate(c.withdrawnDate),
          })),
        });
      await tx.congressBill.update({
        where: { id: bill.id },
        select: { id: true },
        data: {
          subjects: bill.subjects,
          cosponsorsCount: bill.cosponsors.filter((c) => !c.withdrawnDate).length,
        },
      });
    }
    await writeFederalReceipt(
      tx,
      'fy26-federal-metadata',
      { fiscalYear: 2026, congress: Number(bill.id.split('-')[0]), billId: bill.id, archiveHash },
      {
        schemaVersion: 1,
        acquisitionSource,
        providerUpdatedAt: bill.metadataUpdatedAt,
        subjectsCount: bill.subjects.length,
        cosponsorsCount: bill.cosponsors.length,
        cosponsorEpisodes: bill.cosponsorEpisodes,
        activeCosponsorsCount: bill.cosponsors.filter((c) => !c.withdrawnDate).length,
        subjectsChecked: !held,
        cosponsorsChecked: !held,
        heldForNewerCanonicalMetadata: held,
      },
      !held,
    );
    return held ? 'held' : 'enriched';
  });
}

export async function importFrozenFederalBillStatus(
  prisma: PrismaClient,
  archive: Buffer,
  scope: FederalBulkScope,
  options: {
    limit: number;
    inventoryOnly?: boolean;
    amendmentList?: { bytes: Buffer; hash: string; expectedCount: number };
  },
) {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000)
    throw Error('BILLSTATUS_IMPORT_LIMIT_INVALID');
  const prepared = await inspectFrozenFederalBillStatus(archive, scope);
  return withFederalBillWriter(prisma, async (db) => {
    if (options.amendmentList)
      await stageFederalAmendmentList(
        db,
        options.amendmentList.bytes,
        options.amendmentList.hash,
        scope.congress,
        options.amendmentList.expectedCount,
      );
    const admitted = await db.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT b.id FROM congress_bill b WHERE b.congress=$1 AND lower(b.bill_type)=$2 AND ${FEDERAL_FY26_SQL} ORDER BY b.id`,
      scope.congress,
      scope.billType,
    );
    if (
      JSON.stringify(admitted.map((b) => b.id).sort()) !==
      JSON.stringify(prepared.eligible.map((b) => b.id).sort())
    )
      throw Error('BILLSTATUS_CANONICAL_ELIGIBILITY_MISMATCH');
    const receiptScope = {
      fiscalYear: 2026,
      congress: scope.congress,
      billType: scope.billType,
      archiveHash: scope.archiveHash,
    };
    const receiptId = await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'INSERT INTO legal_dataset_archive(content_hash,original_bytes_base64) VALUES($1,$2) ON CONFLICT DO NOTHING',
        scope.archiveHash,
        archive.toString('base64'),
      );
      const retained = await tx.$queryRawUnsafe<unknown[]>(
        'SELECT content_hash FROM legal_dataset_archive WHERE content_hash=$1 AND original_bytes_base64=$2',
        scope.archiveHash,
        archive.toString('base64'),
      );
      if (retained.length !== 1) throw Error('BILLSTATUS_ARCHIVE_CONFLICT');
      return writeFederalReceipt(
        tx,
        'fy26-federal-billstatus-archive',
        receiptScope,
        prepared.manifest,
        true,
      );
    });
    if (options.inventoryOnly)
      return {
        receiptId,
        inventoryBills: prepared.eligible.length,
        processed: 0,
        complete: false,
        providerCalls: 0,
      };
    const source = `fy26-federal-billstatus:${scope.archiveHash}`;
    await db.$executeRawUnsafe(
      "INSERT INTO federal_evidence_checkpoint(source,status,cursor_jsonb) VALUES($1,'running',$2::jsonb) ON CONFLICT DO NOTHING",
      source,
      JSON.stringify({ offset: 0, enriched: 0, held: 0 }),
    );
    const rows = await db.$queryRawUnsafe<
      Array<{ cursor: { offset: number; enriched: number; held: number } }>
    >('SELECT cursor_jsonb AS cursor FROM federal_evidence_checkpoint WHERE source=$1', source);
    const cursor = rows[0]?.cursor;
    if (
      !cursor ||
      [cursor.offset, cursor.enriched, cursor.held].some((n) => !Number.isInteger(n) || n < 0) ||
      cursor.offset > prepared.eligible.length ||
      cursor.enriched + cursor.held !== cursor.offset
    )
      throw Error('BILLSTATUS_CHECKPOINT_INVALID');
    let processed = 0;
    while (cursor.offset < prepared.eligible.length && processed < options.limit) {
      const bill = prepared.eligible[cursor.offset]!;
      const result = await db.$transaction(async (tx) => {
        const result = await enrichFederalBulkMetadata(
          tx as unknown as PrismaClient,
          bill,
          scope.archiveHash,
        );
        await writeFederalInventory(
          tx,
          {
            fiscalYear: 2026,
            congress: scope.congress,
            billId: bill.id,
            archiveHash: scope.archiveHash,
          },
          {
            kind: 'text',
            providerDocumentId: bill.id,
            providerUpdatedAt: bill.providerUpdatedAt,
            versions: bill.versions,
          },
          bill.versions.every((v) => v.formats.length > 0),
        );
        const next = { ...cursor, offset: cursor.offset + 1, [result]: cursor[result] + 1 };
        await tx.$executeRawUnsafe(
          "UPDATE federal_evidence_checkpoint SET cursor_jsonb=$2::jsonb,status=$3,completed_at=CASE WHEN $3='completed' THEN clock_timestamp() ELSE NULL END,updated_at=clock_timestamp() WHERE source=$1",
          source,
          JSON.stringify(next),
          next.offset === prepared.eligible.length ? 'completed' : 'running',
        );
        return result;
      });
      cursor.offset++;
      cursor[result]++;
      processed++;
    }
    if (cursor.offset === prepared.eligible.length)
      await db.$executeRawUnsafe(
        "UPDATE federal_evidence_checkpoint SET status='completed',completed_at=COALESCE(completed_at,clock_timestamp()) WHERE source=$1",
        source,
      );
    return {
      receiptId,
      inventoryBills: prepared.eligible.length,
      processed,
      ...cursor,
      complete: cursor.offset === prepared.eligible.length,
      providerCalls: 0,
    };
  });
}
