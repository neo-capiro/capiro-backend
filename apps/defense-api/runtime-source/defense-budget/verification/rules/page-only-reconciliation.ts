/**
 * R8.3 — page-only evidence reconciliation (post-rule step).
 *
 * The money-evidence rule executes before comparison rules, so it cannot know
 * whether page-only monetary assertions are independently corroborated. This
 * module runs after all comparison rules and emits a real verification check:
 *
 *   no page-only money assertions -> SKIPPED
 *   every page-only assertion independently corroborated -> PASS
 *   one or more assertions unmatched / unavailable -> NOT_RUN (required)
 *   a covering comparison failed -> FAIL (blocking)
 *
 * A passing comparison clears only the exact assertion IDs it reports.
 */
import type {
  VerificationCheckV1,
  VerificationDiscrepancyV1,
} from '../verification-contract-v1.js';
import {
  computeVerificationCheckId,
  computeVerificationDiscrepancyId,
} from '../verification-contract-v1.js';
import type { ArtifactVerificationInputV1 } from '../verification-input-v1.js';
import type { VerificationPolicyV1 } from '../verification-policy-v1.js';

const PAGE_ONLY_RECONCILIATION_CODE = 'page_only_reconciliation';
const PAGE_ONLY_RECONCILIATION_RULE_VERSION = 'defense_budget_verification_rule_v1';

export interface PageOnlyReconciliationResult {
  check: VerificationCheckV1;
  discrepancies: VerificationDiscrepancyV1[];
  reconciledAssertionIds: string[];
  unreconciledAssertionIds: string[];
  pageOnlyAssertionIds: string[];
}

function makeReconciliationDiscrepancy(
  code: string,
  severity: 'blocking' | 'review',
  description: string,
  assertionId: string,
  evidenceIds: readonly string[],
  referenceArtifactIds: readonly string[],
  details?: Record<string, import('../../contracts/canonical-json.js').JsonValue>,
): VerificationDiscrepancyV1 {
  return {
    discrepancyId: computeVerificationDiscrepancyId({
      code,
      assertionIds: [assertionId],
      evidenceIds,
      referenceArtifactIds,
    }),
    code,
    severity,
    description,
    assertionIds: [assertionId],
    evidenceIds: [...evidenceIds],
    referenceArtifactIds: [...referenceArtifactIds],
    details,
  };
}

function makeReconciliationCheck(input: {
  verificationRunId: string;
  outcome: VerificationCheckV1['outcome'];
  required: boolean;
  blocking: boolean;
  riskPoints: number;
  message: string;
  assertionIds: readonly string[];
  evidenceIds: readonly string[];
  referenceArtifactIds: readonly string[];
  details: Record<string, import('../../contracts/canonical-json.js').JsonValue>;
}): VerificationCheckV1 {
  return {
    checkId: computeVerificationCheckId({
      verificationRunId: input.verificationRunId,
      code: PAGE_ONLY_RECONCILIATION_CODE,
      assertionIds: input.assertionIds,
      evidenceIds: input.evidenceIds,
      referenceArtifactIds: input.referenceArtifactIds,
    }),
    code: PAGE_ONLY_RECONCILIATION_CODE,
    ruleVersion: PAGE_ONLY_RECONCILIATION_RULE_VERSION,
    outcome: input.outcome,
    required: input.required,
    blocking: input.blocking,
    riskPoints: input.riskPoints,
    message: input.message,
    assertionIds: [...input.assertionIds],
    evidenceIds: [...input.evidenceIds],
    referenceArtifactIds: [...input.referenceArtifactIds],
    details: input.details,
  };
}

/**
 * Reconcile page-only money assertions against executed comparison checks.
 */
export function reconcilePageOnlyEvidence(
  input: ArtifactVerificationInputV1,
  policy: VerificationPolicyV1,
  checks: readonly VerificationCheckV1[],
  verificationRunId: string,
): PageOnlyReconciliationResult {
  const discrepancies: VerificationDiscrepancyV1[] = [];
  const reconciledAssertionIds: string[] = [];
  const unreconciledAssertionIds: string[] = [];
  const artifact = input.artifact;
  const evidenceById = new Map(artifact.evidence.map((e) => [e.evidenceId, e]));
  const referenceArtifactIds = input.referenceArtifacts.map((a) => a.artifactId).sort();

  const pageOnlyMoneyAssertions = artifact.assertions.filter((assertion) => {
    const isMoney =
      assertion.assertionKind === 'funding' || assertion.assertionKind === 'project_funding';
    if (!isMoney) return false;
    return assertion.evidenceIds.some(
      (evidenceId) => evidenceById.get(evidenceId)?.granularity === 'page_only',
    );
  });
  const pageOnlyAssertionIds = pageOnlyMoneyAssertions
    .map((assertion) => assertion.assertionId)
    .sort();
  const pageOnlyEvidenceIds = pageOnlyMoneyAssertions
    .flatMap((assertion) => assertion.evidenceIds)
    .filter((evidenceId) => evidenceById.get(evidenceId)?.granularity === 'page_only')
    .sort();

  if (pageOnlyMoneyAssertions.length === 0) {
    return {
      check: makeReconciliationCheck({
        verificationRunId,
        outcome: 'SKIPPED',
        required: false,
        blocking: false,
        riskPoints: 0,
        message: 'no page-only monetary assertions require reconciliation',
        assertionIds: [],
        evidenceIds: [],
        referenceArtifactIds: [],
        details: {
          pageOnlyAssertionCount: 0,
          reconciledAssertionCount: 0,
          unreconciledAssertionCount: 0,
        },
      }),
      discrepancies,
      reconciledAssertionIds,
      unreconciledAssertionIds,
      pageOnlyAssertionIds,
    };
  }

  if (!policy.pageOnlyMayPassWithIndependentReconciliation) {
    return {
      check: makeReconciliationCheck({
        verificationRunId,
        outcome: 'SKIPPED',
        required: false,
        blocking: false,
        riskPoints: 0,
        message: 'policy does not permit page-only reconciliation; money evidence rule governs',
        assertionIds: pageOnlyAssertionIds,
        evidenceIds: pageOnlyEvidenceIds,
        referenceArtifactIds,
        details: {
          pageOnlyAssertionCount: pageOnlyAssertionIds.length,
          reconciledAssertionCount: 0,
          unreconciledAssertionCount: pageOnlyAssertionIds.length,
        },
      }),
      discrepancies,
      reconciledAssertionIds,
      unreconciledAssertionIds: [...pageOnlyAssertionIds],
      pageOnlyAssertionIds,
    };
  }

  const comparisonRuleCodes = new Set([
    ...policy.requiredComparisonRules,
    ...policy.reviewComparisonRules,
  ]);
  const comparisonChecks = checks.filter((check) => comparisonRuleCodes.has(check.code));
  const referenceProofIndependent =
    referenceArtifactIds.length > 0 &&
    !input.referenceArtifactsFindings.some((finding) => finding.severity === 'blocking');

  for (const assertion of pageOnlyMoneyAssertions) {
    if (!referenceProofIndependent) {
      unreconciledAssertionIds.push(assertion.assertionId);
      discrepancies.push(
        makeReconciliationDiscrepancy(
          'page_only_reference_proof_failed',
          'review',
          `page-only assertion "${assertion.assertionId}" cannot be reconciled: no independently proved reference is available`,
          assertion.assertionId,
          assertion.evidenceIds,
          referenceArtifactIds,
        ),
      );
      continue;
    }

    if (comparisonChecks.length === 0) {
      unreconciledAssertionIds.push(assertion.assertionId);
      discrepancies.push(
        makeReconciliationDiscrepancy(
          'page_only_comparison_missing',
          'review',
          `page-only assertion "${assertion.assertionId}" has no applicable comparison check`,
          assertion.assertionId,
          assertion.evidenceIds,
          referenceArtifactIds,
        ),
      );
      continue;
    }

    const failedCheck = comparisonChecks.find(
      (check) =>
        check.outcome === 'FAIL' && check.assertionIds.includes(assertion.assertionId),
    );
    if (failedCheck) {
      unreconciledAssertionIds.push(assertion.assertionId);
      discrepancies.push(
        makeReconciliationDiscrepancy(
          'page_only_comparison_failed',
          'blocking',
          `page-only assertion "${assertion.assertionId}" is covered by failed comparison "${failedCheck.code}"`,
          assertion.assertionId,
          assertion.evidenceIds,
          referenceArtifactIds,
        ),
      );
      continue;
    }

    const passingCheck = comparisonChecks.find(
      (check) =>
        check.outcome === 'PASS' && check.assertionIds.includes(assertion.assertionId),
    );
    if (passingCheck) {
      reconciledAssertionIds.push(assertion.assertionId);
      continue;
    }

    unreconciledAssertionIds.push(assertion.assertionId);
    discrepancies.push(
      makeReconciliationDiscrepancy(
        'page_only_assertion_unmatched',
        'review',
        `page-only assertion "${assertion.assertionId}" is not corroborated by an independent reference`,
        assertion.assertionId,
        assertion.evidenceIds,
        referenceArtifactIds,
      ),
    );
  }

  reconciledAssertionIds.sort();
  unreconciledAssertionIds.sort();
  const hasBlocking = discrepancies.some((discrepancy) => discrepancy.severity === 'blocking');
  const outcome: VerificationCheckV1['outcome'] = hasBlocking
    ? 'FAIL'
    : unreconciledAssertionIds.length > 0
      ? 'NOT_RUN'
      : 'PASS';

  return {
    check: makeReconciliationCheck({
      verificationRunId,
      outcome,
      required: true,
      blocking: true,
      riskPoints: outcome === 'PASS' ? 0 : outcome === 'FAIL' ? 50 : 35,
      message:
        outcome === 'PASS'
          ? `${reconciledAssertionIds.length} page-only monetary assertions independently corroborated`
          : outcome === 'FAIL'
            ? 'page-only monetary reconciliation failed'
            : `${unreconciledAssertionIds.length} page-only monetary assertions remain unreconciled`,
      assertionIds: pageOnlyAssertionIds,
      evidenceIds: pageOnlyEvidenceIds,
      referenceArtifactIds,
      details: {
        pageOnlyAssertionCount: pageOnlyAssertionIds.length,
        reconciledAssertionCount: reconciledAssertionIds.length,
        unreconciledAssertionCount: unreconciledAssertionIds.length,
        reconciledAssertionIds,
        unreconciledAssertionIds,
      },
    }),
    discrepancies,
    reconciledAssertionIds,
    unreconciledAssertionIds,
    pageOnlyAssertionIds,
  };
}
