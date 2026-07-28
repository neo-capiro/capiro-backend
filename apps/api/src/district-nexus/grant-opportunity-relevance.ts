/**
 * District Nexus — grant opportunity relevance (Rev 2 plan, WS-C Step C3).
 *
 * Deterministic and pure. No LLM anywhere in this file, by design: a later
 * summary may EXPLAIN the signals computed here, but it must never change
 * them. Eligibility in particular is a legal-ish statement about whether a
 * client may apply for federal money — it has to be reproducible, auditable,
 * and identical on every run, which a model call is not.
 *
 * ── The distinction that shapes the output ──────────────────────────────────
 *
 * `relevanceScore` and `eligibilityState` are deliberately independent.
 *
 * An opportunity can be a perfect thematic match and still be one the client
 * legally cannot apply for (wrong applicant type, wrong state). Folding
 * eligibility into the score would turn "you are barred from this" into
 * "this is a weak match", which is the kind of quiet wrongness that gets a
 * client to spend a week on a bid they were never allowed to submit.
 */

/** Ordered strongest-first; the order is the tie-break for matchedSignals. */
export const RELEVANCE_SIGNALS = [
  'assistanceListing',
  'agency',
  'capabilityKeyword',
  'sector',
  'fundingCategory',
  'knownPartner',
] as const;

export type RelevanceSignalKey = (typeof RELEVANCE_SIGNALS)[number];

/**
 * Signal weights. An exact Assistance Listing match dominates because it is a
 * program identifier, not a topical guess: if the client has previously
 * received money under 93.778, a new 93.778 opportunity is the same program.
 * Keyword and sector matches are topical and much weaker on their own.
 */
// The only import in this otherwise dependency-free module: the shared
// normalizer both sides of the applicant-type comparison must agree on.
// Pure function, no I/O — the file stays deterministic.
import { applicantTypeKey } from '@capiro/shared';

export const RELEVANCE_WEIGHTS: Readonly<Record<RelevanceSignalKey, number>> = Object.freeze({
  assistanceListing: 40,
  agency: 20,
  capabilityKeyword: 15,
  sector: 10,
  fundingCategory: 10,
  knownPartner: 5,
});

export type EligibilityState = 'eligible' | 'ineligible' | 'needs_review' | 'unknown';

export interface MatchedSignal {
  signal: RelevanceSignalKey;
  weight: number;
  /** The specific value that matched, for display. Never a paraphrase. */
  matchedOn: string;
}

export interface ClientRelevanceProfile {
  sector: string | null;
  capabilityKeywords: string[];
  /** Assistance Listing numbers the client has previously received under. */
  priorAssistanceListings: string[];
  /** Agencies the client has prior awards from. */
  priorAgencies: string[];
  /** Applicant type codes the client qualifies as, e.g. '12' (for-profit). */
  applicantTypes: string[];
  states: string[];
  knownPartnerNames: string[];
}

export interface OpportunityProfile {
  assistanceListingNumber: string | null;
  agency: string | null;
  fundingCategory: string | null;
  title: string | null;
  description: string | null;
  /** Applicant type codes the opportunity accepts. Empty = unspecified. */
  eligibleApplicantTypes: string[];
  /** State codes the opportunity is restricted to. Empty = unrestricted. */
  geographicRestrictions: string[];
}

export interface RelevanceResult {
  relevanceScore: number;
  matchedSignals: MatchedSignal[];
  eligibilityState: EligibilityState;
  /** Operator-readable justification for eligibilityState. Always populated. */
  reason: string;
}

// Fixed total signal weight — the scoring denominator (see scoreOpportunityRelevance).
// It does NOT shrink for a client we hold thin profile data on; a thin profile
// scores lower, it isn't excused from the denominator. Simplicity/auditability
// tradeoff: a fixed scale is trivial to reproduce and explain, whereas "which
// signals could this client-opportunity pair have possibly evaluated" has no
// defined rule for all six signals.
const MAX_SCORE = Object.values(RELEVANCE_WEIGHTS).reduce((sum, w) => sum + w, 0);

function norm(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function normalizeListing(value: string | null | undefined): string {
  // Assistance Listings are "NN.NNN"; strip anything that isn't part of that
  // so "93.778 " and "CFDA 93.778" compare equal.
  return (value ?? '').replace(/[^0-9.]/g, '');
}

// Sector-taxonomy / domain-universal words that carry no topical signal on
// their own for FEDERAL GRANT text specifically: "government"/"federal" are
// near-tautological in an opportunity's own title+description (it is
// necessarily a federal notice), and "other" is SECTOR_TAGS' literal
// catch-all meaning "no specific sector" (packages/shared SECTOR_TAGS) — none
// of these should be able to manufacture a match by themselves. Distinctive
// topical words ("defense", "aerospace", "energy") pass through.
const GENERIC_SECTOR_TOKENS = new Set(['and', 'of', 'the', 'for', 'government', 'federal', 'other']);

/**
 * client.sector (Client.sectorTag) is meant to be a controlled SectorTag
 * (packages/shared SECTOR_TAGS) but carries pre-migration free text for
 * clients created before that enum existed — e.g. "Defense / Aerospace"
 * rather than "DEFENSE" (confirmed live on the RTX client). Splitting into
 * tokens instead of matching the whole string handles both shapes the same
 * way and lets a compound legacy value match on ANY of its distinctive words,
 * not just when the entire string happens to appear verbatim in the grant
 * text (which single-token clean enum values do, but almost no multi-word or
 * punctuated value ever will).
 */
function sectorTokens(sector: string | null | undefined): string[] {
  return norm(sector)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !GENERIC_SECTOR_TOKENS.has(t));
}

/**
 * Eligibility, computed only from structured fields.
 *
 * Returns `unknown` rather than guessing when the opportunity does not state
 * its applicant types — "the notice didn't say" is not the same as "you
 * qualify", and defaulting to eligible would be the dangerous direction to be
 * wrong in.
 */
export function computeEligibility(
  client: ClientRelevanceProfile,
  opportunity: OpportunityProfile,
): { state: EligibilityState; reason: string } {
  const geoRestricted = opportunity.geographicRestrictions.length > 0;
  if (geoRestricted) {
    const clientStates = new Set(client.states.map((s) => s.toUpperCase()));
    const overlap = opportunity.geographicRestrictions.some((s) =>
      clientStates.has(s.toUpperCase()),
    );
    if (!overlap) {
      if (clientStates.size === 0) {
        return {
          state: 'needs_review',
          reason:
            'The opportunity is geographically restricted and we hold no state for this client, so eligibility cannot be determined.',
        };
      }
      return {
        state: 'ineligible',
        reason: `Restricted to ${opportunity.geographicRestrictions.join(', ')}, and this client has no presence in those states.`,
      };
    }
  }

  if (opportunity.eligibleApplicantTypes.length === 0) {
    return {
      state: 'unknown',
      reason: 'The opportunity does not state eligible applicant types.',
    };
  }
  if (client.applicantTypes.length === 0) {
    return {
      state: 'needs_review',
      reason:
        'The opportunity states applicant types but we hold none for this client — confirm the client’s applicant type to resolve.',
    };
  }

  // Compared through `applicantTypeKey` (case + whitespace normalized,
  // punctuation untouched) on BOTH sides. These are long vendor label strings
  // such as 'For profit organizations other than small businesses'; a stored
  // client value differing only in case or a double space must not read as
  // "ineligible" for a client that genuinely qualifies.
  const clientTypes = new Set(client.applicantTypes.map(applicantTypeKey));
  const matched = opportunity.eligibleApplicantTypes.filter((t) =>
    clientTypes.has(applicantTypeKey(t)),
  );
  if (matched.length > 0) {
    return {
      state: 'eligible',
      reason: `Client applicant type ${matched.join(', ')} is accepted by this opportunity${
        geoRestricted ? ', and the client is present in a permitted state' : ''
      }.`,
    };
  }
  return {
    state: 'ineligible',
    reason: `This opportunity accepts applicant types ${opportunity.eligibleApplicantTypes.join(', ')}; the client qualifies as ${client.applicantTypes.join(', ')}.`,
  };
}

/**
 * Score how relevant an opportunity is to a client, and separately whether the
 * client can actually apply.
 *
 * Score is expressed 0-100 as a share of the FIXED total signal weight
 * (MAX_SCORE — see its own comment for why the denominator doesn't vary
 * per client). A thin client profile scores lower on this scale, not
 * "not applicable" — a floor is a statement like "an assistanceListing hit
 * alone clears it" or "these weaker signals together reach the same share".
 */
export function scoreOpportunityRelevance(
  client: ClientRelevanceProfile,
  opportunity: OpportunityProfile,
): RelevanceResult {
  const matchedSignals: MatchedSignal[] = [];

  const listing = normalizeListing(opportunity.assistanceListingNumber);
  if (listing && client.priorAssistanceListings.some((l) => normalizeListing(l) === listing)) {
    matchedSignals.push({
      signal: 'assistanceListing',
      weight: RELEVANCE_WEIGHTS.assistanceListing,
      matchedOn: opportunity.assistanceListingNumber ?? listing,
    });
  }

  const agency = norm(opportunity.agency);
  if (agency && client.priorAgencies.some((a) => norm(a) === agency)) {
    matchedSignals.push({
      signal: 'agency',
      weight: RELEVANCE_WEIGHTS.agency,
      matchedOn: opportunity.agency ?? '',
    });
  }

  // Keyword matching runs over title + description. Substring rather than
  // fuzzy: a deterministic, explainable hit is the requirement, and a
  // near-miss the operator cannot see is worse than no hit.
  const haystack = `${norm(opportunity.title)} ${norm(opportunity.description)}`;
  const keywordHit = client.capabilityKeywords.find((k) => {
    const needle = norm(k);
    return needle.length > 2 && haystack.includes(needle);
  });
  if (keywordHit) {
    matchedSignals.push({
      signal: 'capabilityKeyword',
      weight: RELEVANCE_WEIGHTS.capabilityKeyword,
      matchedOn: keywordHit,
    });
  }

  const sectorHit = sectorTokens(client.sector).find((t) => haystack.includes(t));
  if (sectorHit) {
    matchedSignals.push({
      signal: 'sector',
      weight: RELEVANCE_WEIGHTS.sector,
      matchedOn: sectorHit,
    });
  }

  // Client-independent on purpose is NOT allowed here: fundingCategory is the
  // OPPORTUNITY's own taxonomy value, so it must only ever be compared against
  // something about the CLIENT (client.sector), never against the
  // opportunity's own title/description — that would score every client
  // identically off a fact that has nothing to do with them (confirmed live:
  // 120 of 183 signal hits were exactly this, including clients with zero
  // capabilities and no sector at all).
  const category = norm(opportunity.fundingCategory);
  if (category && norm(client.sector) === category) {
    matchedSignals.push({
      signal: 'fundingCategory',
      weight: RELEVANCE_WEIGHTS.fundingCategory,
      matchedOn: opportunity.fundingCategory ?? '',
    });
  }

  const partnerHit = client.knownPartnerNames.find((p) => {
    const needle = norm(p);
    return needle.length > 2 && haystack.includes(needle);
  });
  if (partnerHit) {
    matchedSignals.push({
      signal: 'knownPartner',
      weight: RELEVANCE_WEIGHTS.knownPartner,
      matchedOn: partnerHit,
    });
  }

  matchedSignals.sort(
    (a, b) => RELEVANCE_SIGNALS.indexOf(a.signal) - RELEVANCE_SIGNALS.indexOf(b.signal),
  );

  const earned = matchedSignals.reduce((sum, s) => sum + s.weight, 0);
  const relevanceScore = Math.round((earned / MAX_SCORE) * 100);

  const eligibility = computeEligibility(client, opportunity);

  return {
    relevanceScore,
    matchedSignals,
    eligibilityState: eligibility.state,
    reason: eligibility.reason,
  };
}
