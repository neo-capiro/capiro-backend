/**
 * Phase 10B-15 Part C -- acceptance-eligibility preflight for governed R-1
 * REVIEW ingestion.
 *
 * The existing human-review mechanism (`BudgetReviewV1Service` /
 * `BudgetReviewDecisionV1`) is deliberately broad: it refuses `accept` only
 * on a non-waivable blocking FAIL, which the current real FY2024 R-1 has
 * none of (r1_specific, duplicate_detection, warning_policy,
 * identity_validation, numeric_validation all PASS; completeness /
 * money_evidence_policy / page_only_reconciliation / rdte_summary_detail
 * are NOT_RUN, never FAIL). That breadth is correct for the review
 * mechanism's own job -- "is there a broken proof?" -- but it is NOT, by
 * itself, sufficient reason to let a governed acceptance advance an outbox
 * row to ingestion-success. This module is the SEPARATE, narrower gate for
 * that specific question, evaluated in addition to (never instead of) the
 * review record's own eligibility.
 *
 * Two structurally different classes of non-PASS review reason exist in
 * the real FY2024 R-1 (Phase 10B-14 forensics):
 *   - RECONCILABLE evidence gaps -- money_evidence_policy,
 *     page_only_reconciliation, rdte_summary_detail. These require an
 *     independently-proved R-2 companion artifact; they must NEVER be
 *     waived merely because an operator clicked Accept. This policy
 *     requires all three to be literal PASS.
 *   - IRREDUCIBLE review -- completeness's 287 `review_omission`
 *     discrepancies, every one of which (Phase 10B-14 Part 2 forensics)
 *     traces to the identical real-document phenomenon: an R-1 row
 *     printing fewer than 4 trailing dollar figures, making column
 *     mapping genuinely undeterminable from the R-1's own text (never
 *     guessed, per the extractor's own design). These are real, permanent
 *     source limitations that cannot be resolved even with an R-2
 *     companion (rdte_summary_detail only cross-validates assertions that
 *     already exist; it never manufactures a new one for an omitted row).
 *     This first policy pack allows EXACTLY this one class through --
 *     never a generic "accept any REVIEW" bypass.
 *
 * Known limitation, disclosed rather than hidden: the artifact/discrepancy
 * contract has no first-class structured field for "which omission
 * subclass produced this review_omission discrepancy" -- completeness
 * (apps/api/src/defense-budget/verification/rules/completeness.rules.ts)
 * emits every review-severity omission under the identical generic code
 * `review_omission`, with the actual reason only in the free-text
 * description r1-artifact-builder-v1 composed from the extractor's own
 * omission message. This policy therefore recognizes the allowed
 * irreducible class by matching that description against the exact,
 * deterministic message shape the real R-1 text reconstructor emits for
 * an ambiguous-trailing-numeric-count omission (proven to cover 287/287
 * real cases with zero exceptions) -- any discrepancy whose description
 * does not match this exact shape is treated as UNKNOWN and fails closed.
 * A future PR should give completeness a structured omission-subclass
 * field so this stops being message-text matching; recorded here rather
 * than silently built around.
 */
import type { ReadCheckV1, ReadDiscrepancyV1 } from '../verification/persistence/verification-repository.js';

/** Checks that must be literal PASS for a governed R-1 acceptance, always. */
export const REQUIRED_PASS_CHECK_CODES_V1 = [
  'identity_validation',
  'numeric_validation',
  'r1_specific',
  'duplicate_detection',
  'warning_policy',
  'money_evidence_policy',
  'page_only_reconciliation',
] as const;

/**
 * Evaluated separately: rdte_summary_detail is only required to be PASS
 * when POLICY marks it required for this run (it is `required:false` by
 * static default -- see rdte-summary-detail.rules.ts -- but the resolved
 * policy for a real R-1 candidate document currently makes it required;
 * this function trusts the check's own persisted `required` flag rather
 * than re-deriving policy, since the check already carries the
 * policy-resolved value).
 */
const RDTE_SUMMARY_DETAIL_CODE = 'rdte_summary_detail';

/**
 * The one, first-policy-pack allowed irreducible-omission message shape.
 * Matches r1-text-row-reconstructor-v1's exact, deterministic ambiguous-
 * trailing-numeric-count omission text (both the plain "N trailing
 * numeric tokens" variant and the "4 tokens but Enacted != Total Enacted"
 * collapse-identity-violation variant), embedded by r1-artifact-builder-v1
 * into completeness's `review_omission` discrepancy description.
 */
const ALLOWED_IRREDUCIBLE_OMISSION_MESSAGE_RE =
  /\d+ trailing numeric tokens \(need 4 or 5 for a confident column mapping\) -- ambiguous, not guessed|but Enacted \([^)]*\) != Total Enacted \([^)]*\)/;

export const ALLOWED_IRREDUCIBLE_OMISSION_CLASS_V1 = 'ambiguous_trailing_numeric_count';

export interface ReviewAcceptanceEligibilityInputV1 {
  runDecision: string;
  checks: readonly ReadCheckV1[];
  discrepancies: readonly ReadDiscrepancyV1[];
}

export interface ReviewAcceptanceEligibilityResultV1 {
  eligible: boolean;
  /** Empty iff eligible. Every entry is an independent, reportable reason. */
  refusalReasons: string[];
  /** Diagnostic only -- discrepancies classified as the allowed irreducible class. */
  allowedIrreducibleDiscrepancyIds: string[];
  /** Diagnostic only -- discrepancies that failed closed as unrecognized. */
  unrecognizedDiscrepancyIds: string[];
}

export function evaluateR1ReviewAcceptanceEligibilityV1(
  input: ReviewAcceptanceEligibilityInputV1,
): ReviewAcceptanceEligibilityResultV1 {
  const refusalReasons: string[] = [];
  const allowedIrreducibleDiscrepancyIds: string[] = [];
  const unrecognizedDiscrepancyIds: string[] = [];

  if (input.runDecision !== 'REVIEW') {
    refusalReasons.push(
      `this policy only governs REVIEW-decision runs; run decision is "${input.runDecision}"`,
    );
  }

  const byCode = new Map(input.checks.map((c) => [c.code, c]));

  // Zero FAIL checks, of any code -- the review record's own eligibility
  // gate already enforces this for blocking FAILs, but a governed
  // acceptance requires it unconditionally, for every check.
  const failingChecks = input.checks.filter((c) => c.outcome === 'FAIL');
  if (failingChecks.length > 0) {
    refusalReasons.push(
      `${failingChecks.length} check(s) are FAIL, not PASS: ${failingChecks.map((c) => c.code).join(', ')}`,
    );
  }

  for (const code of REQUIRED_PASS_CHECK_CODES_V1) {
    const check = byCode.get(code);
    if (check == null) {
      refusalReasons.push(`required check "${code}" is missing from this run's checks`);
      continue;
    }
    if (check.outcome !== 'PASS') {
      refusalReasons.push(`required check "${code}" is ${check.outcome}, not PASS`);
    }
  }

  const summaryDetail = byCode.get(RDTE_SUMMARY_DETAIL_CODE);
  if (summaryDetail == null) {
    refusalReasons.push(`check "${RDTE_SUMMARY_DETAIL_CODE}" is missing from this run's checks`);
  } else if (summaryDetail.required && summaryDetail.outcome !== 'PASS') {
    refusalReasons.push(
      `check "${RDTE_SUMMARY_DETAIL_CODE}" is policy-required and ${summaryDetail.outcome}, not PASS`,
    );
  }

  // Every remaining review/blocking-severity discrepancy must belong to
  // the one allowed irreducible class. Fail closed on anything else,
  // including blocking-severity discrepancies (those should already have
  // produced a FAIL check above, but a discrepancy without a matching
  // FAIL check is exactly the kind of contract violation this must not
  // silently pass through).
  for (const d of input.discrepancies) {
    if (d.severity !== 'review' && d.severity !== 'blocking') continue;
    if (ALLOWED_IRREDUCIBLE_OMISSION_MESSAGE_RE.test(d.description)) {
      allowedIrreducibleDiscrepancyIds.push(d.discrepancyId);
      continue;
    }
    unrecognizedDiscrepancyIds.push(d.discrepancyId);
    refusalReasons.push(
      `discrepancy "${d.discrepancyId}" (code=${d.code}, severity=${d.severity}) does not match the allowed irreducible omission class "${ALLOWED_IRREDUCIBLE_OMISSION_CLASS_V1}" -- failing closed`,
    );
  }

  return {
    eligible: refusalReasons.length === 0,
    refusalReasons,
    allowedIrreducibleDiscrepancyIds,
    unrecognizedDiscrepancyIds,
  };
}
