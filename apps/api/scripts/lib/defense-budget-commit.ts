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
 * Pick the observation this promotion should link to the exact SourceDocument.
 *
 * Fail-closed for ambiguous matches. Supports:
 * 1) Exactly one fresh unlinked observation created by this write (primary path)
 * 2) Exactly one candidate already linked to preferredSourceDocumentId (idempotent replay)
 *
 * Historical null-linked rows remain excluded via preExistingIds (they never count as fresh).
 */
export function selectPromotedObservationId(input: {
  preExistingIds: Iterable<string>;
  candidates: readonly { id: string; sourceDocumentId?: string | null }[];
  label: string;
  /** When set, accept an observation already linked to this document (replay). */
  preferredSourceDocumentId?: string | null;
}): string {
  const preExisting = new Set(input.preExistingIds);
  const fresh = input.candidates.filter(
    (candidate) => !preExisting.has(candidate.id) && candidate.sourceDocumentId == null,
  );
  if (fresh.length === 1) return fresh[0]!.id;
  if (fresh.length > 1) {
    throw new Error(
      `Expected exactly one new canonical observation for ${input.label}; found ${fresh.length}`,
    );
  }

  if (input.preferredSourceDocumentId) {
    const already = input.candidates.filter(
      (candidate) => candidate.sourceDocumentId === input.preferredSourceDocumentId,
    );
    if (already.length === 1) return already[0]!.id;
    if (already.length > 1) {
      throw new Error(
        `Expected exactly one observation linked to source document for ${input.label}; found ${already.length}`,
      );
    }
  }

  throw new Error(
    `Expected exactly one new canonical observation for ${input.label}; found 0`,
  );
}

/** Stable observation key for the PE/FY row audit stamp (__row__). */
export function buildRowObservationKey(input: {
  sourceDocumentId: string;
  source: string;
  peCode: string;
  fy: number;
  sourceSha256: string;
}): string {
  return [
    'row',
    input.sourceDocumentId,
    input.source,
    input.peCode,
    String(input.fy),
    input.sourceSha256,
  ].join(':');
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
 * ~1,000x deterministic comparator that no other comparator contradicts.
 * Magnitude alone is never proof.
 */
export function classifyUnitAuditFinding(evidence: UnitAuditEvidence): UnitAuditVerdict {
  const { canonicalIsLlama, classifications, hasArchiveProof, hasMatchingParseProof } = evidence;
  const thousandScale = classifications.includes('candidate_1000x_reference');
  const sameScale = classifications.includes('same_scale');
  const documented = hasArchiveProof && hasMatchingParseProof;

  if (!canonicalIsLlama) {
    return {
      bucket: 'notAffected',
      reason:
        'A LlamaParse observation exists, but it is not the recorded canonical field winner. No canonical repair is indicated by this observation.',
    };
  }

  // `classifications` carries one entry per same-PE/FY/field deterministic
  // comparator, so a row can legitimately hold BOTH a ~1,000x comparator and a
  // same-scale one. That is contradictory evidence, not proof: a same-scale
  // deterministic source independently agrees with the stored canonical value, and
  // the same-scale branch below treats exactly that agreement as DISPROOF. Ranking
  // the 1,000x branch first would let one evidence set be simultaneously "proven"
  // and "disproven" and silently resolve to "proven" — so an approved repair would
  // divide by 1,000 a value another source confirms. Ambiguity is a human's call.
  if (thousandScale && sameScale) {
    return {
      bucket: 'needsHumanReview',
      reason:
        'LlamaParse is canonical and one deterministic same-field observation is approximately 1,000x smaller, but another is on the SAME scale as the canonical value. The comparators contradict each other, so corruption is not proven and no repair is indicated without human adjudication.',
    };
  }
  if (thousandScale && documented) {
    return {
      bucket: 'provenAffected',
      reason:
        'Canonical winner is LlamaParse, exact source/archive/parse linkage exists, and a same-field deterministic observation is approximately 1,000x smaller with no same-scale comparator contradicting it. Repair still requires exact artifact replay or human verification; this report does not mutate data.',
    };
  }
  if (sameScale && documented) {
    return {
      bucket: 'notAffected',
      reason:
        'Canonical winner is LlamaParse and at least one deterministic same-field observation is on the same scale with complete archive/parse linkage.',
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

/**
 * Canonical promotion requires immutable archive proof. S3 returns a VersionId
 * only on a versioned bucket, so its absence means the promoted bytes cannot be
 * re-fetched at the exact version this run read.
 *
 * These three guards are extracted so the fail-closed rules are proven by
 * EXECUTION rather than by asserting the text of an `if` in the ingest script.
 */
export function assertImmutableArchive(archive: { versionId?: string | null }): void {
  if (!archive.versionId) {
    throw new Error(
      'Immutable source archive did not return an S3 VersionId; canonical promotion is blocked.',
    );
  }
}

/** A retired document must never be promoted as the current source version. */
export function assertPromotableSourceDocument(document: {
  id: string;
  supersededByDocumentId?: string | null;
}): void {
  if (document.supersededByDocumentId) {
    throw new Error(
      `Approved source document ${document.id} is superseded by ${document.supersededByDocumentId}; promote the current source version instead.`,
    );
  }
}

/** The quality audit must be able to block promotion BEFORE any canonical write. */
export function assertQualityAuditPassed(audit: {
  status: 'ok' | 'warn' | 'fail';
  unitsAnomalies: number;
  titleTruncated: number;
}): void {
  if (audit.status === 'fail') {
    throw new Error(
      `Quality audit failed before canonical promotion: unitsAnomalies=${audit.unitsAnomalies} titleTruncated=${audit.titleTruncated}`,
    );
  }
}
