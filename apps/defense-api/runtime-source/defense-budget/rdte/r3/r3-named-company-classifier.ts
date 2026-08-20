/**
 * r3-named-company-classifier — is this performer string a real named
 * company, or a placeholder/government-internal label?
 *
 * Phase 7 Gap 2 closeout. `getContractors`'s `namedPrimes` panel uses this as
 * a SELECTION FILTER (`WHERE is_named_company = true`), not a display flag —
 * without it the read path can only return every performer or none, and both
 * are wrong. The classification already existed, correct and battle-tested,
 * in `scripts/sync-jbook-performers.ts` — but only there, operating on flat
 * JSON fixtures outside the Phase 4 R-3 pipeline entirely. This module is that
 * same heuristic, extracted so the real extractor and the legacy sync script
 * share one implementation instead of two that can drift apart.
 *
 * A string that resembles a company name does not by itself prove
 * prime-contractor *role* (see `r3-role-classifier.ts` — a materially
 * different question). This only answers "is this a real name" as opposed to
 * `Various`/`TBD`/`MIPR`/a bare government label/multi-state location bleed.
 *
 * Pure module.
 */

/** Placeholder / government-internal labels, never a company name. */
const NON_COMPANY_RE =
  /^(VARIOUS|TBD|N\/?A|MULTIPLE|GOVERNMENT|GOVT|MDA|TBD\b.*|CLASSIFIED|WITHIN|INTERNAL|MIPR|ALLOTMENT|SEE\b)/i;

/**
 * A performer string that STARTS with a comma-separated US state-code list
 * (e.g. "AL, CO, CA, VA, Various") is a multi-state location that leaked into
 * the company column on a MIPR/Allotment government row — not a company.
 */
const STATE_PREFIX_JUNK_RE = /^([A-Z]{2})(\s*,\s*[A-Z]{2}\b)+/;

const LEGAL_SUFFIX_RE =
  /\b(INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LLC|LTD|LP|PLC|TECHNOLOGIES|TECHNOLOGY|SYSTEMS|GROUP|SERVICES|INTERNATIONAL|INTL|ASSOCIATES|CONSULTING|SOLUTIONS|LABORATORIES|LABORATORY|LABS|UNIVERSITY|INSTITUTE)\b/i;

const STATE_CODE_RE =
  /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/g;

/**
 * True when `performer` is a real named company — has a legal suffix, or is a
 * plausible multi-character proper name — rather than a placeholder like
 * `Various`/`TBD`, a bare government label, or state-code location bleed.
 *
 * Conservative in the same direction as `classifyPerformerRole`: this flags a
 * row for *exclusion* from the named-primes panel, it never invents a company
 * name that was not printed.
 */
export function isNamedCompanyV1(performer: string): boolean {
  const value = (performer || '').trim();
  if (!value || NON_COMPANY_RE.test(value)) return false;
  if (STATE_PREFIX_JUNK_RE.test(value)) return false;

  // Reject a string that is mostly a state-code/Various salad (two or more
  // bare state codes and no legal suffix to redeem it).
  const stateCodeCount = (value.match(STATE_CODE_RE) ?? []).length;
  if (stateCodeCount >= 2 && !LEGAL_SUFFIX_RE.test(value)) return false;

  return LEGAL_SUFFIX_RE.test(value) || (value.length > 4 && /[A-Za-z]/.test(value));
}
