/**
 * Workstream J2 — Deterministic risk score engine.
 *
 * - deterministic;
 * - bounded 0..100;
 * - sums only applicable policy points;
 * - SKIPPED contributes zero;
 * - NOT_RUN contributes policy-defined uncertainty points;
 * - blocking failure may set score to 100 but decision precedence remains explicit.
 */
import type { VerificationCheckV1 } from '../verification-contract-v1.js';
import type { VerificationPolicyV1 } from '../verification-policy-v1.js';

/** Default uncertainty risk points for a NOT_RUN check. */
const DEFAULT_NOT_RUN_RISK_POINTS = 10;

/** Default risk points for a review-severity discrepancy. */
const DEFAULT_REVIEW_DISCREPANCY_POINTS = 5;

/** Maximum risk score. */
const MAX_RISK_SCORE = 100;

export interface RiskEngineInputV1 {
  checks: readonly VerificationCheckV1[];
  reviewDiscrepancyCount: number;
  policy: VerificationPolicyV1;
}

export interface RiskEngineResultV1 {
  riskScore: number;
  blockingFailCount: number;
  requiredNotRunCount: number;
  reviewDiscrepancyCount: number;
}

/**
 * Compute a deterministic risk score.
 *
 * Rules:
 * - Each blocking FAIL contributes its own riskPoints (capped at 100).
 * - Each required NOT_RUN contributes DEFAULT_NOT_RUN_RISK_POINTS (capped at 100).
 * - Each review-severity discrepancy contributes DEFAULT_REVIEW_DISCREPANCY_POINTS.
 * - SKIPPED contributes zero.
 * - A blocking failure may set score to 100, but the decision engine's
 *   explicit precedence still determines the final decision.
 */
export function computeRiskScoreV1(input: RiskEngineInputV1): RiskEngineResultV1 {
  const { checks, reviewDiscrepancyCount, policy } = input;
  void policy; // policy may define custom risk weights in future; currently deterministic

  let score = 0;
  let blockingFailCount = 0;
  let requiredNotRunCount = 0;

  for (const check of checks) {
    if (check.outcome === 'FAIL' && check.blocking) {
      score += check.riskPoints;
      blockingFailCount++;
    } else if (check.outcome === 'FAIL') {
      score += check.riskPoints;
    } else if (check.outcome === 'NOT_RUN' && check.required) {
      score += DEFAULT_NOT_RUN_RISK_POINTS;
      requiredNotRunCount++;
    } else if (check.outcome === 'NOT_RUN') {
      score += Math.min(check.riskPoints, DEFAULT_NOT_RUN_RISK_POINTS);
    }
    // SKIPPED and PASS contribute zero
  }

  score += reviewDiscrepancyCount * DEFAULT_REVIEW_DISCREPANCY_POINTS;

  // A blocking failure may set score to 100
  if (blockingFailCount > 0) {
    score = Math.max(score, MAX_RISK_SCORE);
  }

  const riskScore = Math.min(score, MAX_RISK_SCORE);

  return {
    riskScore,
    blockingFailCount,
    requiredNotRunCount,
    reviewDiscrepancyCount,
  };
}
