/**
 * The deterministic recommendation: what a government-affairs team should DO with
 * one opportunity, and why.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is not a fifth score, and it does not replace relevance or eligibility.
 * Those two answer "is this your kind of work" and "are you permitted to apply".
 * Neither answers "so what", which is the question a triage inbox exists to
 * answer, and which every reader was previously left to infer from a number.
 *
 * `recommendationConfidence` is EVIDENCE QUALITY, never a probability of winning.
 * A high-confidence `pass` is a confident recommendation not to bid. Rendering it
 * as a win rate would be the single most misleading thing this field could do.
 *
 * DETERMINISTIC MEANS DETERMINISTIC
 * ---------------------------------
 *  - No LLM. Every string it returns is composed here from source facts.
 *  - No wall clock. Deadline proximity is measured against the caller's `asOf`,
 *    so the same inputs produce the same output tomorrow.
 *  - No dependence on input ORDER. Signals are reduced to a strength tally and a
 *    set of keys; re-sorting `matchedSignals` cannot change the outcome.
 *
 * THE RULES ARE AN ORDERED LIST, AND FIRST MATCH WINS
 * --------------------------------------------------
 * Precedence is the whole design. Written as independent `if`s, two conditions
 * that both hold (a closed notice the client is also ineligible for) would give a
 * different answer depending on which check happened to be written first, and
 * nobody reviewing it could tell. The order below is the specification:
 *
 *   1. source closed              -> pass          (the window is gone)
 *   2. informational notice       -> monitor       (never a pursuit; still intel)
 *   3. ineligible                 -> pass          (barred, however good the fit)
 *   4. profile too thin to judge  -> needs_review  (we cannot answer yet)
 *   5. eligibility unresolved     -> needs_review  (never pursue on an unknown)
 *   6. below the evidence floor   -> pass          (should not have surfaced)
 *   7. strong evidence            -> pursue
 *   8. otherwise                  -> monitor
 *
 * Rules 1 and 2 are the plan's hard invariant — a closed or informational notice
 * can never be `pursue` — and they sit first so no later rule can override them.
 * Rule 5 is the other one stated explicitly: strong relevance with unresolved
 * eligibility is `needs_review`, not `pursue`.
 *
 * FORECASTS ARE OUT OF SCOPE
 * --------------------------
 * A forecasted opportunity has no response window and cannot be pursued or
 * passed on in the same sense. P25 adds forecast rules; until then the caller
 * must not route forecasts through this function.
 */

import type { EligibilityState, OpportunityKind, OpportunitySource } from './funding-opportunities.types.js';

export const MACHINE_RECOMMENDATIONS = ['pursue', 'monitor', 'pass', 'needs_review'] as const;
export type MachineRecommendation = (typeof MACHINE_RECOMMENDATIONS)[number];

export const RECOMMENDATION_CONFIDENCES = ['high', 'medium', 'low'] as const;
export type RecommendationConfidence = (typeof RECOMMENDATION_CONFIDENCES)[number];

/**
 * The bounded reason vocabulary. Bounded so the web mirror can label every value
 * it will ever receive, and so a new reason is a reviewable addition rather than
 * a string that renders as itself.
 */
export const RECOMMENDATION_REASON_CODES = [
  'source_closed',
  'informational_notice',
  'not_eligible',
  'client_profile_too_thin',
  'eligibility_needs_review',
  'eligibility_unknown',
  'below_evidence_floor',
  'strong_capability_match',
  'moderate_capability_match',
  'prior_agency_award_history',
  'deadline_imminent',
  'deadline_not_stated',
  'no_award_history_evidence',
] as const;
export type RecommendationReasonCode = (typeof RECOMMENDATION_REASON_CODES)[number];

/** Days inside which a deadline is called imminent. */
export const IMMINENT_DEADLINE_DAYS = 14;

export interface RecommendationInput {
  source: OpportunitySource;
  kind: OpportunityKind;
  /** Derived from the source's own flag or dates — never guessed. */
  isActive: boolean;
  /** False for kinds that are informational rather than pursuable. */
  isPursuable: boolean;
  responseDeadline: string | null;
  relevanceScore: number;
  /** Strength bands only. Order is deliberately not consulted. */
  signalStrengths: ReadonlyArray<'strong' | 'moderate' | 'weak'>;
  /** Signal keys, used only for membership tests. */
  signalKeys: ReadonlyArray<string>;
  eligibility: EligibilityState;
  /** True when the client profile cannot support a judgement yet. */
  profileTooThin: boolean;
  /** The caller's clock. Never `new Date()` inside this module. */
  asOf: Date;
}

export interface OpportunityRecommendationResult {
  machineRecommendation: MachineRecommendation;
  /** Evidence quality. NOT a probability of winning. */
  recommendationConfidence: RecommendationConfidence;
  /** One sentence, composed from facts. */
  primaryReason: string;
  /** The strongest reason NOT to act, or null when there is none worth naming. */
  primaryRisk: string | null;
  recommendedNextAction: string;
  reasonCodes: RecommendationReasonCode[];
}

const AGENCY_HISTORY_SIGNALS = new Set(['priorAgency', 'priorAgencyAwardHistory', 'priorOffice']);

function tally(strengths: ReadonlyArray<'strong' | 'moderate' | 'weak'>) {
  let strong = 0;
  let moderate = 0;
  let weak = 0;
  for (const s of strengths) {
    if (s === 'strong') strong += 1;
    else if (s === 'moderate') moderate += 1;
    else weak += 1;
  }
  return { strong, moderate, weak };
}

/**
 * The same floor the producers use: one strong signal, or two distinct moderate
 * ones. A score alone is never sufficient, because a pile of generic-token hits
 * can clear a numeric threshold without amounting to evidence.
 */
function meetsEvidenceFloor(t: { strong: number; moderate: number }): boolean {
  return t.strong >= 1 || t.moderate >= 2;
}

function daysUntil(deadline: string | null, asOf: Date): number | null {
  if (!deadline) return null;
  const at = new Date(deadline).getTime();
  if (Number.isNaN(at)) return null;
  return Math.floor((at - asOf.getTime()) / 86_400_000);
}

/** `sources sought` from `sources_sought`, for prose. */
function kindPhrase(kind: OpportunityKind): string {
  return kind.replace(/_/g, ' ');
}

export function recommendOpportunity(
  input: RecommendationInput,
): OpportunityRecommendationResult {
  const t = tally(input.signalStrengths);
  const floor = meetsEvidenceFloor(t);
  const days = daysUntil(input.responseDeadline, input.asOf);
  const imminent = days != null && days >= 0 && days <= IMMINENT_DEADLINE_DAYS;
  const hasAgencyHistory = input.signalKeys.some((k) => AGENCY_HISTORY_SIGNALS.has(k));

  // Risk is computed once and attached to whatever recommendation wins, so a
  // `pursue` still names its strongest objection rather than reading as unqualified.
  const risk: string | null = (() => {
    if (input.eligibility === 'needs_review') {
      return 'Eligibility has not been resolved for this client.';
    }
    if (input.eligibility === 'unknown') {
      return 'The notice does not state eligibility, so it has not been evaluated.';
    }
    if (input.profileTooThin) {
      return 'The client profile is too thin to judge fit confidently.';
    }
    if (imminent) {
      return `The response deadline is ${days} day${days === 1 ? '' : 's'} away.`;
    }
    if (input.responseDeadline == null && input.isActive) {
      return 'The notice states no response deadline.';
    }
    if (!hasAgencyHistory) {
      return 'No prior award history with this agency.';
    }
    return null;
  })();

  const deadlineCodes: RecommendationReasonCode[] = [];
  if (imminent) deadlineCodes.push('deadline_imminent');
  else if (input.responseDeadline == null && input.isActive) {
    deadlineCodes.push('deadline_not_stated');
  }

  // ── Rule 1: the window is gone ──────────────────────────────────────────────
  if (!input.isActive) {
    return {
      machineRecommendation: 'pass',
      // The source itself says so, so this is as certain as the feature gets.
      recommendationConfidence: 'high',
      primaryReason: 'The source has closed this opportunity.',
      primaryRisk: null,
      recommendedNextAction: 'No action. Keep it saved for reference if it informs future pursuits.',
      reasonCodes: ['source_closed'],
    };
  }

  // ── Rule 2: informational, never a pursuit ──────────────────────────────────
  if (!input.isPursuable) {
    return {
      machineRecommendation: 'monitor',
      recommendationConfidence: 'high',
      primaryReason: `This is a ${kindPhrase(input.kind)}, which is information rather than a solicitation.`,
      primaryRisk: null,
      recommendedNextAction: 'Read it for agency direction. There is nothing to respond to.',
      reasonCodes: ['informational_notice'],
    };
  }

  // ── Rule 3: barred, however good the fit ────────────────────────────────────
  if (input.eligibility === 'ineligible') {
    return {
      machineRecommendation: 'pass',
      recommendationConfidence: 'high',
      primaryReason: 'The client is not eligible to apply.',
      primaryRisk: null,
      recommendedNextAction:
        'No action, unless a partner or teaming route makes the work reachable.',
      reasonCodes: ['not_eligible'],
    };
  }

  // ── Rule 4: we cannot answer yet ────────────────────────────────────────────
  if (input.profileTooThin) {
    return {
      machineRecommendation: 'needs_review',
      recommendationConfidence: 'low',
      primaryReason:
        'The client profile is too thin for a fit judgement, so this has not been scored against real facts.',
      primaryRisk: risk,
      recommendedNextAction:
        'Complete the client profile fields listed on the opportunity, then re-review.',
      reasonCodes: ['client_profile_too_thin', ...deadlineCodes],
    };
  }

  // ── Rule 5: never pursue on an unresolved eligibility ───────────────────────
  if (input.eligibility !== 'eligible') {
    const code: RecommendationReasonCode =
      input.eligibility === 'needs_review' ? 'eligibility_needs_review' : 'eligibility_unknown';
    return {
      machineRecommendation: 'needs_review',
      // Medium when the fit itself is strong: the open question is eligibility,
      // not whether the work matches.
      recommendationConfidence: floor ? 'medium' : 'low',
      primaryReason: floor
        ? 'The capability match is strong, but eligibility is unresolved.'
        : 'Eligibility is unresolved and the capability match is not yet strong.',
      primaryRisk: risk,
      recommendedNextAction:
        'Resolve eligibility for this client, then decide. Do not commit bid effort first.',
      reasonCodes: [code, ...deadlineCodes],
    };
  }

  // ── Rule 6: should not have surfaced ────────────────────────────────────────
  if (!floor) {
    return {
      machineRecommendation: 'pass',
      recommendationConfidence: t.weak > 0 ? 'medium' : 'high',
      primaryReason:
        'No strong match, and fewer than two independent moderate matches, against this client.',
      primaryRisk: risk,
      recommendedNextAction: 'No action. Adding client capabilities may surface better matches.',
      reasonCodes: ['below_evidence_floor', ...deadlineCodes],
    };
  }

  // ── Rule 7: strong evidence ─────────────────────────────────────────────────
  if (t.strong >= 1) {
    const codes: RecommendationReasonCode[] = ['strong_capability_match'];
    if (hasAgencyHistory) codes.push('prior_agency_award_history');
    else codes.push('no_award_history_evidence');
    return {
      machineRecommendation: 'pursue',
      // High needs BOTH a strong capability match and prior agency history. One
      // exact code match on its own is real evidence but a thin basis for
      // committing bid effort.
      recommendationConfidence: hasAgencyHistory ? 'high' : 'medium',
      primaryReason: hasAgencyHistory
        ? 'Strong capability match, and prior award history with this agency.'
        : 'Strong capability match against the client’s recorded capabilities.',
      primaryRisk: risk,
      recommendedNextAction: imminent
        ? `Assign an owner today — the deadline is ${days} day${days === 1 ? '' : 's'} away.`
        : 'Assign an owner and confirm the client wants to bid.',
      reasonCodes: [...codes, ...deadlineCodes],
    };
  }

  // ── Rule 8: moderate evidence only ──────────────────────────────────────────
  return {
    machineRecommendation: 'monitor',
    recommendationConfidence: 'medium',
    primaryReason: `${t.moderate} independent moderate matches, but no exact match.`,
    primaryRisk: risk,
    recommendedNextAction: imminent
      ? `Decide whether to bid — the deadline is ${days} day${days === 1 ? '' : 's'} away.`
      : 'Watch for an amendment that sharpens the fit, or confirm interest with the client.',
    reasonCodes: ['moderate_capability_match', ...deadlineCodes],
  };
}
