/**
 * AlertScorer (Phase 4, plan §7.1) — pure. Weighted composite → score ∈ [0,1]
 * → display band. Weights are the plan's §7.1 values (relevance 0.35,
 * materiality 0.25, urgency 0.20, political 0.10, client-priority 0.10, minus a
 * confidence penalty up to 0.15).
 *
 * SHADOW note: the semantic `fit` (§6.1 MatchEngine) is not built yet, so the
 * relevance factor uses a keyword-match proxy (matchedTags present). When §6.1
 * lands, `scoreShadowAlert` upgrades to the real `fit`. The critical change
 * types are floored to High so an enacted/failed/to-president move always bands
 * High (plan §7.1 S5), regardless of the proxy.
 */
import { MATERIALITY_RANK, type AlertSeverity } from './intel-alert.types.js';

/**
 * P1-08: the floor used to key on a hard-coded FEDERAL change-type list, so
 * bill_rule_failed, state_bill_enacted, state_bill_vetoed, state_bill_failed, and
 * state_bill_dead_by_deadline — all classified `critical` by the detector — could
 * band Med. `severity` was already a parameter of scoreShadowAlert and simply unused.
 * Kept as a named list too, because urgencyFactor uses it for a DIFFERENT purpose
 * (a terminal move is urgent even with no action date).
 *
 * Every string below was grepped against change-detector.util.ts and exists there:
 * the first three and `bill_rule_failed` are literals (:32,:40,:59,:154); the four
 * `state_bill_*` entries are produced by `state_bill_${status}` (:229) for the
 * statuses STATE_STATUS_SEVERITY marks `critical` (:200-203).
 */
export const CRITICAL_CHANGE_TYPES = [
  'bill_enacted',
  'bill_to_president',
  'bill_failed',
  // P1-08 additions — each is classified `critical` by change-detector.util.ts.
  'bill_rule_failed',
  'state_bill_enacted',
  'state_bill_vetoed',
  'state_bill_failed',
  'state_bill_dead_by_deadline',
];
/** == bandOf's High threshold. */
export const CRITICAL_SEVERITY_FLOOR = 0.66;
export const PRIORITY_FACTOR: Record<string, number> = { low: 0.33, med: 0.66, high: 1.0 };

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

export interface ScoreFactors {
  relevance: number;
  materiality: number;
  urgency: number;
  political: number;
  clientPriority: number;
  /** Fraction of {semantic,keyword,entity,subject} legs that fired (0–1). */
  legCoverage: number;
}

/** The §7.1 weighted composite (verbatim weights). */
export function computeScore(f: ScoreFactors): number {
  const penalty = 0.15 * (1 - clamp01(f.legCoverage));
  return clamp01(
    0.35 * clamp01(f.relevance) +
      0.25 * clamp01(f.materiality) +
      0.2 * clamp01(f.urgency) +
      0.1 * clamp01(f.political) +
      0.1 * clamp01(f.clientPriority) -
      penalty,
  );
}

export function bandOf(score: number): 'High' | 'Med' | 'Low' {
  return score >= 0.66 ? 'High' : score >= 0.45 ? 'Med' : 'Low';
}

// ── §4.8 re-weight (Gate D phase d-2) ───────────────────────────────────────
/**
 * The scoring model that produced a score. Stored on the alert's evidence so a
 * mixed list is legible: FORWARD-ONLY was chosen (§6.2), which means alerts
 * written before this deploy keep v1 scores and sort against v2 ones. Without
 * this marker that mixing is invisible.
 */
export const SCORE_MODEL_VERSION = 2;

/**
 * §4.8 weights. The v1 model (`computeScore`) used a keyword-boolean relevance
 * proxy and a flat leg-coverage penalty; this one weighs a real weighted match
 * score and an evidence-coverage factor.
 *
 * `bandOf`'s 0.66 / 0.45 thresholds are deliberately NOT moved (Gate D §2.4.2):
 * move them and every historical `band` value becomes incomparable.
 */
export const SCORE_WEIGHTS_V2: Record<string, number> = {
  relevance: 0.3,
  materiality: 0.2,
  urgency: 0.15,
  clientPriority: 0.15,
  targetOpportunity: 0.1,
  evidenceConfidence: 0.1,
};

/** The penalty applied when the same (clientId, sourceRef) already alerted in 24h. */
export const DUPLICATION_PENALTY = 0.05;

/**
 * A factor's value, or `null` for "no signal available".
 *
 * `null` is NOT the same as 0 and the difference is load-bearing.
 * `targetOpportunity` is not derivable in intel-api at all (§6.6: target
 * offices and relationships live in apps/api). Scoring it as a real 0 while it
 * still carries weight 0.10 would dock EVERY alert a tenth it can never earn —
 * and because `bandOf`'s thresholds are deliberately frozen (§2.4.2), that
 * silently walks the whole corpus down a band. So an unavailable factor is
 * excluded from the weighted mean entirely: its weight leaves the denominator
 * instead of its zero entering the numerator. Relative ranking is preserved,
 * the factor is still reported `unavailable` to the UI, and nothing is faked.
 */
export type Factor = number | null;

export interface ScoreFactorsV2 {
  relevance: Factor;
  materiality: Factor;
  urgency: Factor;
  clientPriority: Factor;
  /** §6.6: never derivable here today — pass null, never 0. */
  targetOpportunity: Factor;
  /** clamp01(filled / total) over the seven canonical alert fields. Supersedes
   *  v1's legCoverage penalty — keeping both would double-penalise. */
  evidenceConfidence: Factor;
  /** 0 or DUPLICATION_PENALTY. Computed by the CALLER (writeShadowAlert already
   *  runs a dedup lookup); the scorer stays pure and imports no Prisma.
   *  Subtracted AFTER the weighted mean — it is a penalty, not a factor. */
  duplicationPenalty: number;
}

export interface ScoreBreakdown {
  weights: Record<string, number>;
  /** Each factor's share of the final score, so the UI can say "client
   *  relevance contributed 0.09 of 0.72". Sums (minus the penalty) to `score`. */
  contributions: Record<string, number>;
  /** Factors with no signal at all — the UI shows "unavailable", never "0". */
  unavailable: string[];
  /** True when the phase-a critical floor raised the score above the composite. */
  floored: boolean;
}

const FACTOR_KEYS = [
  'relevance',
  'materiality',
  'urgency',
  'clientPriority',
  'targetOpportunity',
  'evidenceConfidence',
] as const;

/**
 * The §4.8 weighted composite, as a weighted MEAN over the factors that have a
 * signal. Pure. With every factor available the denominator is 1.0 and this is
 * an ordinary weighted sum; with one unavailable it renormalises. See `Factor`.
 */
export function computeScoreV2(f: ScoreFactorsV2): {
  score: number;
  contributions: Record<string, number>;
  unavailable: string[];
} {
  const unavailable: string[] = [];
  let weightSum = 0;
  let weighted = 0;
  for (const key of FACTOR_KEYS) {
    const value = f[key];
    const weight = SCORE_WEIGHTS_V2[key]!;
    if (value == null) {
      unavailable.push(key);
      continue;
    }
    weightSum += weight;
    weighted += weight * clamp01(value);
  }

  const penalty = clamp01(f.duplicationPenalty);
  // Every factor unavailable is not a real state (relevance and materiality are
  // always computable), but return 0 rather than dividing by zero.
  const mean = weightSum > 0 ? weighted / weightSum : 0;

  const contributions: Record<string, number> = {};
  for (const key of FACTOR_KEYS) {
    const value = f[key];
    if (value == null) continue;
    // Renormalised share, so the contributions genuinely reconcile to `score`.
    contributions[key] = (SCORE_WEIGHTS_V2[key]! * clamp01(value)) / weightSum;
  }
  if (penalty) contributions.duplicationPenalty = -penalty;

  return { score: clamp01(mean - penalty), contributions, unavailable };
}

/**
 * §4.8: replaces v1's `matched ? 0.8 : 0.3` boolean keyword proxy with a real
 * weighted match score. Sum of (weight × confidence) over the term matches,
 * normalised by 10 — the point at which a client is unambiguously implicated.
 * No matches at all still yields a small floor, because an alert only exists
 * because SOMETHING selected the bill.
 */
export function weightedRelevance(
  matchDetails: Array<{ weight?: number; confidence?: number }> | null | undefined,
  hasMatchedTags: boolean,
): number {
  const details = matchDetails ?? [];
  if (!details.length) return hasMatchedTags ? 0.5 : 0.3;
  const sum = details.reduce(
    (acc, d) => acc + (Number(d.weight) || 0) * (Number(d.confidence) || 0),
    0,
  );
  return clamp01(sum / 10);
}

/** The client's stance, folded into priority: a stated position is higher-stakes. */
export function positionMultiplier(position: string | null | undefined): number {
  const p = (position ?? '').toLowerCase();
  return p === 'oppose' || p === 'support' ? 1.0 : 0.85;
}

/**
 * §4.8 `evidenceConfidence` — filled / total over the SEVEN canonical Alert
 * fields (the same seven `buildAlert` is defined over).
 *
 * ONE definition, shared with `AlertPacketService.confidence.evidenceCoverage`
 * (Gate C phase f) rather than a second implementation that could drift. Order
 * matches that one exactly: whatChanged, whyItMatters, clientId, issueId,
 * whoActs, deadline, sourceType.
 */
export function evidenceCoverage(fields: {
  whatChanged?: string | null;
  whyItMatters?: string | null;
  clientId?: string | null;
  issueId?: string | null;
  whoActs?: string | null;
  deadline?: string | null;
  sourceType?: string | null;
}): number {
  const canonical = [
    fields.whatChanged,
    fields.whyItMatters,
    fields.clientId,
    fields.issueId,
    fields.whoActs,
    fields.deadline,
    fields.sourceType,
  ];
  const filled = canonical.filter((v) => v !== null && v !== undefined && v !== '').length;
  return clamp01(filled / canonical.length);
}

export function materialityFactor(materiality: string): number {
  return (MATERIALITY_RANK[(materiality as 'low' | 'medium' | 'high') ?? 'medium'] ?? 2) / 3;
}

/**
 * Recency of the action; overridden to 1.0 for the critical change types.
 *
 * P1-08 — this deliberately stays a LIST check and does NOT also key on
 * `severity`, which looks inconsistent with the score floor below but is not.
 * A named terminal move (enacted / vetoed / failed / dead-by-deadline) is urgent
 * on its own because the event IS the deadline. A merely critical-SEVERITY event
 * with no action date — a <3-day `state_bill_deadline_approaching`, say — has no
 * recency signal to report, and handing it urgency 1.0 for free would inflate the
 * composite rather than express urgency. The score floor in `scoreShadowAlert` is
 * the right lever for those, and it is severity-driven.
 */
export function urgencyFactor(actionDate: Date | null, changeType: string, nowMs: number = Date.now()): number {
  if (CRITICAL_CHANGE_TYPES.includes(changeType)) return 1.0;
  if (!actionDate) return 0.1;
  const days = (nowMs - actionDate.getTime()) / 86400000;
  return days <= 1 ? 1.0 : days <= 7 ? 0.7 : days <= 30 ? 0.4 : 0.1;
}

/**
 * Score one alert.
 *
 * §4.8 (Gate D d-1/d-2): now runs the v2 weights AND returns the factor
 * breakdown that used to be computed and thrown away. The return type is
 * ADDITIVE — every existing `const { score, band } = ...` destructure keeps
 * compiling.
 *
 * FORWARD-ONLY (§6.2): existing `intel_alert.score` rows are not recomputed, so
 * a Priority-ordered list mixes v1 and v2 scores. `SCORE_MODEL_VERSION` is
 * stored on the alert so that mixing is visible rather than silent.
 */
export function scoreShadowAlert(input: {
  severity: AlertSeverity;
  materiality: string;
  changeType: string;
  actionDate: Date | null;
  matchedTags: string[];
  clientPriority?: string;
  nowMs?: number;
  /** §4.4/§4.8: the per-term match records, for the weighted relevance factor.
   *  Absent → falls back to the presence of matchedTags. */
  matchDetails?: Array<{ weight?: number; confidence?: number }> | null;
  /** The client's stance on the matched topic: support | oppose | monitor. */
  position?: string | null;
  /** clamp01(filled / total) over the seven canonical alert fields. */
  evidenceConfidence?: number;
  /** Set by the caller when another alert exists for the same
   *  (clientId, sourceRef) within 24h. The scorer never queries. */
  duplicate?: boolean;
}): {
  score: number;
  band: 'High' | 'Med' | 'Low';
  factors: ScoreFactorsV2 & ScoreBreakdown;
} {
  const matched = (input.matchedTags?.length ?? 0) > 0;
  const factors: ScoreFactorsV2 = {
    relevance: weightedRelevance(input.matchDetails, matched),
    materiality: materialityFactor(input.materiality),
    urgency: urgencyFactor(input.actionDate, input.changeType, input.nowMs),
    clientPriority:
      (PRIORITY_FACTOR[input.clientPriority ?? 'med'] ?? 0.66) *
      positionMultiplier(input.position),
    // §6.6: not derivable in intel-api. `null`, never 0 — see the Factor doc.
    targetOpportunity: null,
    // A caller that cannot compute coverage passes nothing, and the factor is
    // excluded rather than scored as "no evidence at all".
    evidenceConfidence: input.evidenceConfidence ?? null,
    duplicationPenalty: input.duplicate ? DUPLICATION_PENALTY : 0,
  };

  const { score: composite, contributions, unavailable } = computeScoreV2(factors);
  let score = composite;

  // §7.1 S5, generalized (P1-08): a CRITICAL event always bands High. Severity is
  // the detector's own classification and covers every rail — federal, state, and
  // the dynamically-critical classes (a <3-day deadline) that no static list can
  // enumerate. The change-type list is a belt-and-braces second trigger for the
  // named terminal moves.
  let floored = false;
  if (
    (input.severity ?? '').toLowerCase() === 'critical' ||
    CRITICAL_CHANGE_TYPES.includes(input.changeType)
  ) {
    if (score < CRITICAL_SEVERITY_FLOOR) floored = true;
    score = Math.max(score, CRITICAL_SEVERITY_FLOOR);
  }

  return {
    score,
    band: bandOf(score),
    factors: { ...factors, weights: SCORE_WEIGHTS_V2, contributions, unavailable, floored },
  };
}
