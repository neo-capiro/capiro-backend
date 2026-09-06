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

/** Display fit evidence first and eligibility context last. */
export const RELEVANCE_SIGNALS = [
  'assistanceListing',
  'agency',
  'capabilityKeyword',
  'sector',
  'fundingCategory',
  'knownPartner',
  'applicantType',
  'stateRestriction',
] as const;

export type RelevanceSignalKey = (typeof RELEVANCE_SIGNALS)[number];

export type SignalStrength = 'strong' | 'moderate' | 'weak';

/**
 * Evidence-quality band per signal, independent of the weight.
 *
 * A weight orders results; a band states how much the evidence is WORTH. Keeping
 * them separate is what stops "nudge the weight up" from quietly promoting a
 * topical guess into a sufficient reason to surface something. The Funding
 * Opportunities read path reports the band to the UI so a weak match can say why
 * it is weak, and the SAM engine (sam-opportunity-relevance.ts) uses the same
 * three-band vocabulary so both rails explain themselves the same way.
 */
export const SIGNAL_STRENGTH: Readonly<Record<RelevanceSignalKey, SignalStrength>> = Object.freeze({
  assistanceListing: 'strong',
  applicantType: 'weak',
  agency: 'moderate',
  stateRestriction: 'weak',
  capabilityKeyword: 'moderate',
  sector: 'weak',
  fundingCategory: 'weak',
  knownPartner: 'weak',
});

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
  // Keep the established numeric scale for sorting existing records. Applicant
  // type and geography are supporting eligibility facts, never sufficient fit
  // evidence: the shared suggestion floor requires a program/capability match.
  applicantType: 25,
  agency: 20,
  // The client is present in a state the notice RESTRICTS itself to. A
  // restriction the client satisfies is a positive relevance fact (the pool of
  // competitors is smaller), separate from it not being disqualifying.
  stateRestriction: 15,
  capabilityKeyword: 15,
  sector: 10,
  fundingCategory: 10,
  knownPartner: 5,
});

export type EligibilityState = 'eligible' | 'ineligible' | 'needs_review' | 'unknown';

export interface MatchedSignal {
  signal: RelevanceSignalKey;
  weight: number;
  strength: SignalStrength;
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
  /**
   * Grants.gov "Eligible Applicants" values the client qualifies as, e.g.
   * 'Small businesses'. LABELS, not the numeric codes — the opportunity side
   * comes from `federal_grant.eligibility`, which stores labels, and the two are
   * compared by string. See GRANTS_GOV_APPLICANT_TYPES in @capiro/shared.
   */
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
  /**
   * "Eligible Applicants" values the opportunity accepts, as label strings from
   * `federal_grant.eligibility`. Empty = the notice did not say.
   */
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
  /**
   * Whether this pair is strong enough to SURFACE as a suggestion.
   *
   * An exact prior program, or a substantive capability with independent
   * topical/agency evidence. Eligibility, geography and generic/repeated words
   * cannot establish fit, even when their numeric score is above the backstop.
   */
  meetsSuggestionFloor: boolean;
}

// Fixed total signal weight — the scoring denominator (see scoreOpportunityRelevance).
// It does NOT shrink for a client we hold thin profile data on; a thin profile
// scores lower, it isn't excused from the denominator. Simplicity/auditability
// tradeoff: a fixed scale is trivial to reproduce and explain, whereas "which
// signals could this client-opportunity pair have possibly evaluated" has no
// defined rule for all eight signals.
//
// Exported because the denominator is not an implementation detail: it is what a
// relevance FLOOR is a fraction of, and a caller that hardcodes a floor against
// an assumed denominator breaks silently the next time a signal is added. See
// MIN_RELEVANCE_ASSISTANCE_LISTING_FLOOR.
export const RELEVANCE_MAX_SCORE = Object.values(RELEVANCE_WEIGHTS).reduce((sum, w) => sum + w, 0);
const MAX_SCORE = RELEVANCE_MAX_SCORE;

/**
 * The floor at which "an exact Assistance Listing match, and nothing else,
 * qualifies" — DERIVED from the weights rather than written down.
 *
 * That invariant is the actual product rule behind
 * generate-grant-opportunity-candidates.ts's relevance floor. It used to be
 * spelled `40`, which was correct only because the denominator happened to be
 * 100 and `assistanceListing` happened to weigh 40. Adding the `applicantType`
 * and `stateRestriction` signals moved the denominator to
 * {@link RELEVANCE_MAX_SCORE}, at which point a hardcoded 40 would have quietly
 * started EXCLUDING listing-only matches — a shipped producer silently
 * generating fewer candidates, with no failing test to say so.
 *
 * grant-opportunity-relevance.spec.ts pins the invariant directly, so a future
 * weight change that breaks it fails the build instead of the feature.
 */
export const MIN_RELEVANCE_ASSISTANCE_LISTING_FLOOR = Math.round(
  (RELEVANCE_WEIGHTS.assistanceListing / MAX_SCORE) * 100,
);

function norm(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/**
 * Assistance Listing identity.
 *
 * Most listings are "NN.NNN", but a real minority carry a trailing letter —
 * 93.00R, 93.00E, 93.00F, 93.00G, 93.00J and 93.00K are six DIFFERENT federal
 * listings (93.00R alone has 75 award rows behind it in production), not six
 * spellings of 93.00. The suffix is part of the identity and must survive.
 *
 * The previous implementation deleted every non-digit, so all six collapsed to
 * "93.00" and registered as an exact-match `assistanceListing` strong signal —
 * the highest-weighted signal in the table, enough to clear the suggestion
 * floor on its own. This extracts the listing with an anchored pattern instead
 * of deleting characters: an optional "CFDA" prefix and surrounding whitespace
 * are still tolerated ("CFDA 93.778", "93.778 " and "93.778" compare equal),
 * the suffix is kept and upper-cased, and anything that is not a listing
 * normalizes to '' — which callers must treat as "no value", never as a value
 * that can equal another ''.
 */
const ASSISTANCE_LISTING_RE = /^\s*(?:CFDA\s*)?(\d{2}\.\d{2,3}[A-Z]{0,2})\s*$/i;

function normalizeListing(value: string | null | undefined): string {
  const match = ASSISTANCE_LISTING_RE.exec(value ?? '');
  return match ? match[1]!.toUpperCase() : '';
}

// Sector-taxonomy / domain-universal words that carry no topical signal on
// their own for FEDERAL GRANT text specifically: "government"/"federal" are
// near-tautological in an opportunity's own title+description (it is
// necessarily a federal notice), and "other" is SECTOR_TAGS' literal
// catch-all meaning "no specific sector" (packages/shared SECTOR_TAGS) — none
// of these should be able to manufacture a match by themselves. Distinctive
// topical words ("defense", "aerospace", "energy") pass through.
const GENERIC_TOPIC_TOKENS = new Set([
  'and',
  'of',
  'the',
  'for',
  'with',
  'from',
  'into',
  'other',
  'government',
  'federal',
  'public',
  'private',
  'department',
  'bureau',
  'office',
  'agency',
  'grant',
  'grants',
  'funding',
  'funded',
  'fund',
  'funds',
  'program',
  'programs',
  'project',
  'projects',
  'research',
  'development',
  'innovation',
  'innovative',
  'technology',
  'technologies',
  'technical',
  'service',
  'services',
  'support',
  'assistance',
  'system',
  'systems',
  'solution',
  'solutions',
  'management',
  'general',
  'advanced',
  'group',
  'business',
  'businesses',
  'small',
  'nonprofit',
  'organization',
  'organizations',
  'opportunity',
  'opportunities',
  'application',
  'applications',
  'applicant',
  'applicants',
  'eligibility',
  'eligible',
  'inc',
  'llc',
  'ltd',
  'corp',
  'corporation',
  'company',
  'companies',
]);

function textTokens(value: string | null | undefined): string[] {
  return norm(value)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function substantiveTokens(value: string | null | undefined): string[] {
  return [
    ...new Set(textTokens(value).filter((t) => t.length > 2 && !GENERIC_TOPIC_TOKENS.has(t))),
  ];
}

/** Token boundaries avoid matches such as "care" inside "Medicare". */
function containsPhrase(haystack: string, value: string): boolean {
  const phrase = textTokens(value).join(' ');
  return phrase.length > 0 && haystack.includes(` ${phrase} `);
}

function addsTopic(value: string, existing: ReadonlySet<string>): boolean {
  return substantiveTokens(value).some((token) => !existing.has(token));
}

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
  return substantiveTokens(sector);
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

  const add = (signal: RelevanceSignalKey, matchedOn: string): void => {
    matchedSignals.push({
      signal,
      weight: RELEVANCE_WEIGHTS[signal],
      strength: SIGNAL_STRENGTH[signal],
      matchedOn,
    });
  };

  const listing = normalizeListing(opportunity.assistanceListingNumber);
  if (listing && client.priorAssistanceListings.some((l) => normalizeListing(l) === listing)) {
    add('assistanceListing', opportunity.assistanceListingNumber ?? listing);
  }

  // Compared through `applicantTypeKey` on BOTH sides, exactly as
  // computeEligibility does — the two must never disagree about whether the same
  // pair of label strings matches, or a notice would read "eligible" while
  // scoring as though the applicant type were irrelevant.
  if (opportunity.eligibleApplicantTypes.length > 0 && client.applicantTypes.length > 0) {
    const clientTypeKeys = new Set(client.applicantTypes.map(applicantTypeKey));
    const typeHit = opportunity.eligibleApplicantTypes.find((t) =>
      clientTypeKeys.has(applicantTypeKey(t)),
    );
    if (typeHit) add('applicantType', typeHit);
  }

  const agency = norm(opportunity.agency);
  if (agency && client.priorAgencies.some((a) => norm(a) === agency)) {
    add('agency', opportunity.agency ?? '');
  }

  // A restriction the client SATISFIES. Only fires when the notice actually
  // states restrictions — an unrestricted notice is not a geographic match for
  // everybody, it is simply silent on geography.
  if (opportunity.geographicRestrictions.length > 0 && client.states.length > 0) {
    const clientStates = new Set(client.states.map((s) => s.trim().toUpperCase()));
    const stateHit = opportunity.geographicRestrictions.find((s) =>
      clientStates.has(s.trim().toUpperCase()),
    );
    if (stateHit) add('stateRestriction', stateHit);
  }

  // Exact token phrases, with punctuation normalized, keep matching auditable.
  // Prefer a specific capability over a broad tag from the same profile.
  const haystack = ` ${textTokens(opportunity.title).join(' ')} ${textTokens(opportunity.description).join(' ')} `;
  const keywordHit = client.capabilityKeywords
    .filter((k) => substantiveTokens(k).length > 0 && containsPhrase(haystack, k))
    .sort((a, b) => substantiveTokens(b).length - substantiveTokens(a).length)[0];
  if (keywordHit) {
    add('capabilityKeyword', keywordHit);
  }

  // The same word in capability, sector and category is one piece of evidence,
  // not three independent reasons to recommend a grant.
  const usedTopics = new Set(substantiveTokens(keywordHit));
  const sectorHit = sectorTokens(client.sector).find(
    (t) => !usedTopics.has(t) && containsPhrase(haystack, t),
  );
  if (sectorHit) {
    add('sector', sectorHit);
    usedTopics.add(sectorHit);
  }

  // Client-independent on purpose is NOT allowed here: fundingCategory is the
  // OPPORTUNITY's own taxonomy value, so it must only ever be compared against
  // something about the CLIENT (client.sector), never against the
  // opportunity's own title/description — that would score every client
  // identically off a fact that has nothing to do with them (confirmed live:
  // 120 of 183 signal hits were exactly this, including clients with zero
  // capabilities and no sector at all).
  const category = norm(opportunity.fundingCategory);
  if (category && norm(client.sector) === category && addsTopic(category, usedTopics)) {
    add('fundingCategory', opportunity.fundingCategory ?? '');
    substantiveTokens(category).forEach((token) => usedTopics.add(token));
  }

  const partnerHit = client.knownPartnerNames.find((p) => {
    return addsTopic(p, usedTopics) && containsPhrase(haystack, p);
  });
  if (partnerHit) {
    add('knownPartner', partnerHit);
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
    meetsSuggestionFloor: meetsGrantSuggestionFloor(matchedSignals),
  };
}

/**
 * Grant suggestion floor. Exported so the FO service and producers share one
 * definition rather than re-deriving the band math inline.
 *
 * An exact Assistance Listing qualifies on its own. Otherwise a substantive
 * capability must have independent support from sector, category, partner or
 * prior agency. Applicant type and geography only describe who may apply.
 * Inspect identity and evidence as well as the band, so old stored "strong"
 * eligibility labels and repeated copies of a signal cannot qualify a pair.
 */
export function meetsGrantSuggestionFloor(
  signals: ReadonlyArray<Pick<MatchedSignal, 'signal' | 'strength' | 'matchedOn'>>,
): boolean {
  if (signals.some((s) => s.signal === 'assistanceListing' && normalizeListing(s.matchedOn))) {
    return true;
  }
  const capability = signals.find(
    (s) => s.signal === 'capabilityKeyword' && substantiveTokens(s.matchedOn).length > 0,
  );
  if (!capability) return false;
  const capabilityTokens = new Set(substantiveTokens(capability.matchedOn));
  return signals.some(
    (s) =>
      (s.signal === 'agency' ||
        s.signal === 'sector' ||
        s.signal === 'fundingCategory' ||
        s.signal === 'knownPartner') &&
      addsTopic(s.matchedOn, capabilityTokens),
  );
}
