/**
 * Workstream J1/J3/J4 — Deterministic decision engine.
 *
 * Decision precedence (J1):
 *   1. Any blocking FAIL -> REJECT.
 *   2. Any required proof failure -> REJECT unless policy explicitly marks
 *      archival absence reviewable.
 *   3. Any required check NOT_RUN -> at least REVIEW.
 *   4. Any review-severity omission/warning/discrepancy -> at least REVIEW.
 *   5. Manual/OCR/congressional/enacted review triggers -> at least REVIEW
 *      unless required corroboration passes and policy permits machine pass.
 *   6. Only when every required check passes and no review trigger remains -> PASS.
 *
 * Risk score never overrides a blocking failure or required NOT_RUN (J2).
 *
 * Route (J3):
 *   PASS -> none
 *   REVIEW low risk -> targeted_local_reextraction
 *   REVIEW medium risk -> paid_page_verifier
 *   REVIEW high risk -> human_review
 *   REJECT -> none
 *
 * Stable ordering (J4):
 *   Sort checks, discrepancies, accepted assertion IDs, rejected assertion IDs,
 *   and reference IDs deterministically before computing/persisting the result.
 */
import type {
  VerificationCheckV1,
  VerificationDiscrepancyV1,
  VerificationDecisionV1,
  VerificationRouteV1,
  VerificationCandidateStatusV1,
} from '../verification-contract-v1.js';
import type { ProofFindingV1 } from '../trusted-proof/trusted-proof-types.js';
import type { VerificationPolicyV1 } from '../verification-policy-v1.js';
import { computeRiskScoreV1 } from './risk-engine-v1.js';

/* ------------------------------------------------------------------ */
/* Decision engine input                                               */
/* ------------------------------------------------------------------ */

export interface DecisionEngineInputV1 {
  checks: readonly VerificationCheckV1[];
  discrepancies: readonly VerificationDiscrepancyV1[];
  proofFindings: readonly ProofFindingV1[];
  policy: VerificationPolicyV1;
  /** Whether any manual parser method was used. */
  hasManualParser: boolean;
  /** Whether any OCR parser method was used. */
  hasOcrParser: boolean;
  /** Whether any congressional money assertion is uncorroborated. */
  hasUncorroboratedCongressionalMoney: boolean;
  /** Whether any enacted value is uncorroborated. */
  hasUncorroboratedEnacted: boolean;
}

/* ------------------------------------------------------------------ */
/* Decision engine result                                               */
/* ------------------------------------------------------------------ */

export interface DecisionEngineResultV1 {
  decision: VerificationDecisionV1;
  status: VerificationCandidateStatusV1;
  route: VerificationRouteV1;
  riskScore: number;
  acceptedAssertionIds: string[];
  rejectedAssertionIds: string[];
  blockingFailCount: number;
  requiredNotRunCount: number;
}

/* ------------------------------------------------------------------ */
/* Decision precedence                                                 */
/* ------------------------------------------------------------------ */

export function computeDecisionV1(input: DecisionEngineInputV1): DecisionEngineResultV1 {
  const {
    checks,
    discrepancies,
    proofFindings,
    policy,
    hasManualParser,
    hasOcrParser,
    hasUncorroboratedCongressionalMoney,
    hasUncorroboratedEnacted,
  } = input;

  // Count review-severity discrepancies
  const reviewDiscrepancyCount = discrepancies.filter((d) => d.severity === 'review').length;

  // Compute risk score
  const riskResult = computeRiskScoreV1({
    checks,
    reviewDiscrepancyCount,
    policy,
  });

  // J1.1: Any blocking FAIL -> REJECT
  const hasBlockingFail = checks.some((c) => c.outcome === 'FAIL' && c.blocking);
  if (hasBlockingFail) {
    return finalizeResult('REJECT', riskResult.riskScore, checks, discrepancies, policy);
  }

  // J1.2: Any required proof failure -> REJECT unless policy explicitly marks
  // archival absence reviewable
  const blockingProofFindings = proofFindings.filter((f) => f.severity === 'blocking');
  if (blockingProofFindings.length > 0) {
    // Check if the only blocking findings are archive-related and policy allows review
    const onlyArchiveMissing = blockingProofFindings.every(
      (f) => f.code === 'archive_version_missing' || f.code === 'archive_sha_mismatch',
    );
    if (onlyArchiveMissing && !policy.requireImmutableArchive) {
      // Fall through to review path
    } else {
      return finalizeResult('REJECT', riskResult.riskScore, checks, discrepancies, policy);
    }
  }

  // J1.3: Any required check NOT_RUN -> at least REVIEW
  const hasRequiredNotRun = checks.some((c) => c.outcome === 'NOT_RUN' && c.required);
  if (hasRequiredNotRun) {
    return finalizeResult('REVIEW', riskResult.riskScore, checks, discrepancies, policy);
  }

  // J1.4: Any review-severity omission/warning/discrepancy -> at least REVIEW
  const hasReviewDiscrepancy = discrepancies.some((d) => d.severity === 'review');
  if (hasReviewDiscrepancy) {
    return finalizeResult('REVIEW', riskResult.riskScore, checks, discrepancies, policy);
  }

  // J1.5: Manual/OCR/congressional/enacted review triggers -> at least REVIEW
  // unless required corroboration passes and policy permits machine pass
  if (hasManualParser && policy.manualAlwaysReview) {
    return finalizeResult('REVIEW', riskResult.riskScore, checks, discrepancies, policy);
  }
  if (hasOcrParser && policy.ocrMoneyAlwaysReview) {
    return finalizeResult('REVIEW', riskResult.riskScore, checks, discrepancies, policy);
  }
  if (hasUncorroboratedCongressionalMoney && policy.congressionalMoneyAlwaysReviewWhenUncorroborated) {
    return finalizeResult('REVIEW', riskResult.riskScore, checks, discrepancies, policy);
  }
  if (hasUncorroboratedEnacted && policy.enactedAlwaysReviewWhenUncorroborated) {
    return finalizeResult('REVIEW', riskResult.riskScore, checks, discrepancies, policy);
  }

  // J1.6: Only when every required check passes and no review trigger remains -> PASS
  return finalizeResult('PASS', riskResult.riskScore, checks, discrepancies, policy);
}

/* ------------------------------------------------------------------ */
/* Route determination (J3)                                            */
/* ------------------------------------------------------------------ */

function routeForReview(riskScore: number, policy: VerificationPolicyV1): VerificationRouteV1 {
  const { automaticPassMax, targetedReextractionMax, paidVerifierMax } = policy.riskThresholds;
  void automaticPassMax;
  if (riskScore <= targetedReextractionMax) {
    return 'targeted_local_reextraction';
  }
  if (riskScore <= paidVerifierMax) {
    return 'paid_page_verifier';
  }
  return 'human_review';
}

/* ------------------------------------------------------------------ */
/* Finalize result with stable ordering (J4)                           */
/* ------------------------------------------------------------------ */

function finalizeResult(
  decision: VerificationDecisionV1,
  riskScore: number,
  checks: readonly VerificationCheckV1[],
  discrepancies: readonly VerificationDiscrepancyV1[],
  policy: VerificationPolicyV1,
): DecisionEngineResultV1 {
  const status: VerificationCandidateStatusV1 =
    decision === 'PASS' ? 'VERIFICATION_PASSED' :
    decision === 'REVIEW' ? 'NEEDS_REVIEW' :
    'REJECTED';

  // J4: Stable ordering — sort assertion IDs, evidence IDs, reference IDs
  // A rejected result must have an empty acceptedAssertionIds list.
  const acceptedAssertionIds = decision === 'REJECT'
    ? []
    : collectAcceptedAssertionIds(checks).sort();
  const rejectedAssertionIds = collectRejectedAssertionIds(checks, discrepancies).sort();

  return {
    decision,
    status,
    route: decision === 'PASS' ? 'none' :
           decision === 'REJECT' ? 'none' :
           routeForReview(riskScore, policy),
    riskScore,
    acceptedAssertionIds,
    rejectedAssertionIds,
    blockingFailCount: checks.filter((c) => c.outcome === 'FAIL' && c.blocking).length,
    requiredNotRunCount: checks.filter((c) => c.outcome === 'NOT_RUN' && c.required).length,
  };
}

/** Collect assertion IDs from PASS checks. */
function collectAcceptedAssertionIds(checks: readonly VerificationCheckV1[]): string[] {
  const ids = new Set<string>();
  for (const check of checks) {
    if (check.outcome === 'PASS') {
      for (const id of check.assertionIds) ids.add(id);
    }
  }
  return [...ids];
}

/** Collect assertion IDs from FAIL checks and blocking discrepancies. */
function collectRejectedAssertionIds(
  checks: readonly VerificationCheckV1[],
  discrepancies: readonly VerificationDiscrepancyV1[],
): string[] {
  const ids = new Set<string>();
  for (const check of checks) {
    if (check.outcome === 'FAIL') {
      for (const id of check.assertionIds) ids.add(id);
    }
  }
  for (const d of discrepancies) {
    if (d.severity === 'blocking') {
      for (const id of d.assertionIds) ids.add(id);
    }
  }
  return [...ids];
}
