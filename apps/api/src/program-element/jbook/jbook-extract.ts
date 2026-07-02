/**
 * Pure helpers for the DoD Comptroller J-book (R-1/P-1) sync. Kept in src/ (not
 * scripts/) so they are unit-tested by the standard jest spec matcher and
 * importable by scripts/sync-comptroller-jbooks.ts.
 */

export interface JbookServiceInfo {
  service: string | null;
  serviceCode: string | null;
}

const SERVICE_DESIGNATOR: Record<string, string> = {
  A: 'ARMY',
  N: 'NAVY',
  F: 'AF',
  M: 'USMC',
  S: 'SF',
  E: 'DARPA',
  D: 'DW',
  C: 'DW',
  G: 'DW',
  T: 'DW',
  B: 'DW',
  // Joint / defense-agency designators (only A/N/F/M/S are military departments;
  // everything else rolls up to Defense-Wide, same as C/G/T/B above). Added for
  // the 49 R-1 PEs left service=NULL by the 2026-07-03 backfill: J = Joint
  // Staff, K = DISA-family comms/IT (0303126K Long-Haul Communications),
  // V = WHS/joint support, R = readiness/joint (0300206R).
  J: 'DW',
  K: 'DW',
  V: 'DW',
  R: 'DW',
  // Second backfill pass surfaced two more OSD designators: O = Director,
  // Operational Test & Evaluation (0605118OTE), X = OSD administration (0901517X).
  O: 'DW',
  X: 'DW',
};

/** Derive service + designator from the 8th char of an RDT&E PE code. */
export function serviceFromPeCode(peCode: string): JbookServiceInfo {
  const c = peCode[7]?.toUpperCase();
  if (!c) return { service: null, serviceCode: null };
  return { service: SERVICE_DESIGNATOR[c] ?? null, serviceCode: c };
}

/**
 * Extract top_level_summaries.r1.url from the comptroller YAML config without a
 * yaml dependency. The config is simple and stable; we anchor on the `r1:` block.
 */
export function readR1UrlFromText(text: string): string {
  const lines = text.split(/\r?\n/);
  let inR1 = false;
  for (const line of lines) {
    if (/^\s{2}r1:\s*$/.test(line)) {
      inR1 = true;
      continue;
    }
    if (inR1) {
      const m = line.match(/^\s*url:\s*(\S+)/);
      if (m) return m[1]!;
      if (/^\s{2}\w/.test(line)) break; // left the r1 block
    }
  }
  throw new Error('Could not find top_level_summaries.r1.url in comptroller config');
}

/** Page-anchored citation users can open + screenshot. */
export function jbookDeepLink(sourceUrl: string, pageNumber: number): string {
  return `${sourceUrl}#page=${pageNumber}`;
}

/** Stable dedup key for one PE citation on one page of one doc-type. */
export function citationKey(peCode: string, docType: string, pageNumber: number): string {
  return `${peCode}|${docType}|${pageNumber}`;
}

/** Human-readable snippet for a PE-level R-2 descriptive-summary citation. */
export function r2PeSnippet(peCode: string, peName: string, pageStart: number, pageEnd?: number | null): string {
  const end = pageEnd && pageEnd > pageStart ? pageEnd : pageStart;
  const range = end > pageStart ? `pp.${pageStart}-${end}` : `p.${pageStart}`;
  return `${peCode} ${peName} — R-2 descriptive summary (${range})`;
}

/** Human-readable snippet for a project-level R-2A citation. */
export function r2aProjectSnippet(
  peCode: string,
  projectCode: string,
  title: string,
  sourceUrl: string,
  page: number,
): string {
  return `${peCode} / ${projectCode} ${title} — R-2A project justification (p.${page}) ${jbookDeepLink(sourceUrl, page)}`;
}

/**
 * DoD Program Element / Budget Line Item code validator.
 *
 * Format: 7 digits + a 1-letter Service designator (8th char), optionally
 * followed by a sub-element / budget-activity suffix of letters and/or digits.
 *
 * Examples that MUST pass:
 *   0603270A     RDT&E, Army (canonical 8-char form)
 *   0604122D8Z   Defense-Wide, sub-element 8Z
 *   1203622SF    Space Force, 2-char designator
 *   0208085JCY   3-char suffix
 * Examples that MUST fail:
 *   9999999999   no Service letter (pure digits)
 *   123A         too few digits
 *
 * Anchored on a letter at position 8 so pure-numeric garbage is rejected while
 * the variable-length Defense-Wide / Space Force suffixes are accepted. This is
 * the single source of truth — every ingest path validates through isValidPeCode.
 */
export const PE_CODE_REGEX = /^[0-9]{7}[A-Z][A-Z0-9]*$/;

/** Canonical PE/BLI code validity check. Trims and upper-cases before testing. */
export function isValidPeCode(peCode: string | null | undefined): boolean {
  if (!peCode) return false;
  return PE_CODE_REGEX.test(peCode.trim().toUpperCase());
}

/**
 * Procurement Budget Line Item Number (BLIN) format — the identifier procurement
 * (P-1/P-40) exhibits use INSTEAD of an RDT&E PE code. Two shapes both land here:
 *   - Army P-40 "P-1 Line Item Numbers" (e.g. 7265C12000, 6771AA0005) — 9-11 chars.
 *   - Appropriation-namespaced line items for the other Services, whose native
 *     line-item numbers are NOT globally unique (Navy "0145", AF "B02100", DW
 *     "0201MC12"), so they are keyed as <appropriationCode><lineItemNumber>
 *     (e.g. 1506N0145, 3010FB02100, 0300D0201MC12) — the Treasury/USAspending
 *     "budget line item" convention.
 * Both reduce to: 4 digits + 1-2 letters + 2-14 alphanumerics. Distinct from
 * PE_CODE_REGEX (which requires 7 leading digits then a letter), so the two never
 * collide in program_element.pe_code. The 2-char tail admits Defense-Wide OSD/DISA
 * line items whose native code is a 2-digit sub-number (e.g. 0300D30, 0300D09).
 * Widening the trailing count only ACCEPTS more real BLINs; it cannot invalidate
 * anything previously valid, and pure-numeric / bare line numbers are still rejected
 * (the 1-2 letters are mandatory).
 */
export const PROCUREMENT_CODE_REGEX = /^[0-9]{4}[A-Z]{1,2}[0-9A-Z]{2,14}$/;

/** Procurement BLIN validity check. Trims + upper-cases before testing. */
export function isValidProcurementCode(code: string | null | undefined): boolean {
  if (!code) return false;
  return PROCUREMENT_CODE_REGEX.test(code.trim().toUpperCase());
}

/**
 * Accept EITHER an RDT&E PE code OR a procurement BLIN. The shared program-element
 * writer gate uses this so both appropriations land in program_element,
 * distinguished by the appropriation_type column (RDT&E vs PROC), not the code
 * format. RDT&E ingest paths only ever produce PE codes; procurement (pdoc) paths
 * produce BLINs — they never cross.
 */
export function isValidProgramCode(code: string | null | undefined): boolean {
  return isValidPeCode(code) || isValidProcurementCode(code);
}

/**
 * Program Element marks are stored + displayed in MILLIONS (the seed-fixture + UI
 * `$X.XXm` convention). Source artifacts arrive in different raw units, so each
 * ingestion path normalizes to millions at the boundary; 0 stays 0, null/NaN -> null.
 *
 *  - dollarsToMillions: committee (HASC/SASC/HAC-D/SAC-D), NDAA conference, and
 *    enacted public-law extraction artifacts encode FULL DOLLARS — verified against
 *    the committed artifact + live data (e.g. armed_services_hasc_fy2027.json has
 *    0601102A = 215322000 = $215.3M; prod 0101224N enacted 60280000 = $60.3M).
 *    Divide by 1e6.
 *  - thousandsToMillions: P-1 procurement (P-doc) exhibits are denominated in
 *    THOUSANDS. Divide by 1e3.
 */
export function dollarsToMillions(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return value / 1_000_000;
}

export function thousandsToMillions(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return value / 1_000;
}
