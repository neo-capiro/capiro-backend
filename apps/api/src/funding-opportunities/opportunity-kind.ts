/**
 * Funding Opportunities — source taxonomy → bounded internal `OpportunityKind`.
 *
 * Pure and dependency-free. Exists because both sources emit their notice type
 * as loosely-governed text, and a UI that switches on the raw string silently
 * mislabels every spelling it was not taught.
 *
 * ── The reason this is not a lookup table of exact strings ───────────────────
 *
 * SAM.gov's `type` field has been observed with and without the word "Notice",
 * with "/" and with " and ", and with case variations ("Combined Synopsis/
 * Solicitation", "Combined Synopsis / Solicitation", "COMBINED SYNOPSIS
 * SOLICITATION"). An exact map would return `other` for the first variant it had
 * not seen, and `other` on a solicitation means the UI stops calling it a
 * solicitation. Matching on normalized substrings is what makes that robust.
 *
 * ── Why an unknown value returns `other` rather than a guess ─────────────────
 *
 * `other` is honest and the caller renders the verbatim source string next to
 * it. Guessing 'solicitation' for an unrecognized type would present something
 * that might be a mere special notice as a live bid opportunity — the exact
 * "sources-sought is not an open solicitation" error the feature must not make.
 */
import type { OpportunityKind } from './funding-opportunities.types.js';

/** Lowercase, punctuation → single spaces, collapsed. */
export function normalizeKindText(raw: string | null | undefined): string {
  return (raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * SAM.gov notice type → OpportunityKind.
 *
 * Order matters and is the whole correctness story of this function:
 * "combined synopsis solicitation" contains "solicitation", and
 * "presolicitation" contains "solicitation" once punctuation is flattened. The
 * most specific patterns are therefore tested FIRST, and the bare
 * "solicitation" test is last among the solicitation family. Reordering these
 * cases silently relabels presolicitations as open solicitations.
 */
export function samNoticeKind(raw: string | null | undefined): OpportunityKind {
  const t = normalizeKindText(raw);
  if (!t) return 'other';

  // Award first: "award notice" contains neither of the solicitation words, but
  // SAM also emits "combined synopsis solicitation award" shapes on occasion.
  if (t.includes('award')) return 'award_notice';
  if (t.includes('sources sought')) return 'sources_sought';
  // "Justification and Approval", "Intent to Bundle", "Fair Opportunity" and
  // friends are all information-only postings; SAM groups them under special
  // notice, and so do we.
  if (
    t.includes('special notice') ||
    t.includes('justification') ||
    t.includes('intent to bundle') ||
    t.includes('fair opportunity') ||
    t.includes('sale of surplus')
  ) {
    return 'special_notice';
  }
  if (t.includes('combined synopsis')) return 'combined_synopsis_solicitation';
  // Both "presolicitation" and "pre solicitation" normalize into this test, and
  // both must resolve BEFORE the bare solicitation check below.
  if (t.includes('presolicitation') || t.includes('pre solicitation')) return 'presolicitation';
  if (t.includes('amendment') || t.includes('modification')) return 'amendment';
  if (t.includes('solicitation')) return 'solicitation';
  return 'other';
}

/**
 * Grants.gov → OpportunityKind.
 *
 * Grants.gov has no notice-type field comparable to SAM's. What it has is
 * `fundingInstrument` (a detail-payload field: "Grant", "Cooperative
 * Agreement", "Procurement Contract", "Other") and `docType`
 * ('synopsis' | 'forecast'). A cooperative agreement is a materially different
 * instrument from a grant — the government is a participant, not just a funder —
 * so it gets its own kind rather than being flattened to 'grant'.
 *
 * `docType: 'forecast'` deliberately does NOT change the kind: a forecast is a
 * grant opportunity that has not opened yet, which is a STATUS fact
 * (`status: 'forecasted'`), not a different instrument. Encoding it as a kind
 * would make it impossible to filter "all cooperative agreements" without also
 * knowing whether each was forecast.
 */
export function grantsGovKind(fundingInstrument: string | null | undefined): OpportunityKind {
  const t = normalizeKindText(fundingInstrument);
  if (!t) return 'grant';
  if (t.includes('cooperative agreement')) return 'cooperative_agreement';
  if (t.includes('grant')) return 'grant';
  // "Procurement Contract" appears on a small number of Grants.gov notices. It
  // is not a grant and calling it one would be wrong, but it is also not a SAM
  // notice with SAM's fields, so 'other' + the verbatim string is the honest
  // answer.
  return 'other';
}
