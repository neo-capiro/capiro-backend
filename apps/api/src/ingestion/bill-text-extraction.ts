import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  BILL_EXTRACTION_VERSION,
  billStructureHash,
  extractBillDocumentStructure,
  structureText,
  type BillDocumentStructure,
} from './bill-document-structure.js';
import { CHUNKER_VERSION, passages, passageMetadata } from './bill-text-passages.js';

export type BillExtractionInput = {
  sourceKind: 'federal' | 'state';
  revisionId: string;
  documentHash: string;
  rawContent?: string;
  format?: string;
  sourceMetadata?: {
    originalBytesBase64?: string;
    rawBytesHash?: string;
    originalBytesEncoding?: string;
    originalMime?: string;
    billStructure?: BillDocumentStructure;
  };
  evidence?: {
    contentSnapshotBase64?: string;
    mime?: string;
    structure?: BillDocumentStructure;
  };
};
export type StoredBillExtraction = {
  id: string;
  structure: BillDocumentStructure;
  completeness: BillDocumentStructure['completeness'] | 'failed';
};
export type BillWriteFence = (tx: Prisma.TransactionClient) => Promise<boolean>;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Extraction reads retained originals only; no publisher/provider calls are permitted here. */
export async function deriveBillExtraction(
  input: BillExtractionInput,
): Promise<Omit<StoredBillExtraction, 'id'>> {
  try {
    let bytes =
      input.sourceKind === 'state'
        ? Buffer.from(input.evidence?.contentSnapshotBase64 ?? '', 'base64')
        : Buffer.from(input.rawContent ?? '', 'utf8');
    if (
      !bytes.length &&
      !(input.sourceKind === 'federal' && input.sourceMetadata?.originalBytesBase64)
    )
      throw Error('ORIGINAL_SNAPSHOT_UNAVAILABLE');
    if (hash(bytes) !== input.documentHash) throw Error('ORIGINAL_SNAPSHOT_HASH_MISMATCH');
    if (input.sourceKind === 'federal' && input.sourceMetadata?.originalBytesBase64) {
      const original = Buffer.from(input.sourceMetadata.originalBytesBase64, 'base64');
      if (hash(original) !== input.sourceMetadata.rawBytesHash)
        throw Error('ORIGINAL_SNAPSHOT_HASH_MISMATCH');
      bytes = original;
      if (input.sourceMetadata.originalBytesEncoding === 'unsupported') {
        const structure = structureText('');
        structure.warnings = ['FEDERAL_DOCUMENT_ENCODING_UNSUPPORTED'];
        structure.structureHash = billStructureHash(structure);
        return { structure, completeness: 'unreadable' };
      }
    }
    const retained = input.evidence?.structure ?? input.sourceMetadata?.billStructure;
    if (
      retained?.parserVersion === BILL_EXTRACTION_VERSION &&
      ['complete', 'partial', 'unreadable'].includes(retained.completeness) &&
      typeof retained.text === 'string' &&
      retained.textHash === hash(retained.text) &&
      retained.structureHash === billStructureHash(retained) &&
      Array.isArray(retained.sections) &&
      retained.sections.every(
        (section) =>
          Number.isSafeInteger(section.startOffset) &&
          Number.isSafeInteger(section.endOffset) &&
          section.startOffset >= 0 &&
          section.endOffset >= section.startOffset &&
          section.endOffset <= retained.text.length &&
          retained.text.slice(section.startOffset, section.endOffset) === section.text,
      )
    )
      return { structure: retained, completeness: retained.completeness };

    const mime =
      input.sourceKind === 'state'
        ? (input.evidence?.mime ?? '')
        : ({
            xml: 'application/xml',
            html: 'text/html',
            htm: 'text/html',
            txt: 'text/plain',
            text: 'text/plain',
            pdf: 'application/pdf',
          }[input.format?.toLowerCase() ?? ''] ??
          input.format ??
          '');
    const structure = await extractBillDocumentStructure(bytes, mime);
    return { structure, completeness: structure.completeness };
  } catch (error) {
    const empty = structureText('');
    const code =
      error instanceof Error && /^ORIGINAL_SNAPSHOT_/.test(error.message)
        ? error.message
        : 'DOCUMENT_EXTRACTION_FAILED';
    const structure = { ...empty, warnings: [code] };
    structure.structureHash = billStructureHash(structure);
    return { structure, completeness: 'failed' };
  }
}

/** Complete snapshots are immutable and reused. Failed/partial attempts remain visible and retriable. */
export async function ensureBillTextExtraction(
  prisma: PrismaClient,
  input: BillExtractionInput,
  options: { commit: boolean; beforeWrite?: BillWriteFence },
): Promise<StoredBillExtraction> {
  const existing = await prisma.$queryRawUnsafe<
    Array<{ id: string; structure: BillDocumentStructure }>
  >(
    `SELECT id::text,structure_jsonb AS structure FROM bill_text_extraction
     WHERE source_kind=$1 AND revision_id=$2::uuid AND parser_version=$3 AND document_hash=$4
       AND completeness='complete' ORDER BY created_at DESC,id DESC LIMIT 1`,
    input.sourceKind,
    input.revisionId,
    BILL_EXTRACTION_VERSION,
    input.documentHash,
  );
  if (existing[0]) return { ...existing[0], completeness: 'complete' };
  const derived = await deriveBillExtraction(input);
  if (!options.commit) return { id: 'dry-run', ...derived };
  return prisma.$transaction(
    async (tx) => {
      if (options.beforeWrite && !(await options.beforeWrite(tx)))
        throw Error('BILL_TEXT_LEASE_LOST');
      const id = randomUUID();
      const inserted = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO bill_text_extraction(id,source_kind,revision_id,parser_version,document_hash,text_hash,
       structure_hash,extracted_text,structure_jsonb,completeness,warnings_jsonb)
       VALUES($1::uuid,$2,$3::uuid,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb)
       ON CONFLICT(source_kind,revision_id,parser_version,document_hash,structure_hash) DO NOTHING RETURNING id::text`,
        id,
        input.sourceKind,
        input.revisionId,
        BILL_EXTRACTION_VERSION,
        input.documentHash,
        derived.structure.textHash,
        derived.structure.structureHash,
        derived.structure.text,
        JSON.stringify(derived.structure),
        derived.completeness,
        JSON.stringify(derived.structure.warnings),
      );
      if (!inserted.length) {
        const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id::text FROM bill_text_extraction
       WHERE source_kind=$1 AND revision_id=$2::uuid AND parser_version=$3 AND document_hash=$4 AND structure_hash=$5`,
          input.sourceKind,
          input.revisionId,
          BILL_EXTRACTION_VERSION,
          input.documentHash,
          derived.structure.structureHash,
        );
        if (!rows[0]) throw Error('BILL_EXTRACTION_CONFLICT_NOT_VISIBLE');
        return { id: rows[0].id, ...derived };
      }
      const chunks = passages(derived.structure.sections);
      const rows = chunks.map((chunk) => ({
        ordinal: chunk.ordinal,
        start_offset: chunk.start,
        end_offset: chunk.end,
        content_text: chunk.text,
        metadata_jsonb: {
          ...passageMetadata(chunk),
          extractionId: id,
          textHash: derived.structure.textHash,
          structureHash: derived.structure.structureHash,
          previousPassageId: chunk.ordinal ? `${CHUNKER_VERSION}:${id}:${chunk.ordinal - 1}` : null,
          nextPassageId:
            chunk.ordinal + 1 < chunks.length
              ? `${CHUNKER_VERSION}:${id}:${chunk.ordinal + 1}`
              : null,
        },
      }));
      if (rows.length)
        await tx.$executeRawUnsafe(
          `INSERT INTO bill_text_passage
      (extraction_id,chunker_version,ordinal,start_offset,end_offset,content_text,metadata_jsonb)
      SELECT $1::uuid,$2,p.ordinal,p.start_offset,p.end_offset,p.content_text,p.metadata_jsonb
      FROM jsonb_to_recordset($3::jsonb) AS p(ordinal int,start_offset int,end_offset int,content_text text,metadata_jsonb jsonb)`,
          id,
          CHUNKER_VERSION,
          JSON.stringify(rows),
        );
      return { id, ...derived };
    },
    { timeout: 30000 },
  );
}
