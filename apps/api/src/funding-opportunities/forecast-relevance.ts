/**
 * The deterministic forecast recommendation: what a government-affairs team
 * should DO with one agency procurement forecast, and why (Funding
 * Opportunities P25).
 *
 * ── A separate question from `recommendOpportunity`'s ────────────────────────
 *
 * A forecast is "here is what an agency expects to buy" — a pre-
 * solicitation signal, never a live competition. `recommendOpportunity`
 * answers "should this client bid, given a real response window and a real
 * eligibility determination"; neither of those exists yet for a forecast
 * (there is no response deadline to be imminent about, and no eligibility
 * state — see `TangoForecast`'s own doc for why the provider carries
 * neither). So this is its own function, its own four-value vocabulary
 * (`FORECAST_RECOMMENDATIONS` in `opportunity-recommendation.ts`), and its
 * own rule order — never a branch bolted onto `recommendOpportunity`.
 *
 * `machineRecommendation` on the result is the COMMON vocabulary every
 * `FundingOpportunity.recommendation` already carries, via
 * `FORECAST_TO_MACHINE_RECOMMENDATION` — and it is NEVER `'pursue'`, for
 * every reason that constant's own doc gives. `forecastRecommendation`
 * keeps the forecast-specific distinction (`shape_now` vs. plain `monitor`)
 * that mapping deliberately erases for the common field.
 *
 * ── No eligibility is inferred here — the plan's own line ────────────────────
 *
 * There is no `eligibility` field on this result at all, and no input for
 * one. A forecast is not a solicitation a client can be barred from; there
 * is nothing yet to determine eligibility FOR. Signals below establish FIT
 * (does this look like the client's kind of work, does the client have a
 * plausible route to compete), never a legal determination.
 *
 * ── No response deadline is fabricated ───────────────────────────────────────
 *
 * `anticipatedAwardDate` is exactly what `TangoForecast` calls it — an
 * agency's own rough estimate, present on `tango_procurement_forecast` as a
 * DATE with no time component. It influences urgency in the recommended
 * next action's WORDING (a shape_now sitting six weeks out reads
 * differently from one a year out) but is never surfaced as, or treated
 * internally as, a response deadline — there is no `daysUntilDeadline`
 * anywhere in this file, on purpose.
 *
 * ── Signals, and where each one comes from ───────────────────────────────────
 *
 * Every signal is a plain boolean the CALLER establishes — this function is
 * pure and DB-free, exactly like `recommendOpportunity`, so the truth table
 * below is provable without a database:
 *
 *   - `exactNaicsMatch` / `exactPscMatch`   — the forecast's own naicsCode/
 *     (never-populated, per D-45) pscCode against the client's recorded
 *     codes. `pscCode` is always null on a real forecast today, so this
 *     signal is real but, like a few others in this file, not currently
 *     reachable with live data — same posture as D-41/D-44's dormant paths.
 *   - `capabilityMatch`                    — the client's own recorded
 *     capabilities/keywords against the forecast's title/description,
 *     established by the SAME kind of scorer `sam-opportunity-relevance.ts`
 *     already uses for live solicitations — never fuzzy-matched here.
 *   - `priorAgencyHistory`                 — from `FederalBusinessProfile`
 *     (P21): a verified Tango entity observation or first-party award
 *     history with the SAME agency this forecast names.
 *   - `programElementLinkedSourceBacked`   — TRUE ONLY for a link with the
 *     SAME evidentiary bar `SamOpportunityMatch.reviewStatus === 'accepted'`
 *     already enforces for live notices (`sam-opportunity-matcher.ts`): a
 *     verbatim PE code in the forecast's own text, corroborated against the
 *     client's asserted PE numbers — never a bare NAICS/PSC coincidence,
 *     which that same pipeline caps at `'quarantined'`, never `'accepted'`.
 *   - `locationMatch`                      — the forecast's own
 *     `placeOfPerformance` free text against the client's facility
 *     locations — a fact check, never a geocoded inference.
 *   - `knownVehicleAccess`                 — from `AcquisitionPositionService`
 *     (P23): true only for a CURRENT, usable position
 *     (`direct_prime_access`/`related_entity_access`/`known_teaming_route`),
 *     never `vehicle_not_identified`/`no_direct_access_evidence`/`unknown`.
 *   - `reviewedStrategicPriority`          — a human-reviewed watch-list
 *     match, never machine-inferred. No such review workflow exists yet;
 *     real, scored, and untriggered until one does — same posture as
 *     `known_teaming_route` (D-44) and every other dormant-but-tested path
 *     in this program.
 */

import type { MachineRecommendation, RecommendationConfidence } from './opportunity-recommendation.js';
import { FORECAST_TO_MACHINE_RECOMMENDATION, type ForecastRecommendation } from './opportunity-recommendation.js';

export const FORECAST_REASON_CODES = [
  'forecast_inactive',
  'client_profile_too_thin',
  'no_client_evidence',
  'exact_naics_match',
  'exact_psc_match',
  'capability_match',
  'prior_agency_history',
  'program_element_linked',
  'location_match',
  'known_vehicle_access',
  'reviewed_strategic_priority',
  'anticipated_award_approaching',
] as const;
export type ForecastReasonCode = (typeof FORECAST_REASON_CODES)[number];

export interface ForecastRelevanceInput {
  /** From the forecast's own `isActive`. `false` means the agency withdrew or closed it out — never something to shape now. */
  isActive: boolean | null;
  /** True when the client profile cannot support a judgement yet — same concept `recommendOpportunity`'s `profileTooThin` names. */
  profileTooThin: boolean;
  exactNaicsMatch: boolean;
  exactPscMatch: boolean;
  capabilityMatch: boolean;
  priorAgencyHistory: boolean;
  /** TRUE ONLY for a source-backed link — see this file's own class doc. */
  programElementLinkedSourceBacked: boolean;
  locationMatch: boolean;
  /** TRUE ONLY for a current, usable AcquisitionPosition — see this file's own class doc. */
  knownVehicleAccess: boolean;
  reviewedStrategicPriority: boolean;
  /** The forecast's own `anticipatedAwardDate`, ISO or null — an agency estimate, never a deadline. */
  anticipatedAwardDate: string | null;
  /** The caller's clock. Never `new Date()` inside this module — same rule as opportunity-recommendation.ts. */
  asOf: Date;
}

export interface ForecastRelevanceResult {
  forecastRecommendation: ForecastRecommendation;
  /** The common vocabulary, via FORECAST_TO_MACHINE_RECOMMENDATION. NEVER 'pursue'. */
  machineRecommendation: MachineRecommendation;
  /** Evidence quality. NEVER a probability of winning, and NEVER a probability the forecast turns into a real solicitation. */
  recommendationConfidence: RecommendationConfidence;
  primaryReason: string;
  primaryRisk: string | null;
  recommendedNextAction: string;
  reasonCodes: ForecastReasonCode[];
}

/** Days inside which an anticipated award date is called "approaching" — far wider than an active solicitation's IMMINENT_DEADLINE_DAYS, because shaping a capture takes months, not days. */
export const APPROACHING_AWARD_DAYS = 90;

function daysUntil(date: string | null, asOf: Date): number | null {
  if (!date) return null;
  const at = new Date(date).getTime();
  if (Number.isNaN(at)) return null;
  return Math.floor((at - asOf.getTime()) / 86_400_000);
}

function toCommon(forecastRecommendation: ForecastRecommendation): MachineRecommendation {
  return FORECAST_TO_MACHINE_RECOMMENDATION[forecastRecommendation];
}

export function scoreForecastRelevance(input: ForecastRelevanceInput): ForecastRelevanceResult {
  const days = daysUntil(input.anticipatedAwardDate, input.asOf);
  const approaching = days != null && days >= 0 && days <= APPROACHING_AWARD_DAYS;

  // ── Rule 1: the agency withdrew or closed it out ────────────────────────
  if (input.isActive === false) {
    return {
      forecastRecommendation: 'pass',
      machineRecommendation: toCommon('pass'),
      recommendationConfidence: 'high',
      primaryReason: 'The agency has marked this forecast inactive.',
      primaryRisk: null,
      recommendedNextAction: 'No action. Keep it saved for reference if it informs future capture planning.',
      reasonCodes: ['forecast_inactive'],
    };
  }

  // ── Rule 2: we cannot answer yet ─────────────────────────────────────────
  if (input.profileTooThin) {
    return {
      forecastRecommendation: 'needs_review',
      machineRecommendation: toCommon('needs_review'),
      recommendationConfidence: 'low',
      primaryReason: 'The client profile is too thin for a fit judgement against this forecast.',
      primaryRisk: null,
      recommendedNextAction: 'Complete the client profile, then re-review.',
      reasonCodes: ['client_profile_too_thin'],
    };
  }

  const codes: ForecastReasonCode[] = [];
  if (input.exactNaicsMatch) codes.push('exact_naics_match');
  if (input.exactPscMatch) codes.push('exact_psc_match');
  if (input.capabilityMatch) codes.push('capability_match');
  if (input.priorAgencyHistory) codes.push('prior_agency_history');
  if (input.programElementLinkedSourceBacked) codes.push('program_element_linked');
  if (input.locationMatch) codes.push('location_match');
  if (input.knownVehicleAccess) codes.push('known_vehicle_access');
  if (input.reviewedStrategicPriority) codes.push('reviewed_strategic_priority');
  if (approaching) codes.push('anticipated_award_approaching');

  // ── Rule 3: a generic forecast with no client evidence must never surface ──
  if (codes.length === 0 || (codes.length === 1 && codes[0] === 'anticipated_award_approaching')) {
    return {
      forecastRecommendation: 'pass',
      machineRecommendation: toCommon('pass'),
      recommendationConfidence: 'high',
      primaryReason: "No evidence ties this forecast to the client's recorded profile.",
      primaryRisk: null,
      recommendedNextAction:
        'No action. Adding client capabilities, PE numbers, or a UEI-verified profile may surface a better match.',
      reasonCodes: codes.length ? codes : ['no_client_evidence'],
    };
  }

  // ── Rule 4: an exact program or capability match — shape now ────────────
  const hasStrongMatch =
    input.exactNaicsMatch || input.exactPscMatch || input.capabilityMatch || input.programElementLinkedSourceBacked;
  if (hasStrongMatch) {
    return {
      forecastRecommendation: 'shape_now',
      machineRecommendation: toCommon('shape_now'),
      recommendationConfidence: input.priorAgencyHistory || input.knownVehicleAccess ? 'high' : 'medium',
      primaryReason: "An exact program or capability match against this client's recorded profile.",
      primaryRisk: input.knownVehicleAccess
        ? null
        : 'No confirmed acquisition vehicle access for this agency yet.',
      recommendedNextAction: shapeNowAction(input, approaching, days),
      reasonCodes: codes,
    };
  }

  // ── Rule 5: weaker evidence only (location/vehicle/strategic priority alone) — monitor ──
  return {
    forecastRecommendation: 'monitor',
    machineRecommendation: toCommon('monitor'),
    recommendationConfidence: 'low',
    primaryReason: 'Some evidence ties this forecast to the client, but no exact program or capability match.',
    primaryRisk: null,
    recommendedNextAction: 'Watch for a linked solicitation, or confirm interest with the client.',
    reasonCodes: codes,
  };
}

function shapeNowAction(input: ForecastRelevanceInput, approaching: boolean, days: number | null): string {
  const urgency = approaching ? ` The agency's own anticipated award estimate is ${days} day${days === 1 ? '' : 's'} out.` : '';
  if (!input.knownVehicleAccess) {
    return `Research the program office and confirm a route to compete before a solicitation posts.${urgency}`;
  }
  if (input.priorAgencyHistory) {
    return `Schedule a capability briefing with the program office.${urgency}`;
  }
  return `Identify a teaming partner or confirm vehicle access, then plan a capability briefing.${urgency}`;
}
