import type { LegiscanBill } from '../external/legiscan/legiscan.client.js';
import { stateDocumentStubs, type StateDocumentStub } from './state-document-stub.js';

/** A separate projection: the frozen primary-document manifest never changes. */
export function alternateDocumentFormats(
  raw: Pick<LegiscanBill, 'texts'>,
  proof: { receiptId: string; archiveHash: string },
): StateDocumentStub[] {
  return (raw.texts ?? []).flatMap((doc) => {
    let url: URL;
    try {
      url = new URL(doc.alt_state_link ?? '');
    } catch {
      return [];
    }
    if (
      doc.alt_bill_text !== 1 ||
      doc.alt_mime !== 'application/pdf' ||
      !Number.isSafeInteger(doc.doc_id) ||
      doc.doc_id <= 0 ||
      !/^[a-f0-9]{32}$/i.test(doc.text_hash ?? '') ||
      !/^[a-f0-9]{32}$/i.test(doc.alt_text_hash ?? '') ||
      doc.text_hash!.toLowerCase() === doc.alt_text_hash!.toLowerCase() ||
      !Number.isInteger(doc.alt_text_size) ||
      doc.alt_text_size! <= 0 ||
      doc.alt_text_size! > 20_000_000 ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443')
    )
      return [];
    const primary = stateDocumentStubs({ texts: [doc] })[0]!;
    return [
      {
        ...primary,
        providerHash: doc.alt_text_hash!.toLowerCase(),
        stateUrl: url.href,
        url: null,
        mime: doc.alt_mime,
        size: doc.alt_text_size,
        format: {
          role: 'alternate' as const,
          primaryProviderHash: doc.text_hash!.toLowerCase(),
          ...proof,
        },
      },
    ];
  });
}

export function stateDocumentCheckIdentity(stub: StateDocumentStub): string {
  return `${stub.kind}:${stub.providerId}:${stub.providerHash?.toLowerCase() ?? 'unknown'}${stub.format ? ':' + stub.format.primaryProviderHash + ':alternate' : ''}`;
}

/** Immutable receipt, exact parent and primary binding precede alternate-byte persistence. */
export const QUALIFIED_STATE_FORMAT_SQL = `SELECT f.value AS stub FROM legal_source_receipt r
 JOIN legal_dataset_archive a ON a.content_hash=r.scope->>'archiveHash'
 JOIN legal_source_receipt p ON p.id=r.scope->>'primaryReceiptId'
 CROSS JOIN LATERAL jsonb_array_elements(r.manifest->'bills') b
 CROSS JOIN LATERAL jsonb_array_elements(b->'formats') f
 WHERE r.id=$1 AND r.source='fy26-state-frozen-formats' AND r.complete
 AND r.scope->>'archiveHash'=$2 AND r.manifest->>'schemaVersion'='1'
 AND r.manifest->>'sourceListComplete'='true' AND r.manifest->>'archiveHash'=a.content_hash AND r.manifest->>'primaryReceiptId'=p.id
 AND p.source='fy26-state-frozen-inventory' AND p.complete
 AND p.scope->>'archiveHash'=r.scope->>'archiveHash'
 AND b->>'billKey'=$3 AND b->>'providerBillId'=$4
 AND f.value->>'kind'='text' AND f.value->>'providerId'=$5
 AND f.value->>'providerHash'=$6 AND f.value->'format'->>'receiptId'=r.id
 AND f.value->'format'->>'archiveHash'=a.content_hash
 AND f.value->'format'->>'role'='alternate'
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.manifest->'bills') pb
 CROSS JOIN LATERAL jsonb_array_elements(pb->'documents') pd
 WHERE pb->>'billKey'=b->>'billKey' AND pb->>'providerBillId'=b->>'providerBillId'
 AND pd->>'kind'='text' AND pd->>'providerId'=f.value->>'providerId'
 AND lower(pd->>'providerHash')=f.value->'format'->>'primaryProviderHash')`;

export async function requireQualifiedAlternateFormat(
  db: { $queryRawUnsafe<T = unknown>(sql: string, ...args: unknown[]): Promise<T> },
  billKey: string,
  billId: number,
  stub: StateDocumentStub,
) {
  const proof = stub.format;
  if (
    !proof ||
    proof.role !== 'alternate' ||
    !/^[a-f0-9]{64}$/.test(proof.receiptId) ||
    !/^[a-f0-9]{64}$/.test(proof.archiveHash) ||
    !/^[a-f0-9]{32}$/.test(proof.primaryProviderHash)
  )
    throw Error('DOCUMENT_FORMAT_PROOF_REQUIRED');
  const rows = await db.$queryRawUnsafe<Array<{ stub: StateDocumentStub }>>(
    QUALIFIED_STATE_FORMAT_SQL,
    proof.receiptId,
    proof.archiveHash,
    billKey,
    String(billId),
    String(stub.providerId),
    stub.providerHash?.toLowerCase(),
  );
  const exact = rows[0]?.stub;
  if (
    rows.length !== 1 ||
    !exact ||
    ['kind', 'providerId', 'providerHash', 'mime', 'size', 'stateUrl', 'date', 'versionType'].some(
      (key) =>
        (exact[key as keyof StateDocumentStub] ?? null) !==
        (stub[key as keyof StateDocumentStub] ?? null),
    ) ||
    exact.format?.primaryProviderHash !== proof.primaryProviderHash ||
    exact.mime !== 'application/pdf'
  )
    throw Error('DOCUMENT_FORMAT_INVENTORY_MISMATCH');
  return exact;
}
