import { createHash } from 'node:crypto';
import type {
  BillDocumentStructure,
  BillStructuredSection,
} from '../ingestion/bill-document-structure.js';
import type { BillTextDocumentRow, BillTextIdentity } from './bill-text-query.js';

export const BILL_READ_MAX_CHARS = 9000;
export const BILL_CONTEXT_MAX_CHARS = 6000;
export function billIdentity(row: BillTextDocumentRow): BillTextIdentity {
  const {
    sourceKind,
    billId,
    billNumber,
    jurisdiction,
    session,
    version,
    versionId,
    providerDocumentId,
    revisionId,
    revisionHash,
    documentHash,
    originalBytesHash,
    extractionId,
    structureHash,
    textHash,
    extractionVersion,
    sourceUrl,
    publishedDate,
  } = row;
  return {
    sourceKind,
    billId,
    billNumber,
    jurisdiction,
    session,
    version,
    versionId,
    providerDocumentId,
    revisionId,
    revisionHash,
    documentHash,
    originalBytesHash,
    extractionId,
    structureHash,
    textHash,
    extractionVersion,
    sourceUrl,
    publishedDate,
  };
}
export function checkedBillStructure(row: BillTextDocumentRow): BillDocumentStructure | null {
  if (
    !row.extractionId ||
    !row.text ||
    !row.structure ||
    ['failed', 'unreadable'].includes(row.completeness ?? '')
  )
    return null;
  const s = row.structure as BillDocumentStructure;
  if (
    s.text !== row.text ||
    s.textHash !== row.textHash ||
    s.structureHash !== row.structureHash ||
    createHash('sha256').update(s.text).digest('hex') !== s.textHash ||
    !Array.isArray(s.sections)
  )
    throw Error('BILL_EXTRACTION_INTEGRITY_FAILED');
  for (const part of s.sections) {
    if (
      !Number.isSafeInteger(part.startOffset) ||
      !Number.isSafeInteger(part.endOffset) ||
      part.startOffset < 0 ||
      part.endOffset > s.text.length ||
      part.endOffset < part.startOffset ||
      s.text.slice(part.startOffset, part.endOffset) !== part.text ||
      !Array.isArray(part.path) ||
      !Array.isArray(part.references) ||
      !Array.isArray(part.definitionTerms)
    )
      throw Error('BILL_SECTION_INTEGRITY_FAILED');
  }
  return s;
}
function safeBoundary(text: string, value: number): number {
  return value > 0 &&
    value < text.length &&
    /[\uD800-\uDBFF]/.test(text[value - 1]!) &&
    /[\uDC00-\uDFFF]/.test(text[value]!)
    ? value - 1
    : value;
}
export function billSectionMatches(section: BillStructuredSection, requested: string): boolean {
  const normalized = requested.replace(/\.+$/, '');
  return (
    section.locator === requested ||
    section.sourceLocator === requested ||
    section.number?.replace(/\.+$/, '') === normalized ||
    section.path.map((part) => part.replace(/\.+$/, '')).join('/') === normalized
  );
}

/** A definition includes its contiguous clauses and immutable page/table fragments. */
function definitionRun(
  section: BillStructuredSection,
  structure: BillDocumentStructure,
  legacyPdfHierarchy: boolean,
) {
  const run = [section];
  let structureIncomplete = false;
  if (!section.path.length)
    return { sections: run, structureIncomplete: /:\s*$/.test(section.text) };
  for (
    let index = structure.sections.indexOf(section) + 1;
    index < structure.sections.length;
    index++
  ) {
    const next = structure.sections[index]!;
    const previous = run.at(-1)!;
    if (!section.path.every((part, depth) => next.path[depth] === part)) break;
    const page = /^page:(\d+)$/.exec(previous.sourceLocator)?.[1];
    const nextPage = /^page:(\d+)$/.exec(next.sourceLocator)?.[1];
    const descendant = next.path.length > section.path.length;
    if (
      // v1 PDF paths can incorrectly nest numeric siblings. Keep their exact reads,
      // but do not infer clauses from that known-ambiguous hierarchy.
      (legacyPdfHierarchy && descendant) ||
      (page
        ? !nextPage || ![Number(page), Number(page) + 1].includes(Number(nextPage))
        : !descendant && next.sourceLocator !== previous.sourceLocator) ||
      next.startOffset < previous.endOffset ||
      structure.text.slice(previous.endOffset, next.startOffset).trim()
    ) {
      structureIncomplete = true;
      break;
    }
    run.push(next);
  }
  // A colon-only lead-in cannot establish a complete definition when its body
  // has no provable contiguous path (including retained legacy PDF extractions).
  return {
    sections: run,
    structureIncomplete: structureIncomplete || /:\s*$/.test(run.at(-1)!.text),
  };
}
export type BillReadCursor = {
  extractionId: string;
  revisionId: string;
  billId: string;
  jurisdiction: string;
  session: string;
  structureHash: string;
  offset: number;
  section?: string;
};
export function encodeBillReadCursor(
  row: Pick<
    BillTextDocumentRow,
    'extractionId' | 'revisionId' | 'billId' | 'jurisdiction' | 'session' | 'structureHash'
  >,
  offset: number,
  section?: string,
): string {
  return Buffer.from(
    JSON.stringify({
      extractionId: row.extractionId,
      revisionId: row.revisionId,
      billId: row.billId,
      jurisdiction: row.jurisdiction,
      session: row.session,
      structureHash: row.structureHash,
      offset,
      section,
    }),
  ).toString('base64url');
}
export function decodeBillReadCursor(raw: string): BillReadCursor {
  if (typeof raw !== 'string' || raw.length > 2000) throw Error('INVALID_BILL_READ_CURSOR');
  let cursor: BillReadCursor;
  try {
    cursor = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as BillReadCursor;
  } catch {
    throw Error('INVALID_BILL_READ_CURSOR');
  }
  if (
    !cursor ||
    [
      cursor.extractionId,
      cursor.revisionId,
      cursor.billId,
      cursor.jurisdiction,
      cursor.session,
      cursor.structureHash,
    ].some((v) => typeof v !== 'string' || !v || v.length > 160) ||
    !Number.isSafeInteger(cursor.offset) ||
    cursor.offset < 0 ||
    !/^[a-f0-9]{64}$/.test(cursor.structureHash)
  )
    throw Error('INVALID_BILL_READ_CURSOR');
  if (
    cursor.section !== undefined &&
    (typeof cursor.section !== 'string' || cursor.section.length > 200)
  )
    throw Error('INVALID_BILL_READ_CURSOR');
  return cursor;
}

/** Returns bounded verbatim context from the SAME immutable extraction. External law references remain explicit unresolved references. */
export function readBillDocument(
  row: BillTextDocumentRow,
  request: { offset?: number; length?: number; section?: string; contextChars?: number } = {},
) {
  const length = request.length ?? 3000,
    contextLimit = request.contextChars ?? 3000;
  if (
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > BILL_READ_MAX_CHARS ||
    !Number.isSafeInteger(contextLimit) ||
    contextLimit < 0 ||
    contextLimit > BILL_CONTEXT_MAX_CHARS
  )
    throw Error('INVALID_BILL_READ_LIMIT');
  const structure = checkedBillStructure(row);
  const common = {
    identity: billIdentity(row),
    title: row.title,
    kind: row.kind,
    status: row.status,
    completeness: row.completeness ?? 'unavailable',
    warnings: row.warnings ?? [],
    offsetUnit: 'UTF-16' as const,
    offsetBasis: 'structured_document_text' as const,
  };
  if (!structure)
    return {
      ...common,
      available: false,
      reason: row.extractionId ? 'EXTRACTION_NOT_READABLE' : 'EXTRACTION_NOT_AVAILABLE',
    };
  let matches = request.section
    ? structure.sections.filter((s) => billSectionMatches(s, request.section!))
    : [];
  if (request.section && !matches.length)
    return { ...common, available: false, reason: 'SECTION_NOT_FOUND' };
  // A bare section number shared by nested sections is ambiguous; callers can use the exact returned locator/path.
  if (
    request.section &&
    matches.length > 1 &&
    new Set(matches.map((s) => s.path.join('/'))).size > 1
  )
    return {
      ...common,
      available: false,
      reason: 'SECTION_AMBIGUOUS',
      sectionCandidates: matches.slice(0, 20).map((s) => ({ locator: s.locator, path: s.path })),
    };
  if (matches[0]?.path.length) {
    const rootPath = matches[0].path;
    matches = structure.sections.filter((section) =>
      rootPath.every((part, index) => section.path[index] === part),
    );
  }
  const requestedStart = request.offset ?? matches[0]?.startOffset ?? 0;
  if (
    !Number.isSafeInteger(requestedStart) ||
    requestedStart < 0 ||
    requestedStart > structure.text.length
  )
    throw Error('INVALID_BILL_READ_OFFSET');
  const sectionEnd = matches.length
    ? Math.max(...matches.map((s) => s.endOffset))
    : structure.text.length;
  if (matches.length && (requestedStart < matches[0]!.startOffset || requestedStart > sectionEnd))
    throw Error('OFFSET_OUTSIDE_SECTION');
  const startOffset = safeBoundary(structure.text, requestedStart);
  const endOffset = safeBoundary(structure.text, Math.min(sectionEnd, startOffset + length));
  if (endOffset === startOffset && startOffset < sectionEnd)
    throw Error('BILL_READ_LENGTH_CANNOT_SPLIT_UTF16_CHARACTER');
  const text = structure.text.slice(startOffset, endOffset);
  const selected = structure.sections.filter(
    (s) => s.startOffset < endOffset && s.endOffset > startOffset,
  );
  let remaining = contextLimit;
  const context: Array<{
    relation: 'definition' | 'reference' | 'previous' | 'next';
    locator: string;
    path: string[];
    startOffset: number;
    endOffset: number;
    text: string;
    truncated: boolean;
  }> = [];
  const added = new Set(
    selected
      .filter((s) => s.startOffset >= startOffset && s.endOffset <= endOffset)
      .map((s) => s.locator),
  );
  const add = (section: BillStructuredSection, relation: (typeof context)[number]['relation']) => {
    if (added.has(section.locator) || remaining < 1) return;
    const end = safeBoundary(
      structure.text,
      Math.min(section.endOffset, section.startOffset + remaining),
    );
    const body = structure.text.slice(section.startOffset, end);
    context.push({
      relation,
      locator: section.locator,
      path: section.path,
      startOffset: section.startOffset,
      endOffset: end,
      text: body,
      truncated: end < section.endOffset,
    });
    remaining -= body.length;
    added.add(section.locator);
  };
  const definitions = structure.sections.filter((s) =>
    s.definitionTerms.some((term) => text.toLowerCase().includes(term.toLowerCase())),
  );
  const definitionRuns = definitions.map((section) =>
    definitionRun(
      section,
      structure,
      row.extractionVersion === 'bill-structure-v1' && /^page:\d+$/.test(section.sourceLocator),
    ),
  );
  definitionRuns.forEach((run) => run.sections.forEach((section) => add(section, 'definition')));
  const references = [...new Set(selected.flatMap((s) => s.references))]
    .slice(0, 40)
    .map((reference) => {
      const target = structure.sections.filter(
        (s) =>
          billSectionMatches(s, reference) ||
          s.path.map((part) => part.replace(/\.+$/, '')).join('') === reference.replace(/\.+$/, ''),
      );
      if (target.length === 1) add(target[0]!, 'reference');
      return {
        reference,
        status:
          target.length === 1
            ? added.has(target[0]!.locator)
              ? 'same_document_candidate_included'
              : 'context_limit'
            : target.length
              ? 'ambiguous'
              : 'unresolved_external_or_absent',
        locator: target.length === 1 ? target[0]!.locator : null,
      };
    });
  // Add the surrounding part of a long section even when no neighboring section falls in this page.
  const surround = (
    start: number,
    end: number,
    relation: 'previous' | 'next',
    section: BillStructuredSection,
  ) => {
    if (remaining < 1 || start >= end) return;
    const from = safeBoundary(
      structure.text,
      relation === 'previous' ? Math.max(start, end - Math.min(800, remaining)) : start,
    );
    const to = safeBoundary(structure.text, Math.min(end, from + Math.min(800, remaining)));
    const body = structure.text.slice(from, to);
    if (body) {
      context.push({
        relation,
        locator: section.locator,
        path: section.path,
        startOffset: from,
        endOffset: to,
        text: body,
        truncated: from > start || to < end,
      });
      remaining -= body.length;
    }
  };
  if (selected[0]) surround(selected[0].startOffset, startOffset, 'previous', selected[0]);
  if (selected.at(-1)) surround(endOffset, selected.at(-1)!.endOffset, 'next', selected.at(-1)!);
  if (selected.length) {
    const first = structure.sections.indexOf(selected[0]!),
      last = structure.sections.indexOf(selected.at(-1)!);
    if (first > 0) add(structure.sections[first - 1]!, 'previous');
    if (last + 1 < structure.sections.length) add(structure.sections[last + 1]!, 'next');
  }
  const spans = [{ startOffset, endOffset }, ...context].sort(
    (a, b) => a.startOffset - b.startOffset,
  );
  const fullyIncluded = (section: BillStructuredSection) => {
    let through = section.startOffset;
    for (const span of spans) {
      if (span.endOffset <= through) continue;
      if (span.startOffset > through) return false;
      through = Math.max(through, span.endOffset);
      if (through >= section.endOffset) return true;
    }
    return through >= section.endOffset;
  };
  const includedDefinitions = definitionRuns.map((run) => run.sections.every(fullyIncluded));
  const completeDefinitions = definitionRuns.map(
    (run, index) => includedDefinitions[index] && !run.structureIncomplete,
  );
  definitionRuns.forEach((run, index) => {
    if (completeDefinitions[index]) return;
    // Even a complete page fragment must disclose that the logical definition's
    // following fragment was omitted when the budget ended at the page boundary.
    const locators = new Set(run.sections.map((section) => section.locator));
    const last = context
      .filter((part) => part.relation === 'definition' && locators.has(part.locator))
      .at(-1);
    if (last) last.truncated = true;
  });
  return {
    ...common,
    available: true,
    text,
    startOffset,
    endOffset,
    totalCharacters: structure.text.length,
    sections: selected.map((s) => ({
      locator: s.locator,
      sourceLocator: s.sourceLocator,
      path: s.path,
      number: s.number,
      heading: s.heading,
      startOffset: s.startOffset,
      endOffset: s.endOffset,
      tables: s.tables
        .filter(
          (t) =>
            s.startOffset + t.startOffset < endOffset && s.startOffset + t.endOffset > startOffset,
        )
        .map((t) => ({
          rows:
            s.startOffset + t.startOffset >= startOffset && s.startOffset + t.endOffset <= endOffset
              ? t.rows
              : null,
          status:
            s.startOffset + t.startOffset >= startOffset && s.startOffset + t.endOffset <= endOffset
              ? 'complete_in_page'
              : 'continues_outside_page',
          startOffset: s.startOffset + t.startOffset,
          endOffset: s.startOffset + t.endOffset,
        })),
    })),
    context,
    definitions: definitions.slice(0, 40).map((s, index) => ({
      terms: s.definitionTerms,
      locator: s.locator,
      status: !includedDefinitions[index]
        ? 'context_limit'
        : definitionRuns[index]!.structureIncomplete
          ? 'structure_incomplete'
          : 'included',
    })),
    references,
    referencesTruncated: new Set(selected.flatMap((s) => s.references)).size > references.length,
    definitionsTruncated: definitions.length > 40,
    contextTruncated: remaining === 0 || completeDefinitions.some((complete) => !complete),
    nextCursor:
      endOffset < sectionEnd ? encodeBillReadCursor(row, endOffset, request.section) : null,
  };
}
