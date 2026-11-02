import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import type { BillStructuredSection } from './bill-document-structure.js';
export const CHUNKER_VERSION = 'bill-structured-utf16-v2';
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export type Cursor = { id: string; chunk: number; extractionId?: string };
export type Section = { locator: string; text: string } & Partial<BillStructuredSection>;
export type Passage = Section & {
  ordinal: number;
  start: number;
  end: number;
  section: number;
  sectionStartOffset: number;
  sectionEndOffset: number;
};
/** Every nonempty section is searchable. Long sections overlap by a modest bounded amount. */
export function passages(
  sections: Section[],
  size = 4000,
  overlap = Math.min(300, Math.floor(size / 10)),
): Passage[] {
  if (
    !Number.isSafeInteger(size) ||
    size < 20 ||
    size > 7000 ||
    !Number.isSafeInteger(overlap) ||
    overlap < 0 ||
    overlap >= size / 2
  )
    throw Error('INVALID_CHUNK_SIZE');
  const result: Passage[] = [];
  let documentOffset = 0;
  sections.forEach((section, sectionIndex) => {
    const base = section.startOffset ?? documentOffset;
    for (let start = 0; start < section.text.length;) {
      let end = Math.min(start + size, section.text.length);
      if (end < section.text.length) {
        const window = section.text.slice(start + Math.floor(size * 0.7), end);
        const boundaries = [...window.matchAll(/(?:[.!?]\s+|\n)/g)];
        const boundary = boundaries.at(-1);
        if (boundary) end = start + Math.floor(size * 0.7) + boundary.index! + boundary[0].length;
      }
      if (end < section.text.length && /[\uD800-\uDBFF]/.test(section.text[end - 1]!)) end--;
      result.push({
        ...section,
        text: section.text.slice(start, end),
        ordinal: result.length,
        section: sectionIndex,
        start: base + start,
        end: base + end,
        sectionStartOffset: start,
        sectionEndOffset: end,
      });
      if (end === section.text.length) break;
      start = Math.max(start + 1, end - overlap);
      if (/[\uDC00-\uDFFF]/.test(section.text[start]!)) start++;
    }
    documentOffset = base + section.text.length + 1;
  });
  return result;
}
export function passageMetadata(chunk: Passage) {
  return {
    chunkerVersion: CHUNKER_VERSION,
    ordinal: chunk.ordinal,
    section: chunk.section,
    locator: chunk.locator,
    sourceLocator: chunk.sourceLocator ?? chunk.locator,
    sectionPath: chunk.path ?? [],
    sectionNumber: chunk.number ?? null,
    heading: chunk.heading ?? null,
    definitionTerms: chunk.definitionTerms ?? [],
    references: chunk.references ?? [],
    tables: (chunk.tables ?? []).filter(
      (t) => t.endOffset > chunk.sectionStartOffset && t.startOffset < chunk.sectionEndOffset,
    ),
    startOffset: chunk.start,
    endOffset: chunk.end,
    sectionStartOffset: chunk.sectionStartOffset,
    sectionEndOffset: chunk.sectionEndOffset,
    offsetUnit: 'UTF-16',
    offsetBasis: 'structured_document_text',
    semanticAvailable: chunk.text.trim().length >= 10,
  };
}
export function parseCursor(raw?: string): Cursor {
  if (!raw) return { id: '', chunk: -1 };
  const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
  if (
    typeof c.id !== 'string' ||
    !/^[a-zA-Z0-9_~-]{0,128}$/.test(c.id) ||
    !Number.isSafeInteger(c.chunk) ||
    c.chunk < -1 ||
    (c.extractionId !== undefined &&
      (typeof c.extractionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(c.extractionId)))
  )
    throw Error('INVALID_CURSOR');
  return c;
}
export const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
export function parseBillTextArgs(argv: string[], env: NodeJS.ProcessEnv) {
  const { values: a } = parseArgs({
    args: argv,
    options: {
      source: { type: 'string' },
      phase: { type: 'string' },
      limit: { type: 'string' },
      after: { type: 'string' },
      commit: { type: 'boolean' },
      'expected-host': { type: 'string' },
    },
  });
  if (a.source !== 'federal' && a.source !== 'state')
    throw Error('SOURCE_MUST_BE_FEDERAL_OR_STATE');
  const phase = a.phase ?? 'embed';
  if (phase !== 'extract' && phase !== 'embed') throw Error('PHASE_MUST_BE_EXTRACT_OR_EMBED');
  const limit = Number(a.limit ?? 100);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw Error('LIMIT_MUST_BE_1_TO_1000');
  const host = env.DATABASE_URL ? new URL(env.DATABASE_URL).hostname : env.DB_HOST;
  if (a.commit && (!a['expected-host'] || host !== a['expected-host']))
    throw Error('DATABASE_HOST_MISMATCH');
  // The persisted checkpoint is authoritative in write mode; arbitrary jumps could skip unfinished work.
  if (a.commit && a.after) throw Error('COMMIT_USES_DURABLE_CURSOR');
  return {
    source: a.source as 'federal' | 'state',
    phase: phase as 'extract' | 'embed',
    limit,
    commit: a.commit === true,
    cursor: parseCursor(a.after),
  };
}
