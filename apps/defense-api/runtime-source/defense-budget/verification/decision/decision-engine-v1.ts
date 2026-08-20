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

export interface DecisionEngineInputV1 {
  checks: readonly VerificationCheckV1[];
  discrepancies: readonly VerificationDiscrepancyV1[];
  proofFindings: readonly ProofFindingV1[];
  policy: VerificationPolicyV1;
  /** Exact assertion inventory from the verified artifact. */
  allAssertionIds?: readonly string[];
  hasManualParser: boolean;
  hasOcrParser: boolean;
  hasUncorroboratedCongressionalMoney: boolean;
  hasUncorroboratedEnacted: boolean;
}

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

export function computeDecisionV1(input: DecisionEngineInputV1): DecisionEngineResultV1 {
  const reviewDiscrepancyCount = input.discrepancies.filter(
    (discrepancy) => discrepancy.severity === 'review',
  ).length;
  const riskResult = computeRiskScoreV1({
    checks: input.checks,
    reviewDiscrepancyCount,
    policy: input.policy,
  });
  const finish = (decision: VerificationDecisionV1) =>
    finalizeResult(
      decision,
      riskResult.riskScore,
      input.checks,
      input.discrepancies,
      input.policy,
      input.allAssertionIds,
    );

  if (input.checks.some((check) => check.outcome === 'FAIL' && check.blocking)) {
    return finish('REJECT');
  }

  const blockingProofFindings = input.proofFindings.filter(
    (finding) => finding.severity === 'blocking',
  );
  if (blockingProofFindings.length > 0) {
    const onlyArchiveMissing = blockingProofFindings.every(
      (finding) =>
        finding.code === 'archive_version_missing' || finding.code === 'archive_sha_mismatch',
    );
    if (!(onlyArchiveMissing && !input.policy.requireImmutableArchive)) {
      return finish('REJECT');
    }
  }

  if (input.checks.some((check) => check.outcome === 'NOT_RUN' && check.required)) {
    return finish('REVIEW');
  }
  if (input.discrepancies.some((discrepancy) => discrepancy.severity === 'review')) {
    return finish('REVIEW');
  }
  if (input.hasManualParser && input.policy.manualAlwaysReview) {
    return finish('REVIEW');
  }
  if (input.hasOcrParser && input.policy.ocrMoneyAlwaysReview) {
    return finish('REVIEW');
  }
  if (
    input.hasUncorroboratedCongressionalMoney &&
    input.policy.congressionalMoneyAlwaysReviewWhenUncorroborated
  ) {
    return finish('REVIEW');
  }
  if (input.hasUncorroboratedEnacted && input.policy.enactedAlwaysReviewWhenUncorroborated) {
    return finish('REVIEW');
  }

  return finish('PASS');
}

function routeForReview(riskScore: number, policy: VerificationPolicyV1): VerificationRouteV1 {
  const { automaticPassMax, targetedReextractionMax, paidVerifierMax } = policy.riskThresholds;
  void automaticPassMax;
  if (riskScore <= targetedReextractionMax) return 'targeted_local_reextraction';
  if (riskScore <= paidVerifierMax) return 'paid_page_verifier';
  return 'human_review';
}

function finalizeResult(
  decision: VerificationDecisionV1,
  riskScore: number,
  checks: readonly VerificationCheckV1[],
  discrepancies: readonly VerificationDiscrepancyV1[],
  policy: VerificationPolicyV1,
  allAssertionIds: readonly string[] | undefined,
): DecisionEngineResultV1 {
  const status: VerificationCandidateStatusV1 =
    decision === 'PASS'
      ? 'VERIFICATION_PASSED'
      : decision === 'REVIEW'
        ? 'NEEDS_REVIEW'
        : 'REJECTED';

  return {
    decision,
    status,
    route:
      decision === 'PASS'
        ? 'none'
        : decision === 'REJECT'
          ? 'none'
          : routeForReview(riskScore, policy),
    riskScore,
    acceptedAssertionIds:
      decision === 'REJECT'
        ? []
        : collectAcceptedAssertionIds(checks, discrepancies, allAssertionIds).sort(),
    rejectedAssertionIds: collectRejectedAssertionIds(checks, discrepancies).sort(),
    blockingFailCount: checks.filter((check) => check.outcome === 'FAIL' && check.blocking).length,
    requiredNotRunCount: checks.filter((check) => check.outcome === 'NOT_RUN' && check.required)
      .length,
  };
}

/**
 * Start from the exact artifact assertion inventory, then subtract every
 * assertion named by a failed/not-run control or a review/blocking discrepancy.
 * Older isolated unit tests that do not provide the inventory fall back to the
 * union of assertion IDs reported by passing checks.
 */
function collectAcceptedAssertionIds(
  checks: readonly VerificationCheckV1[],
  discrepancies: readonly VerificationDiscrepancyV1[],
  allAssertionIds: readonly string[] | undefined,
): string[] {
  const eligible = new Set<string>(
    allAssertionIds ??
      checks.filter((check) => check.outcome === 'PASS').flatMap((check) => check.assertionIds),
  );

  for (const check of checks) {
    if (check.outcome === 'FAIL' || check.outcome === 'NOT_RUN') {
      for (const assertionId of check.assertionIds) eligible.delete(assertionId);
    }
  }
  for (const discrepancy of discrepancies) {
    if (discrepancy.severity === 'blocking' || discrepancy.severity === 'review') {
      for (const assertionId of discrepancy.assertionIds) eligible.delete(assertionId);
    }
  }
  return [...eligible];
}

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
  for (const discrepancy of discrepancies) {
    if (discrepancy.severity === 'blocking') {
      for (const id of discrepancy.assertionIds) ids.add(id);
    }
  }
  return [...ids];
}
