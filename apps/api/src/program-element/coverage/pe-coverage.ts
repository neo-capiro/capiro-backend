/**
 * Pure helpers for PE ingest accuracy guards + coverage classification.
 *
 * Kept dependency-free (no Prisma, no NestJS) so they are unit-tested by the
 * standard jest matcher and reusable by both the loaders (guards) and the
 * coverage report (classification). No I/O here.
 *
 * Two concerns:
 *  1. ACCURACY GUARDS — measure whether an extracted artifact looks complete &
 *     well-formed BEFORE/AS it loads (title-truncation + units-1000x sentinels).
 *  2. COVERAGE CLASSIFICATION — for a PE/FY, decide whether a missing mark is a
 *     real gap worth chasing or a legitimately-expected blank (classified /
 *     out-of-jurisdiction / wrong-FY), so "did we extract everything?" becomes a
 *     measurable number instead of a guess.
 */

import { serviceFromPeCode } from '../jbook/jbook-extract.js';

// ───────────────────────── Accuracy guards ─────────────────────────

export interface GuardRow {
  peCode?: string | null;
  request?: number | null;
  mark?: number | null;
  explanation?: string | null;
  title?: string | null;
}

export interface GuardReport {
  rowsEmitted: number;
  peCodesDistinct: number;
  titleTruncated: number;
  unitsAnomalies: number;
  status: 'ok' | 'warn' | 'fail';
  truncatedSamples: string[];
  anomalySamples: string[];
}

/**
 * A title looks truncated when it ends in a hyphen/en-dash (PDF line-wrap that
 * was never spliced) or is <=3 chars (regex cut at an embedded number, e.g. the
 * "F–22A SQUADRONS" -> "F–" class bug). Genuinely short real names ("E–7",
 * "MQ–") are rare and accepted as benign — the threshold flags the SYSTEMIC case.
 */
export function isTruncatedTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  const t = title.trim();
  if (t.length === 0) return false;
  if (/[-\u2010-\u2015\u2212]$/.test(t)) return true;
  if (t.length <= 3) return true;
  return false;
}

/**
 * A units anomaly: the mark and request differ by ~1000x in either direction
 * (the "In Thousands of Dollars" vs canonical-dollars scaling bug). Only fires
 * when BOTH are present, non-zero, and same sign — a real plus-up/cut never
 * approaches three orders of magnitude.
 */
export function isUnitsAnomaly(request: number | null | undefined, mark: number | null | undefined): boolean {
  if (request == null || mark == null) return false;
  if (request === 0 || mark === 0) return false;
  if (Math.sign(request) !== Math.sign(mark)) return false;
  const ratio = Math.abs(mark) / Math.abs(request);
  return ratio >= 500 || ratio <= 1 / 500;
}

/**
 * Audit a set of extracted rows. Pure: caller decides what to do with the verdict.
 * status: fail if >20% titles truncated OR any units anomaly; warn if >5%
 * truncated; else ok. Thresholds chosen so the known F-22A regression (207/1154 ≈
 * 18%) trips at least 'warn' and a gross units bug trips 'fail'.
 */
export function auditRows(rows: GuardRow[]): GuardReport {
  const distinct = new Set<string>();
  let titleTruncated = 0;
  let unitsAnomalies = 0;
  const truncatedSamples: string[] = [];
  const anomalySamples: string[] = [];

  for (const r of rows) {
    const pe = (r.peCode ?? '').toString().trim().toUpperCase();
    if (pe) distinct.add(pe);
    const title = r.title ?? r.explanation ?? null;
    if (isTruncatedTitle(title)) {
      titleTruncated += 1;
      if (truncatedSamples.length < 10) truncatedSamples.push(`${pe}: ${JSON.stringify(title)}`);
    }
    if (isUnitsAnomaly(r.request ?? null, r.mark ?? null)) {
      unitsAnomalies += 1;
      if (anomalySamples.length < 10) anomalySamples.push(`${pe}: req=${r.request} mark=${r.mark}`);
    }
  }

  const n = rows.length || 1;
  const truncFrac = titleTruncated / n;
  let status: 'ok' | 'warn' | 'fail' = 'ok';
  if (unitsAnomalies > 0 || truncFrac > 0.2) status = 'fail';
  else if (truncFrac > 0.05) status = 'warn';

  return {
    rowsEmitted: rows.length,
    peCodesDistinct: distinct.size,
    titleTruncated,
    unitsAnomalies,
    status,
    truncatedSamples,
    anomalySamples,
  };
}

// ─────────────────────── Coverage classification ───────────────────────

/** Mark fields a PE/FY row can carry, in budget-lifecycle order. */
export const MARK_FIELDS = ['request', 'hascMark', 'sascMark', 'hacDMark', 'sacDMark', 'conference', 'enacted'] as const;
export type CoverageMark = (typeof MARK_FIELDS)[number];

export interface PeYearFacts {
  peCode: string;
  fy: number;
  /** Which marks are present (non-null) on this PE/FY row. */
  present: Partial<Record<CoverageMark, boolean>>;
  /** PE base attributes used for classification. */
  appropriationType?: string | null; // 'RDT&E' | 'PROC' | ...
  status?: string | null; // e.g. 'terminated'
  retired?: boolean;
}

export type CoverageVerdict = 'mark_present' | 'expected_blank' | 'candidate_gap';

export interface CoverageClassification {
  verdict: CoverageVerdict;
  reason: string;
}

/**
 * Services whose RDT&E is authorized/appropriated through the Armed Services /
 * Defense Appropriations bills (so an unclassified, in-request PE is EXPECTED to
 * carry HASC/SASC/HAC-D/SAC-D marks). DARPA(E)/DW(D,C,G,T,B) are defense-wide and
 * generally in jurisdiction too. A null service (unknown designator) is treated
 * as out-of-jurisdiction for gap purposes (we can't assert it SHOULD have a mark).
 */
const ASC_JURISDICTION = new Set(['ARMY', 'NAVY', 'AF', 'USMC', 'SF', 'DARPA', 'DW']);

/**
 * Classify whether a MISSING mark for one PE/FY is a real gap or expected-blank.
 * Only meaningful for the four congressional marks (hasc/sasc/hac_d/sac_d) and
 * conference/enacted; `request` is the budget baseline and isn't "missing" in the
 * gap sense. Rules (in priority order):
 *  - present                -> mark_present
 *  - retired / terminated   -> expected_blank (no longer in the budget)
 *  - no request that FY      -> expected_blank (PE wasn't in that year's budget,
 *                               so no chamber would mark it)
 *  - non-RDT&E appropriation -> expected_blank for chamber marks (procurement/O&M
 *                               lines aren't in the RDT&E funding tables)
 *  - out-of-ASC-jurisdiction -> expected_blank (MILCON/DHP/NNSA/unknown service)
 *  - else (in-request, RDT&E, in-jurisdiction, unclassified) -> candidate_gap
 *
 * NOTE: classified/intel PEs (NIP/MIP/SAP) are funded in the classified annex and
 * legitimately blank, but they are NOT distinguishable from this data alone; they
 * surface as candidate_gap and are expected to be a small, explainable residual.
 */
export function classifyMissingMark(facts: PeYearFacts, mark: CoverageMark): CoverageClassification {
  if (facts.present[mark]) return { verdict: 'mark_present', reason: 'present' };
  if (mark === 'request') {
    // request isn't a "mark"; absence means PE not in this FY's budget book.
    return { verdict: 'expected_blank', reason: 'request_not_a_mark' };
  }
  if (facts.retired || (facts.status && /terminat|cancel|retir/i.test(facts.status))) {
    return { verdict: 'expected_blank', reason: 'retired_or_terminated' };
  }
  if (!facts.present.request) {
    return { verdict: 'expected_blank', reason: 'no_request_that_fy' };
  }
  const appn = (facts.appropriationType ?? '').toUpperCase();
  const isRdte = appn === '' || appn.includes('RDT') || appn.includes('R&D') || appn === 'RDTE';
  if ((mark === 'hascMark' || mark === 'sascMark' || mark === 'hacDMark' || mark === 'sacDMark') && !isRdte) {
    return { verdict: 'expected_blank', reason: `non_rdte_appropriation:${appn || 'unknown'}` };
  }
  const { service } = serviceFromPeCode(facts.peCode);
  if (!service || !ASC_JURISDICTION.has(service)) {
    return { verdict: 'expected_blank', reason: `out_of_jurisdiction:${service ?? 'unknown_service'}` };
  }
  return { verdict: 'candidate_gap', reason: 'in_request_rdte_in_jurisdiction_unclassified' };
}
