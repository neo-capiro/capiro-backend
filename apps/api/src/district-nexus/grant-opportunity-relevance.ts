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

const MAX_SCORE = Object.values(RELEVANCE_WEIGHTS).reduce((sum, w) => sum + w, 0);

function norm(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function normalizeListing(value: string | null | undefined): string {
  // Assistance Listings are "NN.NNN"; strip anything that isn't part of that
  // so "93.778 " and "CFDA 93.778" compare equal.
  return (value ?? '').replace(/[^0-9.]/g, '');
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

  const clientTypes = new Set(client.applicantTypes.map((t) => t.trim()));
  const matched = opportunity.eligibleApplicantTypes.filter((t) => clientTypes.has(t.trim()));
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
 * Score is expressed 0-100 as a share of the weight that could match, so a
 * client we hold little profile data for does not automatically look
 * irrelevant. Only signals that could be evaluated count toward the
 * denominator.
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

  const sector = norm(client.sector);
  if (sector && sector.length > 2 && haystack.includes(sector)) {
    matchedSignals.push({
      signal: 'sector',
      weight: RELEVANCE_WEIGHTS.sector,
      matchedOn: client.sector ?? '',
    });
  }

  const category = norm(opportunity.fundingCategory);
  if (category && (haystack.includes(category) || norm(client.sector) === category)) {
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
