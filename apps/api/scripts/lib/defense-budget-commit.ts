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
  | 'sign_mismatch'
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

  // Opposite signs mean these are not the same figure at a different scale — a
  // positive request and a negative rescission/adjustment are different facts.
  // Comparing only magnitudes would report such a pair as a 1,000x candidate and
  // let a sign mismatch reach provenAffected, which must never count as proof.
  if (Math.sign(candidate) !== Math.sign(reference)) return 'sign_mismatch';

  const ratio = Math.abs(candidate) / Math.abs(reference);
  if (ratio >= 0.98 && ratio <= 1.02) return 'same_scale';
  if (ratio >= 980 && ratio <= 1_020) return 'candidate_1000x_reference';
  if (ratio >= 0.00098 && ratio <= 0.00102) return 'candidate_1_1000x_reference';
  return 'different_scale';
}

/**
 * Pick the single observation this promotion just created, so it can be linked to
 * the exact SourceDocument.
 *
 * Extracted as a pure function because the fail-closed rule is the whole safety
 * property and it must be provable without a database. The writer creates
 * per-field observations via ReconciliationService and one `__row__` observation
 * per PE/FY row; the caller snapshots the ids that existed BEFORE the writer ran
 * and passes them here so historical rows — including historical rows that still
 * have `sourceDocumentId = null` — can never be adopted by a new promotion.
 *
 * Anything other than exactly one new candidate throws, which aborts the
 * surrounding canonical transaction rather than linking a guess.
 *
 * NOTE (Phase D): this guarantees fail-closed linking of observations created by
 * THIS promotion. It does not make repeated promotion of the same source
 * idempotent at the observation level — durable observation keys are Phase D.
 */
export function selectPromotedObservationId(input: {
  preExistingIds: Iterable<string>;
  candidates: readonly { id: string; sourceDocumentId?: string | null }[];
  label: string;
}): string {
  const preExisting = new Set(input.preExistingIds);
  const fresh = input.candidates.filter(
    (candidate) => !preExisting.has(candidate.id) && candidate.sourceDocumentId == null,
  );
  if (fresh.length !== 1) {
    throw new Error(
      `Expected exactly one new canonical observation for ${input.label}; found ${fresh.length}`,
    );
  }
  return fresh[0]!.id;
}

export type UnitAuditBucket = 'provenAffected' | 'needsHumanReview' | 'notAffected';

export interface UnitAuditEvidence {
  /** True only when the recorded canonical field winner is a LlamaParse source. */
  canonicalIsLlama: boolean;
  /** One classification per same-PE/FY/field deterministic comparator. */
  classifications: readonly UnitRatioClassification[];
  /** sha256 + archive bucket + key + immutable VersionId are all present. */
  hasArchiveProof: boolean;
  /** A succeeded parse job exists whose inputSha256 equals the source SHA. */
  hasMatchingParseProof: boolean;
}

export interface UnitAuditVerdict {
  bucket: UnitAuditBucket;
  reason: string;
}

/**
 * Decide which audit bucket one PE/FY/field belongs in. Extracted as a pure
 * function so the proof rule is executably testable rather than only asserted as
 * source text: nothing reaches `provenAffected` without a LlamaParse canonical
 * winner, immutable archive linkage, a matching parse artifact, AND a bounded
 * ~1,000x deterministic comparator. Magnitude alone is never proof.
 */
export function classifyUnitAuditFinding(evidence: UnitAuditEvidence): UnitAuditVerdict {
  const { canonicalIsLlama, classifications, hasArchiveProof, hasMatchingParseProof } = evidence;
  const thousandScale = classifications.includes('candidate_1000x_reference');
  const sameScale = classifications.includes('same_scale');
  const documented = hasArchiveProof && hasMatchingParseProof;

  if (canonicalIsLlama && thousandScale && documented) {
    return {
      bucket: 'provenAffected',
      reason:
        'Canonical winner is LlamaParse, exact source/archive/parse linkage exists, and a same-field deterministic observation is approximately 1,000x smaller. Repair still requires exact artifact replay or human verification; this report does not mutate data.',
    };
  }
  if (canonicalIsLlama && sameScale && documented) {
    return {
      bucket: 'notAffected',
      reason:
        'Canonical winner is LlamaParse and at least one deterministic same-field observation is on the same scale with complete archive/parse linkage.',
    };
  }
  if (!canonicalIsLlama) {
    return {
      bucket: 'notAffected',
      reason:
        'A LlamaParse observation exists, but it is not the recorded canonical field winner. No canonical repair is indicated by this observation.',
    };
  }
  return {
    bucket: 'needsHumanReview',
    reason:
      classifications.length === 0
        ? 'LlamaParse is canonical but no same-field deterministic comparator exists.'
        : !documented
          ? 'LlamaParse is canonical but exact archive/parse provenance is incomplete.'
          : 'LlamaParse is canonical, but comparator ratios are ambiguous or inconsistent; magnitude alone is not proof.',
  };
}
