import type { MappedPeData } from '../../src/defense-budget/assertion-mapper.js';

const SHA256_RE = /^[a-f0-9]{64}$/;

export interface NormalizedValueManifestRow {
  peCode: string;
  fy: number;
  fieldName: string;
  originalValue: number;
  originalUnit: 'dollars' | 'thousands' | 'millions';
  canonicalValueM: number;
  pdfPage: number;
  printedPage: string | null;
  exhibit: string;
  tableLabel: string | null;
  rowLabel: string | null;
  colLabel: string | null;
  derivation: 'direct' | 'derived';
  extractionMethod: string;
  confidence: number;
  sourceDocumentId: string;
}

export type UnitRatioClassification =
  | 'same_scale'
  | 'candidate_1000x_reference'
  | 'candidate_1_1000x_reference'
  | 'different_scale'
  | 'not_comparable';

/** Require an explicit lowercase SHA-256 before canonical promotion. */
export function requireApprovedSha256(raw: string | undefined): string {
  if (!raw) {
    throw new Error('--commit requires --approved-sha256 <64 lowercase hex>');
  }
  if (!SHA256_RE.test(raw)) {
    throw new Error('--approved-sha256 must be exactly 64 lowercase hexadecimal characters');
  }
  return raw;
}

/** Compare operator approval to the bytes actually being promoted. */
export function assertApprovedShaMatches(actualSha256: string, approvedSha256: string): void {
  if (!SHA256_RE.test(actualSha256)) {
    throw new Error(`Actual source SHA-256 is malformed: ${actualSha256}`);
  }
  if (actualSha256 !== approvedSha256) {
    throw new Error(
      `Approved SHA-256 does not match source bytes: approved=${approvedSha256} actual=${actualSha256}`,
    );
  }
}

/**
 * Build the human-reviewable per-field manifest required before promotion.
 * Original source value/unit and canonical USD-millions value remain adjacent.
 */
export function buildNormalizedValueManifest(
  mapped: MappedPeData,
  sourceDocumentId: string,
): NormalizedValueManifestRow[] {
  return mapped.sourceValues.map((value) => ({
    peCode: value.peCode,
    fy: value.fy,
    fieldName: String(value.fieldName),
    originalValue: value.originalValue,
    originalUnit: value.originalUnit,
    canonicalValueM: value.valueM,
    pdfPage: value.provenance.pdfPage,
    printedPage: value.provenance.printedPage ?? null,
    exhibit: value.provenance.exhibit,
    tableLabel: value.provenance.tableLabel ?? null,
    rowLabel: value.provenance.rowLabel ?? null,
    colLabel: value.provenance.colLabel ?? null,
    derivation: value.provenance.derivation,
    extractionMethod: value.provenance.extractionMethod,
    confidence: value.provenance.confidence,
    sourceDocumentId,
  }));
}

/**
 * Compare absolute non-zero values with a 2% tolerance around 1× and 1,000×.
 * This is an AUDIT classifier only; callers must never use it to mutate money.
 */
export function classifyUnitRatio(
  candidate: number | null,
  reference: number | null,
): UnitRatioClassification {
  if (
    candidate == null ||
    reference == null ||
    !Number.isFinite(candidate) ||
    !Number.isFinite(reference) ||
    candidate === 0 ||
    reference === 0
  ) {
    return 'not_comparable';
  }

  const ratio = Math.abs(candidate) / Math.abs(reference);
  if (ratio >= 0.98 && ratio <= 1.02) return 'same_scale';
  if (ratio >= 980 && ratio <= 1_020) return 'candidate_1000x_reference';
  if (ratio >= 0.00098 && ratio <= 0.00102) return 'candidate_1_1000x_reference';
  return 'different_scale';
}
