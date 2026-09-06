import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

interface DocumentCursor {
  version: 1;
  documentId: string;
  clientId: string;
  contentHash: string;
  query: string;
  section: number;
  offset: number;
  sectionHash?: string;
}

export interface DocumentReadInput {
  documentId?: string;
  query: string;
  section: number;
  offset: number;
  limit: number;
  cursor?: DocumentCursor;
  listAfter?: string;
}

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const encode = (value: DocumentCursor) =>
  `document:${Buffer.from(JSON.stringify(value)).toString('base64url')}`;

export function parseDocumentReadInput(
  input: Record<string, unknown>,
  clientId: string,
): DocumentReadInput {
  const optionalText = (key: string, max: number) => {
    const value = input[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value.trim() || value.length > max)
      throw new BadRequestException(`${key} is invalid`);
    return value.trim();
  };
  const documentId = optionalText('documentId', 80);
  const query = optionalText('query', 240) ?? '';
  const cursorValue = optionalText('cursor', 4096);
  const limit = input.limit ?? (documentId ? 5000 : 25);
  if (
    typeof limit !== 'number' ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > (documentId ? 6000 : 50)
  ) {
    throw new BadRequestException(`limit must be between 1 and ${documentId ? 6000 : 50}`);
  }
  let section = input.section ?? 1;
  let offset = input.characterOffset ?? 0;
  let cursor: DocumentCursor | undefined;
  let listAfter: string | undefined;
  if (cursorValue) {
    if (input.section !== undefined || input.characterOffset !== undefined)
      throw new BadRequestException('Use cursor or section/characterOffset, not both');
    if (!documentId) {
      if (!/^documents:[a-zA-Z0-9-]{1,80}$/.test(cursorValue))
        throw new BadRequestException('Invalid document-list cursor');
      listAfter = cursorValue.slice('documents:'.length);
    } else {
      try {
        if (!cursorValue.startsWith('document:')) throw new Error('format');
        cursor = JSON.parse(
          Buffer.from(cursorValue.slice(9), 'base64url').toString('utf8'),
        ) as DocumentCursor;
        if (
          cursor.version !== 1 ||
          cursor.documentId !== documentId ||
          cursor.clientId !== clientId ||
          cursor.query !== query ||
          !/^[a-f0-9]{64}$/.test(cursor.contentHash)
        )
          throw new Error('scope');
        section = cursor.section;
        offset = cursor.offset;
      } catch {
        throw new BadRequestException(
          'Document cursor does not match the document, client, or query',
        );
      }
    }
  }
  if (
    typeof section !== 'number' ||
    !Number.isSafeInteger(section) ||
    section < 1 ||
    typeof offset !== 'number' ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw new BadRequestException(
      'section and characterOffset must be valid nonnegative integers; section starts at 1',
    );
  if (!documentId && (input.section !== undefined || input.characterOffset !== undefined))
    throw new BadRequestException('Section reads require documentId');
  return { documentId, query, section, offset, limit, cursor, listAfter };
}

interface ExtractedDocument {
  attachmentId: string;
  fileName: string;
  contentType: string;
  contentHash: string;
  source: string;
  text: string;
  section?: number;
  sectionCount?: number;
  sectionKind?: string;
  sectionLabel?: string;
  rowStart?: number;
  rowEnd?: number;
  truncated?: boolean;
  extractionMetadata?: unknown;
  disclosure?: string;
}

/** Metadata precedes records so even an outer tool budget retains the next
 * read and source limitations. A page is complete only for its declared range. */
export function buildDocumentReadPage(
  clientId: string,
  input: DocumentReadInput,
  extracted: ExtractedDocument,
) {
  const sectionHash = digest(extracted.text);
  if (
    input.cursor &&
    (input.cursor.contentHash !== extracted.contentHash ||
      (input.cursor.sectionHash && input.cursor.sectionHash !== sectionHash))
  ) {
    throw new BadRequestException('Document changed since the previous page; restart the read');
  }
  if (input.offset > extracted.text.length)
    throw new BadRequestException('characterOffset is outside this section');
  const match = input.query
    ? extracted.text.toLowerCase().indexOf(input.query.toLowerCase(), input.offset)
    : input.offset;
  const start =
    match < 0 ? extracted.text.length : Math.max(input.offset, match - (input.query ? 240 : 0));
  let end = Math.min(
    extracted.text.length,
    Math.max(start + input.limit, match + input.query.length),
  );
  // The runtime's tool limit measures serialized characters. Quotes, control
  // characters and backslashes can otherwise cause it to cut an apparently
  // safe 6000-character excerpt before the continuation boundary.
  if (JSON.stringify(extracted.text.slice(start, end)).length > 6500) {
    let low = start;
    let high = end;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (JSON.stringify(extracted.text.slice(start, middle)).length <= 6500) low = middle;
      else high = middle - 1;
    }
    end = low;
  }
  const section = extracted.section ?? 1;
  const sectionCount = extracted.sectionCount ?? 1;
  const moreText = end < extracted.text.length;
  const moreSections = section < sectionCount;
  const nextCursor =
    moreText || moreSections
      ? encode({
          version: 1,
          documentId: extracted.attachmentId,
          clientId,
          contentHash: extracted.contentHash,
          query: input.query,
          section: moreText ? section : section + 1,
          offset: moreText ? end : 0,
          ...(moreText ? { sectionHash } : {}),
        })
      : null;
  const reference = `${extracted.attachmentId}:${extracted.contentHash.slice(0, 16)}:${section}:${start}-${end}`;
  const payload = {
    id: reference,
    documentId: extracted.attachmentId,
    title: extracted.fileName,
    fileName: extracted.fileName,
    contentType: extracted.contentType,
    source: extracted.source,
    section,
    sectionKind: extracted.sectionKind ?? 'document',
    sectionLabel: extracted.sectionLabel ?? 'Document text',
    rowStart: extracted.rowStart,
    rowEnd: extracted.rowEnd,
    characterStart: start,
    characterEnd: end,
    text: extracted.text.slice(start, end),
  };
  return {
    tool: 'read_client_documents',
    generatedAt: new Date().toISOString(),
    clientId,
    coverage: {
      contentScope: 'extractable_text_only',
      extractedSectionEmpty: !extracted.text.trim(),
      nextCursor,
      truncated: Boolean(nextCursor) || Boolean(extracted.truncated),
      complete:
        !input.query &&
        start === 0 &&
        section === 1 &&
        sectionCount === 1 &&
        !nextCursor &&
        !extracted.truncated,
      section,
      sectionCount,
      sectionCharacters: extracted.text.length,
      characterStart: start,
      characterEnd: end,
      sectionComplete: start === 0 && !moreText,
      query: input.query || null,
      matched: input.query ? match >= 0 : null,
      extractionTruncated: extracted.truncated ?? false,
      extractionMetadata: extracted.extractionMetadata ?? null,
      disclosure: extracted.disclosure ?? null,
      note: input.query
        ? 'Search applies to this section only. Follow nextCursor to search the remaining sections; clear query and read section for full surrounding text.'
        : 'Follow nextCursor for all remaining text/pages/slides/sheet rows. Empty extracted pages may require visual/OCR review.',
    },
    records: [
      {
        recordId: reference,
        payload,
        provenance: {
          sourceTable: 'engagement_attachment',
          sourceRecordId: extracted.attachmentId,
          clientId,
          contentHash: extracted.contentHash,
          sectionHash,
          section,
          characterStart: start,
          characterEnd: end,
          trust: 'external_untrusted',
        },
      },
    ],
  };
}
