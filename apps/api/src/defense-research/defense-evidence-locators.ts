import type { DefenseEvidenceLocatorDetailsDto } from '@capiro/shared';

export function unavailableLocator(reason: string): DefenseEvidenceLocatorDetailsDto {
  return {
    availability: 'unavailable',
    reason,
    printedPage: null,
    tableLabel: null,
    rowLabel: null,
    columnLabel: null,
    textSpan: null,
    boundingBox: null,
    structuredElement: null,
    sourceSpanHash: null,
  };
}

export function occurrenceSpan(row: {
  startOffset?: number | null;
  endOffset?: number | null;
  exactSpan?: string;
  revisionId: string;
  sectionId?: string | null;
  section?: { id: string; revisionId: string; contentText?: string | null } | null;
}): { start: number; end: number } | null {
  const { startOffset: start, endOffset: end, section } = row;
  return Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start! >= 0 &&
    end! > start! &&
    section?.id === row.sectionId &&
    section?.revisionId === row.revisionId &&
    typeof section?.contentText === 'string' &&
    end! <= section.contentText.length &&
    section.contentText.slice(start!, end!) === row.exactSpan
    ? { start: start!, end: end! }
    : null;
}
