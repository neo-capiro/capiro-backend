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

export const CRITICAL_CHANGE_TYPES = ['bill_enacted', 'bill_to_president', 'bill_failed'];
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

export function materialityFactor(materiality: string): number {
  return (MATERIALITY_RANK[(materiality as 'low' | 'medium' | 'high') ?? 'medium'] ?? 2) / 3;
}

/** Recency of the action; overridden to 1.0 for the critical change types. */
export function urgencyFactor(actionDate: Date | null, changeType: string, nowMs: number = Date.now()): number {
  if (CRITICAL_CHANGE_TYPES.includes(changeType)) return 1.0;
  if (!actionDate) return 0.1;
  const days = (nowMs - actionDate.getTime()) / 86400000;
  return days <= 1 ? 1.0 : days <= 7 ? 0.7 : days <= 30 ? 0.4 : 0.1;
}

export function scoreShadowAlert(input: {
  severity: AlertSeverity;
  materiality: string;
  changeType: string;
  actionDate: Date | null;
  matchedTags: string[];
  clientPriority?: string;
  nowMs?: number;
}): { score: number; band: 'High' | 'Med' | 'Low' } {
  const matched = (input.matchedTags?.length ?? 0) > 0;
  let score = computeScore({
    relevance: matched ? 0.8 : 0.3, // keyword-match proxy until §6.1 semantic fit
    materiality: materialityFactor(input.materiality),
    urgency: urgencyFactor(input.actionDate, input.changeType, input.nowMs),
    political: 0, // bill path has no speaker signal (reserved for hearing F2)
    clientPriority: PRIORITY_FACTOR[input.clientPriority ?? 'med'] ?? 0.66,
    legCoverage: matched ? 0.5 : 0.25, // keyword(+entity) fired; no semantic leg in shadow
  });
  // §7.1 S5: critical moves always band High regardless of the proxy relevance.
  if (CRITICAL_CHANGE_TYPES.includes(input.changeType)) score = Math.max(score, 0.66);
  return { score, band: bandOf(score) };
}
