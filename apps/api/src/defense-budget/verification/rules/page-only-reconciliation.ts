/**
 * R8.1 WS4 — page-only evidence reconciliation (post-rule step).
 *
 * The money-evidence rule cannot decide whether a page-only money assertion
 * clears, because that depends on comparison-rule outcomes that do not exist
 * until after comparison rules execute. This module performs the final
 * assertion-by-assertion reconciliation AFTER all rules have run.
 *
 * For each page-only money assertion:
 *   fully reconciled  -> acceptable (no finding)
 *   unmatched         -> review discrepancy (NEEDS_REVIEW)
 *   failed comparison -> blocking discrepancy (REJECT by policy)
 *   missing comparison-> review discrepancy (NEEDS_REVIEW)
 *
 * One passing comparison never clears an unrelated page-only assertion: the
 * assertion ID must appear in that comparison's matched assertion IDs.
 */
import type {
  VerificationCheckV1,
  VerificationDiscrepancyV1,
} from '../verification-contract-v1.js';
import { computeVerificationDiscrepancyId } from '../verification-contract-v1.js';
import type { ArtifactVerificationInputV1 } from '../verification-input-v1.js';
import type { VerificationPolicyV1 } from '../verification-policy-v1.js';

export interface PageOnlyReconciliationResult {
  /** Additional discrepancies produced by reconciliation. */
  discrepancies: VerificationDiscrepancyV1[];
  /** Assertion IDs that are fully corroborated page-only money assertions. */
  reconciledAssertionIds: string[];
  /** Assertion IDs that could not be reconciled. */
  unreconciledAssertionIds: string[];
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

/**
 * Reconcile page-only money assertions against executed comparison checks.
 *
 * @param input    the resolved verification input (artifact + references)
 * @param policy   the merged policy
 * @param checks   all checks produced by the rule engine (comparison checks
 *                 carry coverage detail in `details`)
 */
export function reconcilePageOnlyEvidence(
  input: ArtifactVerificationInputV1,
  policy: VerificationPolicyV1,
  checks: readonly VerificationCheckV1[],
): PageOnlyReconciliationResult {
  const discrepancies: VerificationDiscrepancyV1[] = [];
  const reconciledAssertionIds: string[] = [];
  const unreconciledAssertionIds: string[] = [];

  // If the policy does not permit page-only pass at all, the money-evidence
  // rule already emitted blocking discrepancies; nothing to reconcile here.
  if (!policy.pageOnlyMayPassWithIndependentReconciliation) {
    return { discrepancies, reconciledAssertionIds, unreconciledAssertionIds };
  }

  const artifact = input.artifact;
  const evidenceById = new Map(artifact.evidence.map((e) => [e.evidenceId, e]));
  const referenceArtifactIds = input.referenceArtifacts.map((a) => a.artifactId);

  // Gather the required + review comparison rule codes from policy.
  const comparisonRuleCodes = new Set([
    ...policy.requiredComparisonRules,
    ...policy.reviewComparisonRules,
  ]);

  // Index comparison checks by code for lookup.
  const comparisonChecks = checks.filter((c) => comparisonRuleCodes.has(c.code));

  // Reference proof independence: a blocking reference finding means the
  // reference is not independent.
  const referenceProofIndependent = !input.referenceArtifactsFindings.some(
    (f) => f.severity === 'blocking',
  );

  // Collect every page-only money assertion.
  const pageOnlyMoneyAssertions = artifact.assertions.filter((a) => {
    const isMoney = a.assertionKind === 'funding' || a.assertionKind === 'project_funding';
    if (!isMoney) return false;
    return a.evidenceIds.some((eid) => evidenceById.get(eid)?.granularity === 'page_only');
  });

  for (const assertion of pageOnlyMoneyAssertions) {
    // 1. Identify applicable required comparison rules (those in policy).
    // 2. Confirm those rules ran (a check exists for the code).
    // 3. Confirm each relevant check is PASS.
    // 4. Confirm the assertion ID appears in the comparison's matched IDs.
    // 5. Confirm the reference proof is independent.
    // 6. Confirm no review/blocking discrepancy already targets this assertion.

    if (!referenceProofIndependent) {
      unreconciledAssertionIds.push(assertion.assertionId);
      discrepancies.push(
        makeReconciliationDiscrepancy(
          'page_only_reference_proof_failed',
          'review',
          `page-only assertion "${assertion.assertionId}" cannot be reconciled: reference proof is not independent`,
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
          `page-only assertion "${assertion.assertionId}" has no applicable comparison check — missing comparison`,
          assertion.assertionId,
          assertion.evidenceIds,
          referenceArtifactIds,
        ),
      );
      continue;
    }

    // The assertion is reconciled if ANY applicable comparison check is PASS
    // and explicitly lists this assertion ID among its matched assertion IDs.
    const matchingCheck = comparisonChecks.find(
      (c) => c.outcome === 'PASS' && c.assertionIds.includes(assertion.assertionId),
    );

    if (matchingCheck) {
      reconciledAssertionIds.push(assertion.assertionId);
      continue;
    }

    // A failed (FAIL) comparison that covers this assertion -> blocking.
    const failedCheck = comparisonChecks.find(
      (c) => c.outcome === 'FAIL' && c.assertionIds.includes(assertion.assertionId),
    );
    if (failedCheck) {
      unreconciledAssertionIds.push(assertion.assertionId);
      discrepancies.push(
        makeReconciliationDiscrepancy(
          'page_only_comparison_failed',
          'blocking',
          `page-only assertion "${assertion.assertionId}" covered by failed comparison "${failedCheck.code}"`,
          assertion.assertionId,
          assertion.evidenceIds,
          referenceArtifactIds,
        ),
      );
      continue;
    }

    // Otherwise: no comparison matched this exact assertion -> unmatched.
    unreconciledAssertionIds.push(assertion.assertionId);
    discrepancies.push(
      makeReconciliationDiscrepancy(
        'page_only_assertion_unmatched',
        'review',
        `page-only assertion "${assertion.assertionId}" is not corroborated by any independent reference (unmatched)`,
        assertion.assertionId,
        assertion.evidenceIds,
        referenceArtifactIds,
      ),
    );
  }

  return { discrepancies, reconciledAssertionIds, unreconciledAssertionIds };
}
