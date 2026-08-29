import { sha256CanonicalJson } from '../../defense-budget/contracts/canonical-json.js';
import { normalizeIdentityText } from './community-funding.parser.js';
import type { FundingCandidate } from './community-funding.types.js';

// Shared canonical hashing is intentionally imported rather than cloned. This module is
// government-data-specific; the dependency is one-way and has no defense domain behavior.
//
// IDENTITY vs PROVENANCE (repair of the original PR #1328 design, see
// community-funding.request-source.ts for the provenance model this pairs with):
//
// A community funding request's canonical identity represents the GOVERNMENT FUNDING
// REQUEST itself, never any one document that happens to publish it. The same real
// request routinely appears in more than one official publication — proven against the
// real FY2026 documents already committed to this PR: 849 of the House CJS PDF's 937
// rows also appear, byte-recognizably, in the House consolidated XLSX's 5,363 rows (see
// the cross-source dedup rehearsal in community-funding.cross-source-dedup.spec.ts).
// `sourceDocumentId` must therefore NEVER be part of this hash — including it made two
// authoritative publications of the identical request hash to two different canonical
// rows, which is the wrong abstraction.
//
// Field-by-field rationale, each checked against the real committed documents:
//   - chamber + requestType: House CPF and Senate CDS are structurally different
//     programs (the DB also enforces this coupling via a CHECK constraint). Never
//     collapse across them.
//   - fiscalYear: the same requester/recipient/project can legitimately recur across
//     fiscal years as a genuinely new ask; FY stays a hard identity boundary.
//   - requesterIdentityToken(requesterName) — NOT the raw normalized requester text.
//     The real PDF and XLSX publish the SAME requesting member in incompatible textual
//     forms for the exact same request: the PDF gives bare surnames, sometimes with a
//     state disambiguator or comma-joined given name ("Torres (NY)", "Gonzales, Tony
//     (TX)"), sometimes multiple co-sponsors joined with "; " ("Bonamici; Dexter"); the
//     XLSX gives "First Last" ("Ritchie Torres", "Tony Gonzales", "Suzanne Bonamici").
//     Hashing the raw normalized text (as the original design effectively did once
//     sourceDocumentId is removed) would leave the PDF and XLSX rows for the SAME real
//     request with two different identity hashes, silently reintroducing exactly the
//     duplication bug this repair exists to close. requesterIdentityToken extracts a
//     cross-format-stable primary-requester surname: first-listed name only (co-sponsor
//     joins are a display concern, not an identity discriminator — the primary sponsor
//     is), state disambiguator stripped, and "Last, First" vs "First Last" order
//     normalized to the surname. Verified against every real PDF/XLSX pair that shares
//     a (recipient, projectTitle) key in the FY2026 rehearsal data: 837/854 matched
//     pairs already agreed once title+recipient matched; the remaining 17 were exactly
//     the co-sponsor/state-suffix/comma-order cases this token normalizes, and after
//     normalization all 17 also agree (community-funding.identity.spec.ts pins these
//     exact real-data pairs as regression cases, not synthetic ones).
//   - normalized recipient + normalized project title: the practical "same ask"
//     signature. Title alone is not used (too many members submit differently-titled
//     asks for near-identical projects); requester+recipient alone is not used either
//     (the same member/recipient pair can legitimately submit two distinct asks with
//     different projects in the same FY — this is exactly what real data shows: e.g.
//     Kweisi Mfume co-sponsoring three DIFFERENT recipient/title asks with Olszewski in
//     the same FY, which must stay three distinct canonical rows, and does under this
//     key since recipient+title differ across all three).
//
// Explicitly EXCLUDED from identity, with real-data justification:
//   - appropriationsAccountRaw: the XLSX parser never populates this field at all (it
//     has no equivalent column) while the PDF parser always does. Including it in
//     identity — even normalized-empty for XLSX rows — would make every single
//     cross-format pair fail to match (empty string account != a real "DOC / NIST—STRS"
//     account), which is the opposite of what this repair needs. Per-source account
//     wording lives on the provenance row instead, and disagreement there is exactly
//     the kind of thing provenance exists to preserve.
//   - amount fields, description, subcommittee: these are legitimately allowed to
//     differ or be corrected across republications of the same request (see the
//     precedence policy in community-funding.upsert.service.ts) and are provenance-side
//     values, not identity.
//
// Collision check performed against the real data, not asserted from theory: with this
// exact key, zero WITHIN-document collisions exist in either the 937-row PDF or the
// 5,363-row XLSX (every distinct combination of these fields maps to exactly one real
// row inside each document) — the key neither over-collapses nor under-collapses on
// the real corpus.
export function communityFundingIdentity(candidate: FundingCandidate): string {
  return sha256CanonicalJson({
    chamber: candidate.chamber,
    requestType: candidate.requestType,
    fiscalYear: candidate.fiscalYear,
    requesterIdentity: requesterIdentityToken(candidate.requesterName),
    recipientName: normalizeIdentityText(candidate.recipientName),
    projectTitle: normalizeIdentityText(candidate.projectTitle),
  });
}

/**
 * Cross-format-stable "primary requester" identity token. See the class-level
 * doc above for the real-data cases this rule is derived from and verified against.
 *
 * Rule:
 *   1. A semicolon-joined co-sponsor list ("Bonamici; Dexter") takes only the
 *      FIRST-listed name as the primary requester for identity purposes — the
 *      full list is preserved verbatim in requesterName for display, this token
 *      is identity-only.
 *   2. A trailing "(ST)" state disambiguator ("Torres (NY)") is stripped.
 *   3. A "Last, First" comma form ("Gonzales, Tony") takes the part BEFORE the
 *      comma as the surname directly.
 *   4. Otherwise (a bare surname, or "First Last" order) the LAST whitespace
 *      token is taken as the surname.
 */
export function requesterIdentityToken(rawRequesterName: string): string {
  const firstListed = rawRequesterName.split(';')[0]?.trim() ?? '';
  const withoutStateSuffix = firstListed.replace(/\([^)]*\)\s*$/, '').trim();
  const commaIndex = withoutStateSuffix.indexOf(',');
  if (commaIndex >= 0) {
    return normalizeIdentityText(withoutStateSuffix.slice(0, commaIndex));
  }
  const normalized = normalizeIdentityText(withoutStateSuffix);
  const tokens = normalized.split(' ').filter(Boolean);
  return tokens.length ? tokens[tokens.length - 1]! : normalized;
}
