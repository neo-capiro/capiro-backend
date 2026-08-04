/**
 * r3-performer-normalizer — normalize performer names for identity matching.
 *
 * Workstream J (Phase 4 plan §15). Keeps the raw printed name and a
 * separately normalized form. Never last-wins conflicting normalizations.
 *
 * Pure module.
 */

/** Corporate suffixes stripped for normalization (not deleted from raw). */
const CORP_SUFFIX_RE =
  /\b(?:inc\.?|incorporated|llc\.?|l\.?l\.?c\.?|corp\.?|corporation|ltd\.?|limited|co\.?|company|plc\.?|lp\.?|l\.?p\.?|gmbh|ag|sa|nv|bv)\b\.?/gi;

/** Whitespace collapse. */
const MULTI_WS_RE = /\s+/g;

/**
 * Normalize a performer name for identity matching.
 *
 * Rules:
 *   - trim and collapse whitespace;
 *   - strip trailing corporate suffixes (Inc, LLC, Corp, etc.);
 *   - uppercase for case-insensitive matching;
 *   - never invent a name; empty input returns empty.
 */
export function normalizePerformerName(raw: string): string {
  let s = raw.trim();
  if (s === '') return '';

  /* Strip corporate suffixes repeatedly (e.g. "Acme Inc. LLC"). */
  let prev = '';
  while (prev !== s) {
    prev = s;
    s = s.replace(CORP_SUFFIX_RE, '').trim();
  }

  /* Collapse whitespace and uppercase. */
  s = s.replace(MULTI_WS_RE, ' ').trim().toUpperCase();

  /* Strip trailing punctuation left after suffix removal. */
  s = s.replace(/[.,;:\-]+$/g, '').trim();

  return s;
}

/**
 * Natural identity key for an R-3 performer row.
 * PE + project + performerNormalized + location + contractMethod + costCategory + cycle/FY + source
 */
export function r3PerformerNaturalKey(input: {
  peCode: string;
  projectCode?: string;
  performerNormalized: string;
  location?: string;
  contractMethod?: string;
  costCategory?: string;
  fiscalYear?: number;
  sourceKey?: string;
}): string {
  return [
    input.peCode,
    input.projectCode ?? '',
    input.performerNormalized,
    input.location ?? '',
    input.contractMethod ?? '',
    input.costCategory ?? '',
    input.fiscalYear != null ? String(input.fiscalYear) : '',
    input.sourceKey ?? '',
  ].join('|');
}
