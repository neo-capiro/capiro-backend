import { asRecord, asString, stableJson } from './client-profile-fill.helpers.js';

const ADVOCACY_TITLE_TERMS = [
  'appropriation',
  'amendment',
  'authorization',
  'bill',
  'budget',
  'congress',
  'funding',
  'hearing',
  'legislation',
  'policy',
  'regulation',
  'request',
  'submission',
  'testimony',
];
/** §16 outcome-matching priority steps 1-2: exact PE code / exact bill ID.
 *  Checked BEFORE any semantic scoring — an outcome whose evidence carries
 *  the SAME PE code or bill number as the record's own Matter is
 *  materially stronger evidence than token overlap, and must never be
 *  computed by the same 0.24-baseline formula that a title-similarity
 *  guess uses. Returns null when no deterministic identifier lines up
 *  (falls through to scoreAdvocacyOutcome), never a fabricated partial
 *  match. Steps 3-4 (regulatory docket, appropriations account) are not
 *  implemented here: OutcomeEvent.evidence has no documented docket/account
 *  field today (schema comment only documents peCode/billNumber/fiscalYear/
 *  stage/amountFrom/amountTo) — adding a docket/account check now would
 *  match against a field that doesn't exist in any evidence payload the
 *  outcome-detection pipeline actually writes, which is worse than not
 *  matching at all. Revisit if/when a regulatory or appropriations outcome
 *  rail starts populating those evidence fields. */
/**
 * Confidence assigned to a FARA discovery candidate. A CONFIRMED
 * `client_intel_mapping` always yields full confidence (a human already
 * decided this registration belongs to the client, independent of how the
 * registrant name happens to be spelled today). Otherwise confidence is a
 * function of pg_trgm name similarity, floored at FARA_AUTO_MATCH_THRESHOLD's
 * own value (anything scored at all already cleared that gate) and capped
 * below 1 — an unconfirmed name match is never presented with the same
 * certainty as a human-reviewed one.
 */
export function faraMatchConfidence(isConfirmed: boolean, similarity: number): number {
  if (isConfirmed) return 1;
  return Number(Math.min(0.95, Math.max(0.5, 0.5 + similarity * 0.45)).toFixed(3));
}

/**
 * Role-aware FARA match resolution. Picks whichever of the two identity
 * columns (registrant_name vs foreign_principal) scored higher, and reports
 * BOTH which role matched and the winning similarity score — never averages
 * or otherwise blends the two, since a client matching as a registrant and
 * a client matching as a foreign principal are two materially different
 * claims about the client's relationship to the filing. A tie (including
 * both scoring exactly 0, e.g. a confirmed-mapping-only hit with no live
 * similarity signal on either side) resolves to 'registrant' as the
 * conventional default — `matchedRole` is deliberately dropped by the
 * caller in that specific zero/zero case rather than reported as a real
 * signal (see gatherFaraAdvocacyCandidates).
 */
export function resolveFaraMatchedRole(
  registrantSimilarity: number,
  principalSimilarity: number,
): { role: 'registrant' | 'foreign_principal'; similarity: number } {
  if (principalSimilarity > registrantSimilarity) {
    return { role: 'foreign_principal', similarity: principalSimilarity };
  }
  return { role: 'registrant', similarity: registrantSimilarity };
}

/**
 * Confidence assigned to a testimony discovery candidate. Same shape as
 * `faraMatchConfidence` — a CONFIRMED `client_intel_mapping` always yields
 * full confidence; otherwise confidence is a function of similarity,
 * floored at TESTIMONY_AUTO_MATCH_THRESHOLD's own value and capped below 1.
 * Kept as a SEPARATE exported function (not a shared parameterized helper)
 * because the two sources' floors/caps are independent product decisions
 * that can diverge later without one source's tuning silently affecting
 * the other.
 */
export function testimonyMatchConfidence(isConfirmed: boolean, similarity: number): number {
  if (isConfirmed) return 1;
  return Number(Math.min(0.95, Math.max(0.55, 0.55 + similarity * 0.4)).toFixed(3));
}

/**
 * Pure cursor-advancement logic for the testimony source scan, deliberately
 * factored out of `gatherTestimonyAdvocacyCandidates` so pagination/cursor
 * correctness (skip-safety, zero-match advancement, budget-cap behavior) is
 * independently unit-testable without a real database.
 *
 * INPUT ROWS ARE ALREADY THE FULL BOUNDED BATCH, in
 * `(syncedAt ASC, compoundKey ASC)` order — the exact order the SQL query
 * scans in. This function's only job is: which rows get emitted as
 * findings, and — critically — how far the cursor may safely advance.
 *
 * `remainingBudget` is the number of NEW findings still allowed this call
 * (MAX_ADVOCACY_FINDINGS minus everything already emitted by earlier
 * rails/queries in this Fill run). The rule that matters most: if the
 * budget runs out partway through the batch, the cursor must land on the
 * LAST ROW ACTUALLY EXAMINED (the row whose emit-or-skip decision was made),
 * never on a later row in the batch that was never evaluated — checkpointing
 * an unexamined row would silently drop it forever, the exact class of bug
 * this rewrite exists to fix.
 */
export function planTestimonyScanBatch(
  rows: Array<{
    hearingId: string;
    title: string;
    committeeName: string;
    chamber: string;
    date: Date;
    url: string | null;
    syncedAt: Date;
    witnessText: string;
    similarity: number;
  }>,
  confirmedKeys: Set<string>,
  threshold: number,
  remainingBudget: number,
): {
  toEmit: Array<{
    hearingId: string;
    title: string;
    committeeName: string;
    chamber: string;
    date: Date;
    url: string | null;
    witnessText: string;
    similarity: number;
  }>;
  cursor: { syncedAt: string; key: string } | null;
} {
  const toEmit: Array<{
    hearingId: string;
    title: string;
    committeeName: string;
    chamber: string;
    date: Date;
    url: string | null;
    witnessText: string;
    similarity: number;
  }> = [];
  let cursor: { syncedAt: string; key: string } | null = null;
  let emitted = 0;
  for (const row of rows) {
    if (emitted >= Math.max(0, remainingBudget)) break;
    const compoundKey = `${row.hearingId}::${row.witnessText}`;
    const isConfirmed = confirmedKeys.has(compoundKey);
    // Confirmed rows are never emitted here (the confirmed-mapping bypass
    // query already emitted, or will emit, them) but they ARE still
    // "examined" for cursor purposes — the loop does not `continue` before
    // updating the cursor below.
    if (!isConfirmed && row.similarity >= threshold) {
      toEmit.push(row);
      emitted += 1;
    }
    // Cursor advances to THIS row precisely because this row's emit-or-skip
    // decision was just made — this is the "last row actually examined"
    // rule. Only rows strictly before the `break` above ever reach here.
    cursor = { syncedAt: row.syncedAt.toISOString(), key: compoundKey };
  }
  return { toEmit, cursor };
}

/**
 * Best-effort human-readable label for a Regulations.gov comment submitter.
 * Prefers a real person's name (firstName + lastName); falls back to the
 * organization when no personal name is present (a comment submitted on
 * an organization's letterhead but without a named individual attributed);
 * falls back to 'Anonymous' only when NEITHER is present — the API itself
 * returns fully anonymous submissions (confirmed live: the search sample
 * that included "Comment from Anonymous").
 */
export function deriveRegulatoryCommentSubmitterLabel(
  firstName: string | null,
  lastName: string | null,
  organization: string | null,
): string {
  const personalName = [firstName, lastName].filter((part): part is string => !!part).join(' ');
  return personalName || organization || 'Anonymous';
}

export function matchAdvocacyOutcomeDeterministically(
  matter: { primaryPeCode: string | null; primaryBillId: string | null } | undefined,
  outcomeEvidence: Record<string, unknown>,
): { matchedOn: 'pe_code' | 'bill_id'; score: number } | null {
  if (!matter) return null;
  const evidencePeCode = asString(outcomeEvidence.peCode);
  if (matter.primaryPeCode && evidencePeCode && evidencePeCode === matter.primaryPeCode) {
    return { matchedOn: 'pe_code', score: 0.95 };
  }
  const evidenceBillNumber = asString(outcomeEvidence.billNumber);
  if (matter.primaryBillId && evidenceBillNumber && evidenceBillNumber === matter.primaryBillId) {
    return { matchedOn: 'bill_id', score: 0.95 };
  }
  return null;
}

export function scoreAdvocacyOutcome(
  advocacy: Record<string, unknown>,
  outcome: Record<string, unknown>,
): number {
  const advocacyTokens = meaningfulTokens(
    [advocacy.title, advocacy.summary, stableJson(advocacy.metadata)].join(' '),
  );
  const outcomeTokens = meaningfulTokens(
    [outcome.kind, outcome.notes, stableJson(outcome.evidence)].join(' '),
  );
  const intersection = [...advocacyTokens].filter((token) => outcomeTokens.has(token)).length;
  const semantic = intersection / Math.max(4, Math.min(advocacyTokens.size, outcomeTokens.size));
  const sourceMatch =
    asString(advocacy.sourceType) === asString(outcome.sourceType) &&
    asString(advocacy.sourceId) &&
    asString(advocacy.sourceId) === asString(outcome.sourceId)
      ? 0.55
      : 0;
  return Number(Math.min(0.99, 0.24 + semantic * 0.65 + sourceMatch).toFixed(3));
}

/** A single `suggestFederalRegisterCorrelations` result — the shape
 *  `gatherFederalRegisterBackfill` already receives from `advocacyMatters`. */
interface RegulatoryOutcomeCandidate {
  documentNumber: string;
  documentType: string;
  agencyNames: string[];
  publicationDate: string;
  matchedDocketIds: string[];
  sourceUrl: string | null;
}

/**
 * Deterministic regulatory-outcome finding builder (Advocacy History
 * follow-on to PR #1310's `suggestFederalRegisterCorrelations`, which
 * explicitly deferred this exact step: "a later final agency action
 * becoming an Outcome is a distinct, separately-confirmed step ... not
 * inferred here"). Pure and side-effect free — never touches Prisma — so
 * every rule from the product spec is directly testable:
 *
 *  - Priority 1 (exact docket id) is the ONLY tier this builds; it never
 *    falls back to agency/title/text similarity (the candidate shape has
 *    no such fields to fall back to in the first place).
 *  - "Regulatory action after attributable comment" is enforced literally:
 *    a candidate published at or before the client's earliest attributable
 *    Regulations.gov submission on this Matter produces nothing — a
 *    Federal Register document that predates the client's own advocacy
 *    cannot be described as a movement observed after it.
 *  - `causationClaimed: false` and `relationship: 'strongly_aligned'` are
 *    hardcoded, matching `matchAdvocacyOutcomeDeterministically`'s own
 *    deterministic-match tier exactly (same honest-vocabulary rule, §17).
 *
 * Returns the `client_profile_fill_finding` `proposedValue` shape (kind
 * `regulatory_outcome`), or `null` when this candidate should not become a
 * finding at all.
 */
export function buildRegulatoryOutcomeFinding(
  matterId: string,
  candidate: RegulatoryOutcomeCandidate,
  attributableActivityDate: Date | null,
): Record<string, unknown> | null {
  if (candidate.matchedDocketIds.length === 0) return null;
  if (!attributableActivityDate) return null;
  const publishedAt = parseDate(candidate.publicationDate);
  if (!publishedAt || publishedAt <= attributableActivityDate) return null;
  return {
    matterId,
    documentNumber: candidate.documentNumber,
    docketId: candidate.matchedDocketIds[0],
    matchedDocketIds: candidate.matchedDocketIds,
    documentType: candidate.documentType,
    agencyNames: candidate.agencyNames,
    publicationDate: candidate.publicationDate,
    sourceUrl: candidate.sourceUrl,
    attributableActivityDate: attributableActivityDate.toISOString(),
    relationship: 'strongly_aligned' as const,
    matchedOn: 'docket_id' as const,
    causationClaimed: false as const,
  };
}
export function recordsFromUnknown(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(asRecord).filter((row) => Object.keys(row).length > 0);
  const row = asRecord(value);
  for (const key of ['activities', 'lobbying_activities', 'items', 'results']) {
    if (Array.isArray(row[key])) return (row[key] as unknown[]).map(asRecord);
  }
  return Object.keys(row).length ? [row] : [];
}

export function summarizeLdaActivity(activity: Record<string, unknown>, fallback: string | null) {
  for (const key of [
    'specific_issues',
    'specificIssues',
    'description',
    'issue_description',
    'issueDescription',
    'text',
  ]) {
    const value = asString(activity[key]);
    if (value) return value.slice(0, 4_000);
  }
  return fallback?.slice(0, 4_000) ?? null;
}

export function normalizePersistedAdvocacy(row: Record<string, unknown>) {
  return {
    externalKey: row.external_key,
    recordType: row.record_type,
    title: row.title,
    summary: row.summary,
    activityDate: row.activity_date,
    sourceType: row.source_type,
    sourceId: row.source_id,
    metadata: row.metadata_jsonb,
    matterId: row.matter_id,
  };
}

export function containsAdvocacyTerm(value: string) {
  const normalized = value.toLowerCase();
  return ADVOCACY_TITLE_TERMS.some((term) => normalized.includes(term));
}

export function parseDate(value: unknown): Date | null {
  const text = asString(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}
export function normalizeEvidenceClass(value: unknown) {
  const text = asString(value);
  return ['PUBLIC_VERIFIED', 'CLIENT_VERIFIED', 'PRIVATE_ACTIVITY', 'INFERRED'].includes(text ?? '')
    ? text!
    : 'INFERRED';
}

/** §27 duplicate-candidate signal 1 (deterministic before semantic): same
 *  calendar day. Two records timestamped on different days are never
 *  flagged as a possible duplicate regardless of title similarity — a
 *  recurring monthly meeting produces near-identical titles across many
 *  distinct real events, and only the date makes them distinguishable. */
export function sameActivityDay(a: unknown, b: unknown): boolean {
  const dateA = parseDate(a);
  const dateB = parseDate(b);
  if (!dateA || !dateB) return false;
  return dateA.toISOString().slice(0, 10) === dateB.toISOString().slice(0, 10);
}

/** §27 duplicate-candidate signal 2: title token overlap, reusing the exact
 *  same tokenizer scoreAdvocacyOutcome already uses for consistency. Only
 *  ever a SECONDARY signal gated behind sameActivityDay returning true
 *  first — text similarity alone must never flag two distinct events
 *  (§27: "Do not collapse two distinct events merely because text is
 *  similar"). */
export function titleOverlapRatio(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const tokensA = meaningfulTokens(a);
  const tokensB = meaningfulTokens(b);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  const intersection = [...tokensA].filter((token) => tokensB.has(token)).length;
  return intersection / Math.max(tokensA.size, tokensB.size);
}

function meaningfulTokens(value: string) {
  const stop = new Set([
    'about',
    'after',
    'again',
    'also',
    'been',
    'from',
    'have',
    'into',
    'that',
    'their',
    'this',
    'with',
    'were',
    'will',
  ]);
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 4 && !stop.has(token)),
  );
}
