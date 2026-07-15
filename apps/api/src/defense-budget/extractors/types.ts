/**
 * Shared extractor types + budget-line IDENTITY classification.
 *
 * The single most important correctness rule in DoD budget ingestion
 * (defense-budget-document-ingestion.md §"Semantic guardrails"):
 *
 *   R-1                 = RDT&E Program Element (PE)
 *   R-2 / R-2A / R-3    = RDT&E PE narrative / project / performer
 *   P-1 / P-5 / P-40    = Procurement BLIN (line item) — NEVER a PE, even when a
 *                         P-40 references PEs in its narrative
 *   O-1 / OP-5          = O&M budget-activity / activity-group / sub-activity-group (SAG)
 *   C-1 / DD 1391       = MILCON / family-housing project
 *
 *   An R-3 names a PERFORMING_ACTIVITY, not a PRIME_CONTRACTOR (unless the source
 *   explicitly states a contractor role).
 *   NDAA values are AUTHORIZATION, never appropriations.
 *   Execution changes stay separate from enacted appropriations.
 *   Titles are aliases, NOT natural keys — match codes + account context first.
 *   Money is stored as exact decimal/integer with its original unit (never binary float).
 */

export type LineKind = 'RDTE_PE' | 'PROCUREMENT_BLIN' | 'OM_SAG' | 'MILCON_PROJECT' | 'UNKNOWN';

export type ExhibitType =
  | 'R-1' | 'R-2' | 'R-2A' | 'R-3' | 'R-4'
  | 'P-1' | 'P-5' | 'P-40'
  | 'O-1' | 'OP-5'
  | 'C-1'
  | 'committee_report' | 'conference_report' | 'public_law';

export type PerformerRole = 'PERFORMING_ACTIVITY' | 'PRIME_CONTRACTOR';

/** Money kept exactly as printed, with the unit it was printed in. */
export interface Money {
  /** Exact numeric value as printed (e.g. 1234.567). Never rounded here. */
  value: number;
  /** 'thousands' | 'millions' | 'dollars' — the unit the source printed. */
  unit: 'thousands' | 'millions' | 'dollars';
}

/** Page + table + row/col provenance for a single extracted value. */
export interface ValueProvenance {
  /** PDF page index (1-based, physical page in the PDF). */
  pdfPage: number;
  /** Printed page label as it appears on the page (e.g. "Volume 1 - 17"), if any. */
  printedPage?: string;
  /** Exhibit this value came from. */
  exhibit: ExhibitType;
  /** Table/section label, e.g. "Cost ($ in Thousands)". */
  tableLabel?: string;
  /** Row label (line title) and column label (FY / phase). */
  rowLabel?: string;
  colLabel?: string;
  /** direct = printed verbatim; derived = computed (with a formula). */
  derivation: 'direct' | 'derived';
  derivationFormula?: string;
  /** How this value was obtained. */
  extractionMethod: 'llamaparse' | 'deterministic_pdfplumber' | 'manual';
  /** 0..1 confidence. */
  confidence: number;
}

/** A single independent per-FY per-field money assertion for a budget line. */
export interface YearValueAssertion {
  lineKind: LineKind;
  /** Canonical identity code for the line (PE code, BLIN, SAG code). */
  code: string;
  /** Procurement/O&M account + component context so identical codes don't collapse. */
  account?: string;
  component?: string;
  fy: number;
  /** request | hascMark | sascMark | hacdMark | sacdMark | enacted | quantity | ... */
  fieldName: string;
  money?: Money;
  /** Non-money values (e.g. quantities as integers, or text). */
  quantity?: number;
  valueText?: string;
  provenance: ValueProvenance;
}

/** A PE-level or line-level catalog/narrative assertion (title, mission, BA). */
export interface LineAssertion {
  lineKind: LineKind;
  code: string;
  title: string;
  account?: string;
  component?: string;
  budgetActivity?: string;
  /** For R-2A projects. */
  projectCode?: string;
  mission?: string;
  /** For R-3 performers. */
  performerName?: string;
  performerRole?: PerformerRole;
  /** Cross-references a P-40 makes to PE codes (recorded as refs, NOT as new PEs). */
  referencedPeCodes?: string[];
  provenance: ValueProvenance;
}

export interface ExtractionResult {
  lineAssertions: LineAssertion[];
  yearValues: YearValueAssertion[];
  /** Non-fatal issues (unparseable rows, ambiguous units) surfaced for review. */
  warnings: string[];
}

/** 7 digits + a component letter (+ optional trailing) e.g. 0602308A, 0603790F. */
const PE_CODE_RE = /^[0-9]{7}[A-Z][A-Z0-9]*$/;

export function isValidPeCode(code: string): boolean {
  return PE_CODE_RE.test(code.trim());
}

/**
 * Classify a line's identity from the exhibit it was found in. This is exhibit-driven,
 * NOT title/code-pattern-driven, so a P-40 that cites a PE code is still a procurement
 * BLIN. Only R-series exhibits produce RDTE_PE lines.
 */
export function classifyLineKind(exhibit: ExhibitType): LineKind {
  switch (exhibit) {
    case 'R-1':
    case 'R-2':
    case 'R-2A':
    case 'R-3':
    case 'R-4':
      return 'RDTE_PE';
    case 'P-1':
    case 'P-5':
    case 'P-40':
      return 'PROCUREMENT_BLIN';
    case 'O-1':
    case 'OP-5':
      return 'OM_SAG';
    case 'C-1':
      return 'MILCON_PROJECT';
    default:
      return 'UNKNOWN';
  }
}

/** Parse a printed money token exactly. "(1,234)" => -1234; "$5,678.9" => 5678.9. Null when blank/dash. */
export function parseMoneyToken(token: string | null | undefined): number | null {
  if (token == null) return null;
  const t = String(token).trim();
  if (t === '' || t === '-' || t === '—') return null;
  const neg = /^\(.*\)$/.test(t);
  const cleaned = t.replace(/[(),$\s]/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

/** Detect the printed unit from a table label like "($ in Thousands)". Defaults to thousands (J-book norm). */
export function detectUnit(label: string | undefined): Money['unit'] {
  if (!label) return 'thousands';
  const l = label.toLowerCase();
  if (l.includes('million')) return 'millions';
  if (l.includes('thousand')) return 'thousands';
  if (l.includes('dollar')) return 'dollars';
  return 'thousands';
}
