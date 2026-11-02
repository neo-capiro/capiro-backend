import type { PrismaClient } from '@prisma/client';
import {
  extractBillDocumentStructure,
  type BillDocumentStructure,
} from './bill-document-structure.js';
import {
  byteHash,
  decodeFederalUtf8,
  qualifyFederalOriginal,
  readFederalBytes,
  type FederalOriginalBytes,
} from './federal-document-bytes.js';
import {
  federalDate,
  federalHash,
  qualifiedFederalTextUrl,
  type FederalTextVersion,
} from './federal-billstatus.js';
import {
  loadFederalInventories,
  selectFederalInventories,
  type FederalGeneration,
} from './federal-bill-inventory.js';
import { writeFederalReceipt, type FederalReceipt } from './federal-billstatus-import.js';
import { parseFederalBillInventory } from './federal-bill-inventory-read.js';
import { persistFederalEvidenceSnapshot } from '../program-element/federal-evidence/persistence.js';

export type FederalPublication = {
  rawContent: string;
  originalBytes: FederalOriginalBytes;
  extractedText: string;
  completeness: 'complete' | 'partial' | 'unreadable';
  structure?: BillDocumentStructure;
  warnings: string[];
  sourceUrl: string;
  format: string;
};
export async function fetchFederalPublication(
  version: FederalTextVersion,
  options: {
    beforeAttempt: () => Promise<void>;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    /** Persist each captured original before trying another format or spending more budget. */
    onCapture?: (capture: FederalPublication) => Promise<void>;
  },
): Promise<FederalPublication> {
  const formats = [...version.formats].sort(
    (a, b) =>
      ['xml', 'html', 'txt', 'pdf'].indexOf(a.type) - ['xml', 'html', 'txt', 'pdf'].indexOf(b.type),
  );
  if (!formats.length) throw Error('FEDERAL_PUBLICATION_UNAVAILABLE');
  const fetchImpl = options.fetchImpl ?? fetch,
    sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError: Error = Error('FEDERAL_PUBLICATION_UNAVAILABLE');
  let best: FederalPublication | null = null;
  formatLoop: for (const format of formats) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let url = qualifiedFederalTextUrl(format.url).href;
      let captureWriteFailed = false;
      try {
        for (let redirects = 0; redirects <= 5; redirects++) {
          await options.beforeAttempt();
          const signal = AbortSignal.timeout(60000),
            candidate = await fetchImpl(url, { signal, redirect: 'manual' });
          if ([301, 302, 303, 307, 308].includes(candidate.status)) {
            void candidate.body?.cancel().catch(() => {});
            const location = candidate.headers.get('location');
            if (!location || redirects === 5) throw Error('FEDERAL_PUBLICATION_REDIRECT_INVALID');
            url = qualifiedFederalTextUrl(new URL(location, url).href).href;
            continue;
          }
          if (!candidate.ok) {
            void candidate.body?.cancel().catch(() => {});
            if (candidate.status === 429 || candidate.status >= 500) {
              const seconds = Number(candidate.headers.get('retry-after'));
              await sleep(
                Number.isFinite(seconds) && seconds > 0
                  ? Math.min(seconds * 1000, 300000)
                  : 1000 * 2 ** attempt,
              );
            } else if (candidate.status === 404 || candidate.status === 410) {
              attempt = 3;
            }
            throw Error(`FEDERAL_PUBLICATION_HTTP_${candidate.status}`);
          }
          const bytes = await readFederalBytes(candidate, signal);
          if (!bytes.length) throw Error('FEDERAL_PUBLICATION_EMPTY_BODY');
          const mime =
            candidate.headers.get('content-type') ??
            (format.type === 'pdf'
              ? 'application/pdf'
              : format.type === 'xml'
                ? 'application/xml'
                : format.type === 'html'
                  ? 'text/html'
                  : 'text/plain');
          const originalBytes: FederalOriginalBytes = {
            base64: bytes.toString('base64'),
            sha256: byteHash(bytes),
            mime,
          };
          let rawContent = '',
            extractedText = '',
            completeness: FederalPublication['completeness'] = 'unreadable',
            structure: BillDocumentStructure | undefined;
          const warnings: string[] = [];
          if (format.type === 'pdf') {
            originalBytes.encoding = 'pdf';
            rawContent = originalBytes.base64;
          } else {
            try {
              rawContent = decodeFederalUtf8(bytes, mime);
            } catch (error) {
              originalBytes.encoding = 'unsupported';
              warnings.push(
                error instanceof Error ? error.message : 'FEDERAL_DOCUMENT_ENCODING_UNSUPPORTED',
              );
            }
          }
          if (originalBytes.encoding !== 'unsupported') {
            try {
              if (format.type === 'xml' && /^\s*(?:<!DOCTYPE html|<html)/i.test(rawContent))
                throw Error('FEDERAL_PUBLICATION_FORMAT_MISMATCH');
              structure = await extractBillDocumentStructure(
                bytes,
                format.type === 'pdf'
                  ? 'application/pdf'
                  : format.type === 'xml'
                    ? 'application/xml'
                    : format.type === 'html'
                      ? 'text/html'
                      : 'text/plain',
              );
              extractedText = structure.text;
              completeness = structure.completeness;
              warnings.push(...structure.warnings);
            } catch (error) {
              warnings.push(
                error instanceof Error ? error.message : 'FEDERAL_PUBLICATION_EXTRACTION_FAILED',
              );
            }
          }
          // Cite the pinned publisher URL; redirects are transport provenance only.
          const capture: FederalPublication = {
            rawContent,
            originalBytes,
            extractedText,
            completeness,
            structure,
            warnings,
            sourceUrl: format.url,
            format: format.type,
          };
          try {
            await options.onCapture?.(capture);
          } catch (error) {
            captureWriteFailed = true;
            throw error;
          }
          if (capture.completeness === 'complete') return capture;
          if (
            !best ||
            (capture.completeness === 'partial' && best.completeness === 'unreadable') ||
            (capture.completeness === best.completeness &&
              capture.extractedText.length > best.extractedText.length)
          )
            best = capture;
          // An HTTP-success response may still be unreadable. Other listed official
          // formats are independent retrieval options for the same provider version.
          continue formatLoop;
        }
      } catch (error) {
        if (
          captureWriteFailed ||
          (error instanceof Error &&
            /^(?:CONGRESS_REQUEST_CAP_REACHED|FEDERAL_WRITER_)/.test(error.message))
        )
          throw error;
        lastError = error instanceof Error ? error : Error('FEDERAL_PUBLICATION_FETCH_FAILED');
      }
    }
  }
  if (best) return best;
  throw lastError;
}

type Retained = {
  rawContent: string;
  extractedText: string;
  completeness: string;
  metadata: Record<string, any>;
  sourceUrl: string;
  observation: Record<string, any>;
  originManifest: Record<string, any> | null;
  originComplete: boolean | null;
};
/** Unchanged bytes can be reused only through an exact immutable receipt binding and freshness. */
export function retainedFederalVersionMatches(
  row: Retained,
  receipt: FederalReceipt,
  version: FederalTextVersion,
): boolean {
  return (
    row.completeness === 'complete' &&
    Boolean(row.extractedText.trim()) &&
    retainedFederalOriginalMatches(row, receipt, version)
  );
}
function retainedFederalOriginalMatches(
  row: Retained,
  receipt: FederalReceipt,
  version: FederalTextVersion,
): boolean {
  if (
    !version.formats.some((format) => format.url === row.sourceUrl) ||
    row.observation.providerDocumentId !== receipt.manifest.providerDocumentId ||
    row.observation.providerVersionId !== version.versionId
  )
    return false;
  if (row.observation.sourceInventoryReceiptId !== receipt.id) {
    const origin = row.originManifest;
    if (
      !row.originComplete ||
      !origin ||
      !receipt.manifest.providerUpdatedAt ||
      origin.providerUpdatedAt !== receipt.manifest.providerUpdatedAt ||
      origin.providerDocumentId !== receipt.manifest.providerDocumentId ||
      origin.kind !== receipt.manifest.kind ||
      !Array.isArray(origin.versions) ||
      !origin.versions.some(
        (old: FederalTextVersion) =>
          old.versionId === version.versionId &&
          old.packageId === version.packageId &&
          old.collection === version.collection &&
          old.versionCode === version.versionCode &&
          old.formats.some((format) => format.url === row.sourceUrl),
      )
    )
      return false;
  }
  try {
    qualifyFederalOriginal(
      row.rawContent,
      {
        base64: row.metadata.originalBytesBase64,
        sha256: row.metadata.rawBytesHash,
        mime: row.metadata.originalMime,
        encoding:
          row.metadata.rawContentEncoding === 'base64'
            ? 'pdf'
            : row.metadata.originalBytesEncoding === 'unsupported'
              ? 'unsupported'
              : 'utf8',
      },
      { completeness: row.completeness, extractedText: row.extractedText },
    );
    return true;
  } catch {
    return false;
  }
}
export async function hydrateFederalInventories(
  db: PrismaClient,
  generation: FederalGeneration,
  options: { limit: number; beforeAttempt: () => Promise<void>; fetchImpl?: typeof fetch },
) {
  const selected = selectFederalInventories(
      await loadFederalInventories(db, generation),
      generation,
    ),
    tasks: Array<{ receipt: FederalReceipt; version: FederalTextVersion }> = [];
  const discovery = {
    receiptId: '',
    congress: generation.congress,
    billIds: generation.billIds,
    requiredInventoryReceiptIds: [],
    observedAt: new Date(),
  };
  for (const receipt of selected.values()) {
    if (!receipt.complete) continue;
    if (!parseFederalBillInventory(receipt, discovery))
      throw Error('FEDERAL_HYDRATION_INVENTORY_INVALID');
    for (const version of receipt.manifest.versions as FederalTextVersion[])
      if (version.formats.length) tasks.push({ receipt, version });
  }
  tasks.sort((a, b) =>
    `${a.receipt.manifest.providerDocumentId}:${a.version.versionId}`.localeCompare(
      `${b.receipt.manifest.providerDocumentId}:${b.version.versionId}`,
    ),
  );
  const source = `fy26-federal-hydrate:${generation.inventoryHash}`;
  await db.$executeRawUnsafe(
    "INSERT INTO federal_evidence_checkpoint(source,status,cursor_jsonb) VALUES($1,'running','{\"offset\":0}'::jsonb) ON CONFLICT DO NOTHING",
    source,
  );
  const rows = await db.$queryRawUnsafe<Array<{ cursor: { offset: number } }>>(
    'SELECT cursor_jsonb AS cursor FROM federal_evidence_checkpoint WHERE source=$1',
    source,
  );
  let offset = rows[0]?.cursor.offset;
  if (!Number.isInteger(offset) || offset! < 0) throw Error('FEDERAL_HYDRATION_CHECKPOINT_INVALID');
  offset = tasks.length ? offset! % tasks.length : 0;
  let processed = 0,
    retained = 0,
    failed = 0,
    unavailable = 0,
    unreadable = 0,
    partial = 0,
    scanned = 0,
    capped = false;
  while (scanned < tasks.length && scanned < options.limit) {
    const task = tasks[offset]!;
    const { receipt, version } = task;
    const previous = await db.$queryRawUnsafe<Retained[]>(
      `SELECT r.raw_content AS "rawContent",r.extracted_text AS "extractedText",r.completeness,r.metadata_jsonb AS metadata,r.source_url AS "sourceUrl",o.metadata_jsonb AS observation,p.manifest AS "originManifest",p.complete AS "originComplete"
      FROM federal_evidence_revision r JOIN federal_evidence_observation o ON o.revision_id=r.id
      LEFT JOIN legal_source_receipt p ON p.id=o.metadata_jsonb->>'sourceInventoryReceiptId' AND p.source='fy26-federal-provider-inventory'
      WHERE r.bill_id=$1 AND r.collection=$2 AND r.package_id=$3 AND r.version_code IS NOT DISTINCT FROM $4
      AND o.metadata_jsonb->>'providerDocumentId'=$5 AND o.metadata_jsonb->>'providerVersionId'=$6
      ORDER BY o.id DESC LIMIT 20`,
      receipt.scope.billId,
      version.collection,
      version.packageId,
      version.versionCode,
      receipt.manifest.providerDocumentId,
      version.versionId,
    );
    if (previous.some((row) => retainedFederalVersionMatches(row, receipt, version))) retained++;
    else {
      try {
        const retainedOriginals = previous.filter((row) =>
          retainedFederalOriginalMatches(row, receipt, version),
        );
        const capturedUrls = new Set(retainedOriginals.map((row) => row.sourceUrl));
        const untriedFormats = version.formats.filter((format) => !capturedUrls.has(format.url));
        // A small request cap must still reach an alternate on the next invocation.
        // Once every format has been captured, a later pass may retry changed bytes.
        const doc = await fetchFederalPublication(
          untriedFormats.length ? { ...version, formats: untriedFormats } : version,
          {
            ...options,
            onCapture: async (capture) => {
              const provider = new URL(capture.sourceUrl).hostname.includes('govinfo.gov')
                ? 'govinfo'
                : 'congress.gov';
              await persistFederalEvidenceSnapshot(db, {
                provider,
                collection: version.collection,
                packageId: version.packageId!,
                billId: receipt.scope.billId,
                versionCode: version.versionCode,
                lineageKey:
                  version.collection === 'BILLS'
                    ? `${receipt.scope.billId}:${receipt.scope.billId.split('-')[1].startsWith('h') ? 'house' : 'senate'}`
                    : `${receipt.scope.billId}:${receipt.manifest.providerDocumentId}`,
                sourceUrl: capture.sourceUrl,
                sourceModifiedAt: federalDate(receipt.manifest.providerUpdatedAt),
                publishedAt: federalDate(version.date),
                inventoryWindowEnd: new Date(receipt.observedAt),
                observationKey: `fy26:${federalHash(JSON.stringify([receipt.id, version.versionId, capture.sourceUrl, capture.format, capture.originalBytes.sha256]))}`,
                rawContent: capture.rawContent,
                originalBytes: capture.originalBytes,
                extractedText: capture.extractedText,
                completeness: capture.completeness,
                historical: true,
                metadata: {
                  providerDocumentId: receipt.manifest.providerDocumentId,
                  providerVersionId: version.versionId,
                  sourceInventoryReceiptId: receipt.id,
                  ...(receipt.manifest.amendmentId
                    ? { amendmentId: receipt.manifest.amendmentId }
                    : {}),
                  versionType: version.type,
                  rawVersionDate: version.date,
                  format: capture.format,
                  publicationUrl: capture.sourceUrl,
                  extractionWarnings: capture.warnings,
                  ...(capture.structure ? { billStructure: capture.structure } : {}),
                },
              });
            },
          },
        );
        if (
          doc.completeness === 'partial' ||
          (doc.completeness === 'unreadable' &&
            retainedOriginals.some(
              (row) => row.completeness === 'partial' && row.extractedText.trim(),
            ))
        )
          partial++;
        else if (doc.completeness === 'unreadable') unreadable++;
        processed++;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'FEDERAL_HYDRATION_FAILED';
        if (message === 'CONGRESS_REQUEST_CAP_REACHED') {
          capped = true;
          break;
        }
        if (message.startsWith('FEDERAL_WRITER_')) throw error;
        failed++;
        processed++;
        if (/HTTP_(?:404|410)$/.test(message)) unavailable++;
        await writeFederalReceipt(
          db,
          'fy26-federal-text-attempt',
          {
            fiscalYear: 2026,
            congress: generation.congress,
            billId: receipt.scope.billId,
            sourceInventoryReceiptId: receipt.id,
            providerVersionId: version.versionId,
          },
          {
            schemaVersion: 1,
            status: /HTTP_(?:404|410)$/.test(message) ? 'unavailable' : 'failed',
            error: message.replace(/api_key=[^&\s]+/gi, 'api_key=[REDACTED]').slice(0, 500),
            attemptedAt: new Date().toISOString(),
          },
          false,
        );
      }
    }
    scanned++;
    offset = (offset + 1) % Math.max(tasks.length, 1);
    await db.$executeRawUnsafe(
      "UPDATE federal_evidence_checkpoint SET cursor_jsonb=$2::jsonb,status='running',updated_at=clock_timestamp() WHERE source=$1",
      source,
      JSON.stringify({ offset }),
    );
  }
  return {
    processed,
    retained,
    failed,
    unavailable,
    unreadable,
    partial,
    scanned,
    listedVersions: tasks.length,
    capped,
    complete:
      scanned === tasks.length && failed === 0 && unreadable === 0 && partial === 0 && !capped,
  };
}
