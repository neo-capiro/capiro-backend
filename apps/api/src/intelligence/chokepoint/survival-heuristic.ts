/**
 * Chokepoint survival heuristic v1 (Phase 1 M2.4, PD3) — a weighted additive
 * score in [0,1], fully specified, deterministic, NOT ML. Each factor
 * contributes only when its input is actually resolvable; an unresolved
 * factor is scored as zero contribution AND downgrades the result's
 * confidence to 'low' — the band is never presented as high-confidence when
 * built from a partial score (PD2's "never guess" standard applied to a
 * heuristic instead of a single fact).
 *
 * Weights/thresholds are v1 starting values to be calibrated against a
 * backtest (M2-H), not final.
 */
export interface SurvivalFactors {
  /** Sponsor's party = chamber majority, or sponsor holds a leadership/chair role. Null = unresolvable. */
  sponsorInMajorityOrLeadership: boolean | null;
  /** The referred-committee chair sponsors or cosponsors this bill. Null = unresolvable (e.g. no committee resolved). */
  chairIsSponsorOrCosponsor: boolean | null;
  /** A same-as companion has cleared its first committee. Null = no companion (not a missing input — see note). */
  companionAdvancing: boolean | null;
  /** The bill's derived status has reached `reported` or later. */
  committeeAdvancement: boolean | null;
  /** Days until the nearest relevant cutoff (negative = already past it). Null = no calendar data curated for this session. */
  daysToCutoff: number | null;
  /** Was daysToCutoff computed against an ALREADY-PASSED cutoff (computeStateDeadlineRisk's isPastCutoff)? Ignored when daysToCutoff is null. */
  isPastCutoff: boolean;
  /** Has the bill's derived status reached `passed_chamber` or later? Distinct from committeeAdvancement (`reported`) — the daysToCutoff bonus needs THIS threshold, not the earlier one. */
  passedChamberOrLater: boolean;
}

export type SurvivalBand = 'stalled' | 'at-risk' | 'likely-advances';

export interface SurvivalResult {
  score: number;
  band: SurvivalBand;
  /** 'low' when ANY factor's input was unresolvable — the band is a partial score, never presented as high-confidence. */
  confidence: 'normal' | 'low';
}

export function computeSurvivalHeuristic(f: SurvivalFactors): SurvivalResult {
  let score = 0;
  let anyMissing = false;

  if (f.sponsorInMajorityOrLeadership == null) anyMissing = true;
  else if (f.sponsorInMajorityOrLeadership) score += 0.2;

  if (f.chairIsSponsorOrCosponsor == null) anyMissing = true;
  else if (f.chairIsSponsorOrCosponsor) score += 0.2;

  // A bill with NO companion at all is not a missing input for this factor —
  // "no companion advancing" is a real, resolvable fact (false), not unknown.
  if (f.companionAdvancing) score += 0.15;

  if (f.committeeAdvancement == null) anyMissing = true;
  else if (f.committeeAdvancement) score += 0.2;

  if (f.daysToCutoff == null) {
    anyMissing = true;
  } else if (f.daysToCutoff < 7 && f.committeeAdvancement === false) {
    // Explicitly known status < reported — NOT just "unresolved" (null),
    // which must apply neither adjustment (we can't tell which one fits).
    score -= 0.25;
  } else if (f.isPastCutoff && f.passedChamberOrLater) {
    // "already past the nearest cutoff with status >= passed_chamber" — by
    // construction (computeStateDeadlineRisk's staging), a bill this far past
    // its OWN current-stage cutoff is only still alive because it genuinely
    // advanced despite the calendar — a real momentum signal, not decay.
    score += 0.1;
  }

  score = Math.max(0, Math.min(1, score));
  const band: SurvivalBand = score < 0.3 ? 'stalled' : score <= 0.6 ? 'at-risk' : 'likely-advances';
  return { score, band, confidence: anyMissing ? 'low' : 'normal' };
}
