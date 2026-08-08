/**
 * What a defense manufacturer should DO with one DLA bid-board item, and why
 * (Funding Opportunities P41).
 *
 * ── Why this is not `recommendOpportunity` or `scoreForecastRelevance` ───────
 *
 * A DIBBS solicitation is a live competition with a real closing date, so
 * unlike a forecast (P25) it CAN legitimately reach `'pursue'`; there is no
 * separate vocabulary here and no mapping table, just `MachineRecommendation`
 * directly. But its evidence is nothing like a SAM notice's: the match is
 * part-level — an NSN, a manufacturer's part number, a prior award to the
 * client's own CAGE — not a NAICS/PSC/agency triangulation. Bolting a
 * part-level rail onto `recommendOpportunity` would have meant a scorer whose
 * inputs are half-null on every call, so this is its own pure function with its
 * own reason vocabulary and its own ordered rules.
 *
 * ── AWARDS CANNOT REACH THIS FUNCTION, BY TYPE ──────────────────────────────
 *
 * P40's acceptance says award rows are informational and cannot be pursued, and
 * enforced that structurally by putting them in their own table
 * (`TangoDibbsAward`) rather than behind an `isPursuable` predicate. This file
 * continues that: `DibbsRelevanceInput.documentType` admits `'rfq' | 'rfp'` and
 * nothing else, so an award is not a value this function can be called with.
 * Award context is `describeDibbsAwardIntelligence`, which returns no
 * recommendation field at all — there is no code path by which an award becomes
 * a Pursue, because there is no field to put one in.
 *
 * ── THREE OF THE PLAN'S FIVE SIGNALS ARE DORMANT, AND WHY THEY ARE STILL HERE
 *
 * P41's spec names five signals. Two can fire today; three cannot, for
 * structural reasons on one side or the other. They are declared anyway —
 * `exactPscMatch` in `forecast-relevance.ts` is the established posture for a
 * real-but-unreachable signal — but each one's reason is recorded here so the
 * next reader does not have to rediscover it, and so nobody "fixes" a dormant
 * signal by feeding it adjacent data:
 *
 *   - `exactNsnMatch` / `exactPartNumberMatch` — DORMANT. The DIBBS side exists
 *     (`tango_dibbs_solicitation.nsn` / `.part_number`). The CLIENT side does
 *     not: no model in this schema stores a client's reviewed NSNs or part
 *     numbers. `ClientProfileFacts` carries UEI, CAGE, NAICS, PSC, applicant
 *     types, set-aside certifications, capabilities and facilities — no parts.
 *     So the plan's designated STRONGEST signal has no data to match against,
 *     and that gap is a P41 deliverable in its own right: see
 *     `dibbsPartProfileGap`, which reports it as UNAVAILABLE rather than as a
 *     failed match. A client with no reviewed parts is not a client whose parts
 *     did not match.
 *   - `buyerHistory` — DORMANT. `tango_dibbs_solicitation.buyer_code` exists
 *     (RFP only; an RFQ never states one), but nothing stores which DLA buyers
 *     a client has transacted with, so there is no history to compare it to.
 *   - PSC/NAICS is ABSENT ENTIRELY and is deliberately not an input below.
 *     The client side has both, but `tango_dibbs_solicitation` has no PSC or
 *     NAICS column and P40's mapper reads none, because the provider's
 *     published DIBBS contract does not carry them. An input for it would be a
 *     parameter no caller could ever populate from a stored row.
 *
 * The one thing that must never happen to a dormant signal here is the
 * `AwardHistoryFacts.contractOffices` mistake, whose own comment records it:
 * an office signal was populated with the awarding sub-tier because that field
 * was adjacent and available, which produced a signal that fired on the wrong
 * fact and surfaced agency names as "prior office" terms. A dormant signal
 * passed `false` is honest. A dormant signal fed a lookalike is a defect.
 *
 * ── The floor rule is its own field, not an inference ────────────────────────
 *
 * P41's acceptance: "a capability-text-only match cannot clear the suggestion
 * floor", and "exact part/NSN is strong; generic manufacturing terms are weak".
 * `clearsSuggestionFloor` states that directly rather than leaving a producer
 * to re-derive it from the recommendation. Those are different questions — a
 * `'monitor'` can be worth showing on a client's board while still not being
 * worth manufacturing a suggestion row for — and a producer that inferred one
 * from the other would silently start creating suggestions the day this
 * function's rule order changed.
 *
 * Pure and DB-free, like every scorer in this directory: every signal is a
 * boolean the caller establishes, and `asOf` is the caller's clock. No
 * `new Date()` in this module.
 */

import type { MachineRecommendation, RecommendationConfidence } from './opportunity-recommendation.js';

export const DIBBS_REASON_CODES = [
  'solicitation_closed',
  'client_profile_too_thin',
  'no_client_evidence',
  'exact_nsn_match',
  'exact_part_number_match',
  'prior_cage_award_history',
  'buyer_history',
  'capability_text_match',
  'closing_imminent',
] as const;
export type DibbsReasonCode = (typeof DIBBS_REASON_CODES)[number];

/** A DIBBS document a client can actually bid. Awards are not one — see the file doc. */
export type DibbsPursuableDocumentType = 'rfq' | 'rfp';

/**
 * Why a part-level match could not be attempted.
 *
 * `no_client_parts_recorded` is the only value today and is NOT the same claim
 * as "no match": it says Capiro holds nothing to match against. Kept as a
 * vocabulary rather than a boolean so a later phase that adds a client part
 * store can add `client_parts_recorded` without changing a field's meaning.
 */
export const DIBBS_PART_PROFILE_GAPS = ['no_client_parts_recorded'] as const;
export type DibbsPartProfileGap = (typeof DIBBS_PART_PROFILE_GAPS)[number];

export interface DibbsRelevanceInput {
  /** `'rfq' | 'rfp'`. An award cannot be passed here — see the file doc. */
  documentType: DibbsPursuableDocumentType;
  /**
   * The provider's own open/closed judgement, as stored. Null means the
   * provider did not say — never treated as closed, because a null is an
   * absence of a statement and closing a live bid on one would lose a real
   * opportunity.
   */
  isOpen: boolean | null;
  /** `closesDate` as ISO, or null. RFQ `return_by_date` / RFP `closes_date`, already normalized by P40. */
  closesDate: string | null;
  /** True when the client profile cannot support a judgement yet — the concept `recommendOpportunity`'s `profileTooThin` names. */
  profileTooThin: boolean;
  /** DORMANT — no client part store exists. See the file doc; pass `false`. */
  exactNsnMatch: boolean;
  /** DORMANT — no client part store exists. See the file doc; pass `false`. */
  exactPartNumberMatch: boolean;
  /** LIVE. A `tango_dibbs_award` whose `awardeeCage`/`awardeeCageCode` is this client's own recorded CAGE. */
  priorCageAwardHistory: boolean;
  /** DORMANT — nothing stores a client's DLA buyer history. See the file doc; pass `false`. */
  buyerHistory: boolean;
  /** LIVE, and WEAK BY RULE: the client's capability keywords against the item's `nomenclature`. Cannot clear the floor alone. */
  capabilityTextMatch: boolean;
  /** Whether Capiro holds any reviewed part/NSN data for this client. `false` today for every client. */
  clientHasRecordedParts: boolean;
  /** The caller's clock. Never `new Date()` inside this module. */
  asOf: Date;
}

export interface DibbsRelevanceResult {
  machineRecommendation: MachineRecommendation;
  /** Evidence quality. NEVER a probability of winning the award. */
  recommendationConfidence: RecommendationConfidence;
  primaryReason: string;
  primaryRisk: string | null;
  recommendedNextAction: string;
  reasonCodes: DibbsReasonCode[];
  /**
   * Whether this item is strong enough to manufacture a suggestion row for.
   * Stated, never inferred from `machineRecommendation` — see the file doc.
   */
  clearsSuggestionFloor: boolean;
  /**
   * Set when a part-level match could not be attempted at all, so a UI can
   * offer a review link instead of implying the parts did not match. Null once
   * the client has recorded parts.
   */
  dibbsPartProfileGap: DibbsPartProfileGap | null;
}

/**
 * Days inside which a bid closing is called imminent.
 *
 * Deliberately tight. A DIBBS RFQ's quote window is routinely days, not the
 * weeks a SAM notice allows, so a wide window would mark nearly every open item
 * imminent and the flag would stop meaning anything.
 */
export const DIBBS_IMMINENT_CLOSING_DAYS = 7;

function daysUntil(date: string | null, asOf: Date): number | null {
  if (!date) return null;
  const at = new Date(date).getTime();
  if (Number.isNaN(at)) return null;
  return Math.floor((at - asOf.getTime()) / 86_400_000);
}

/**
 * Closed means the provider SAID closed, or the closing date has genuinely
 * passed.
 *
 * Both are checked because P40 stores `isOpen` as stated rather than deriving
 * it, and its own column comment records why: "a date in the past does not
 * always mean the provider considers the item closed". The converse also holds
 * — a provider that still says open on a bid that closed last month is not a
 * reason to invite a quote — so a definitely-past date closes it regardless.
 */
function isClosed(input: DibbsRelevanceInput): boolean {
  if (input.isOpen === false) return true;
  const days = daysUntil(input.closesDate, input.asOf);
  return days != null && days < 0;
}

export function scoreDibbsRelevance(input: DibbsRelevanceInput): DibbsRelevanceResult {
  const partGap: DibbsPartProfileGap | null = input.clientHasRecordedParts ? null : 'no_client_parts_recorded';
  const days = daysUntil(input.closesDate, input.asOf);
  const imminent = days != null && days >= 0 && days <= DIBBS_IMMINENT_CLOSING_DAYS;

  // ── Rule 1: the bid is closed ───────────────────────────────────────────
  if (isClosed(input)) {
    return {
      machineRecommendation: 'pass',
      recommendationConfidence: 'high',
      primaryReason: 'This bid-board item is closed.',
      primaryRisk: null,
      recommendedNextAction: 'No action. Prior awards on this NSN may still be useful as pricing history.',
      reasonCodes: ['solicitation_closed'],
      clearsSuggestionFloor: false,
      dibbsPartProfileGap: partGap,
    };
  }

  // ── Rule 2: we cannot answer yet ────────────────────────────────────────
  if (input.profileTooThin) {
    return {
      machineRecommendation: 'needs_review',
      recommendationConfidence: 'low',
      primaryReason: 'The client profile is too thin for a fit judgement against this bid-board item.',
      primaryRisk: null,
      recommendedNextAction: 'Complete the client profile, then re-review.',
      reasonCodes: ['client_profile_too_thin'],
      clearsSuggestionFloor: false,
      dibbsPartProfileGap: partGap,
    };
  }

  const codes: DibbsReasonCode[] = [];
  if (input.exactNsnMatch) codes.push('exact_nsn_match');
  if (input.exactPartNumberMatch) codes.push('exact_part_number_match');
  if (input.priorCageAwardHistory) codes.push('prior_cage_award_history');
  if (input.buyerHistory) codes.push('buyer_history');
  if (input.capabilityTextMatch) codes.push('capability_text_match');
  if (imminent) codes.push('closing_imminent');

  const substantive = codes.filter((code) => code !== 'closing_imminent');

  // ── Rule 3: nothing ties this item to the client ────────────────────────
  //
  // A closing date on its own is not evidence: every open item has one.
  if (substantive.length === 0) {
    return {
      machineRecommendation: 'pass',
      recommendationConfidence: 'high',
      primaryReason: "No evidence ties this bid-board item to the client's recorded profile.",
      primaryRisk: null,
      recommendedNextAction: partGap
        ? 'No action. Recording this client\'s NSNs and part numbers is what makes part-level matching possible.'
        : 'No action. Adding capabilities or a verified CAGE may surface a better match.',
      reasonCodes: codes.length ? codes : ['no_client_evidence'],
      clearsSuggestionFloor: false,
      dibbsPartProfileGap: partGap,
    };
  }

  // ── Rule 4: an exact part-level match, or a prior award on this CAGE ────
  const hasStrongMatch = input.exactNsnMatch || input.exactPartNumberMatch || input.priorCageAwardHistory;
  if (hasStrongMatch) {
    const partLevel = input.exactNsnMatch || input.exactPartNumberMatch;
    return {
      machineRecommendation: 'pursue',
      recommendationConfidence: partLevel && input.priorCageAwardHistory ? 'high' : 'medium',
      primaryReason: partLevel
        ? 'An exact part-level match against this client\'s recorded parts.'
        : "A prior DLA award to this client's own CAGE code on this kind of item.",
      primaryRisk: imminent && days != null ? `The quote window closes in ${days} day${days === 1 ? '' : 's'}.` : null,
      recommendedNextAction: strongAction(input, imminent, days),
      reasonCodes: codes,
      clearsSuggestionFloor: true,
      dibbsPartProfileGap: partGap,
    };
  }

  // ── Rule 5: weak evidence only — capability text and/or a buyer match ───
  //
  // P41's acceptance, stated directly: generic manufacturing terms are weak.
  // "We make brackets" against a nomenclature reading "BRACKET, ANGLE" is a
  // coincidence of vocabulary, not evidence this client makes THIS part, so it
  // is worth showing and not worth suggesting.
  const capabilityOnly = substantive.length === 1 && substantive[0] === 'capability_text_match';
  return {
    machineRecommendation: 'monitor',
    recommendationConfidence: 'low',
    primaryReason: capabilityOnly
      ? "The item's nomenclature matches the client's capability text, which is a vocabulary match and not part-level evidence."
      : 'Some evidence ties this item to the client, but no exact part-level match or prior award.',
    primaryRisk: null,
    recommendedNextAction: partGap
      ? 'Confirm with the client whether they supply this NSN, and record their part numbers so this can be matched rather than guessed.'
      : 'Confirm with the client whether they supply this NSN.',
    reasonCodes: codes,
    clearsSuggestionFloor: false,
    dibbsPartProfileGap: partGap,
  };
}

function strongAction(input: DibbsRelevanceInput, imminent: boolean, days: number | null): string {
  const urgency = imminent && days != null ? ` Quotes close in ${days} day${days === 1 ? '' : 's'}.` : '';
  if (input.documentType === 'rfq') {
    return `Price the line item and submit a quote through DIBBS.${urgency}`;
  }
  return `Review the solicitation and technical documents, then decide on a proposal.${urgency}`;
}

/**
 * Award context — INFORMATIONAL, and deliberately shaped so it cannot become a
 * pursuit.
 *
 * There is no recommendation, confidence, or next action on this result: P41's
 * acceptance is "awards never offer Pursue", and the way to guarantee that is
 * for the award path to have no field a Pursue could occupy. It answers one
 * question — what does this prior award tell us — and stops.
 *
 * `priceIsUnknown` exists because "no price" and "a price of zero" are
 * different facts, and `tango_dibbs_award.total_contract_price` is nullable
 * while `total_contract_price_text` may still carry what the source displayed.
 * A caller must not render a null as `$0`.
 */
export interface DibbsAwardIntelligence {
  /** True when this award went to the client's own recorded CAGE. */
  isOwnAward: boolean;
  /** True when the numeric price is absent, whatever the display text says. */
  priceIsUnknown: boolean;
  summary: string;
}

export function describeDibbsAwardIntelligence(input: {
  awardeeCage: string | null;
  awardeeCageCode: string | null;
  clientCageCode: string | null;
  awardeeLegalBusinessName: string | null;
  totalContractPrice: string | null;
}): DibbsAwardIntelligence {
  // Both provider fields are checked, and neither is assumed equal to the
  // other — P40 stores both precisely because they can disagree.
  const clientCage = input.clientCageCode?.trim().toUpperCase() ?? null;
  const candidates = [input.awardeeCage, input.awardeeCageCode]
    .map((value) => value?.trim().toUpperCase() ?? null)
    .filter((value): value is string => value != null && value.length > 0);
  const isOwnAward = clientCage != null && clientCage.length > 0 && candidates.includes(clientCage);

  const priceIsUnknown = input.totalContractPrice == null || input.totalContractPrice === '';

  const who = isOwnAward
    ? 'This client'
    : (input.awardeeLegalBusinessName?.trim() || 'Another supplier');

  return {
    isOwnAward,
    priceIsUnknown,
    summary: priceIsUnknown
      ? `${who} previously won this item. The source states no award price.`
      : `${who} previously won this item.`,
  };
}
