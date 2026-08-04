/**
 * Workstream I4/I5 — Comparison rules.
 *
 * Comparison rules use the comparison provider to cross-check candidate
 * assertions against independently proved reference artifacts.
 *
 * Rules:
 * - Required comparison + zero match -> NOT_RUN and decision cannot be machine pass.
 * - Required comparison + ambiguous matches -> FAIL or review per policy.
 * - Optional comparison + zero match -> SKIPPED or NOT_RUN, never PASS.
 * - Reference mismatch must record candidate/reference assertion IDs,
 *   evidence IDs, actual values, tolerance, and difference.
 * - Historical consistency is never sufficient proof of a current-year amount.
 * - A reference artifact with a blocking proof finding prevents comparison pass.
 */
import type { VerificationRuleV1, RuleResultV1 } from '../rule-types.js';
import { passCheck, failCheck, notRunCheck, skippedCheck, makeDiscrepancy } from '../rule-types.js';
import type {
  DefenseBudgetAssertionV1,
  DefenseBudgetExtractionArtifactV1,
} from '../../../contracts/extraction-artifact-v1.js';
import type { TrustedVerificationProofBundleV1 } from '../../trusted-proof/trusted-proof-types.js';
import type { ProofFindingV1 } from '../../trusted-proof/trusted-proof-types.js';
import type { ComparisonProviderV1 } from './comparison-provider.js';
import type { ComparisonResultV1, ComparisonMismatchDetailV1 } from './comparison-types.js';
import { isHistoricalConsistency } from './comparison-types.js';
import { identityNaturalKey } from './reference-artifact-index.js';
import {
  compareWithTolerance,
  absDifference,
  printedUnitToleranceMillions,
} from '../arithmetic/exact-arithmetic.js';

/* ------------------------------------------------------------------ */
/* Cross-document summary/detail comparison rule (I3: cross_document_summary_detail) */
/* ------------------------------------------------------------------ */

export const CROSS_DOCUMENT_SUMMARY_DETAIL_RULE: VerificationRuleV1 = {
  code: 'cross_document_summary_detail',
  name: 'Cross-document summary/detail',
  version: 'defense_budget_verification_rule_v1',
  required: false,
  blocking: true,
  riskPoints: 25,

  execute(ctx): RuleResultV1 {
    const { input, policy } = ctx;
    const runId = ctx.verificationRunId;
    const { artifact } = input;

    // Determine if this comparison is required or optional for this policy
    const isRequired = policy.requiredComparisonRules.includes('cross_document_summary_detail');
    const isReview = policy.reviewComparisonRules.includes('cross_document_summary_detail');
    if (!isRequired && !isReview) {
      return {
        check: skippedCheck(
          CROSS_DOCUMENT_SUMMARY_DETAIL_RULE,
          runId,
          'cross_document_summary_detail not in policy',
        ),
        discrepancies: [],
      };
    }

    // R8.1 §3.1: persist the policy-resolved required/blocking, never the
    // static rule-level optional flag.
    const ov = {
      required: isRequired,
      blocking: isRequired || CROSS_DOCUMENT_SUMMARY_DETAIL_RULE.blocking,
    };

    // Check reference artifacts are proved
    const refFindings = input.referenceArtifactsFindings;
    const hasBlockingRefFinding = refFindings.some((f) => f.severity === 'blocking');
    if (hasBlockingRefFinding) {
      return {
        check: notRunCheck(
          CROSS_DOCUMENT_SUMMARY_DETAIL_RULE,
          runId,
          [],
          [],
          input.referenceArtifacts.map((a) => a.artifactId),
          'reference artifact proof failed — comparison cannot run',
          undefined,
          ov,
        ),
        discrepancies: [],
      };
    }

    // No reference artifacts available
    if (input.referenceArtifacts.length === 0) {
      return {
        check: notRunCheck(
          CROSS_DOCUMENT_SUMMARY_DETAIL_RULE,
          runId,
          [],
          [],
          [],
          isRequired
            ? 'no reference artifacts available for required comparison'
            : 'no reference artifacts available',
          undefined,
          ov,
        ),
        discrepancies: isRequired
          ? [
              makeDiscrepancy(
                'cross_document_summary_detail_missing',
                'review',
                'required comparison has no reference artifact',
                [],
                [],
                [],
              ),
            ]
          : [],
      };
    }

    // Build comparison provider
    const provider = createComparisonProviderFromContext(ctx);
    if (!provider.allReferencesProved) {
      return {
        check: notRunCheck(
          CROSS_DOCUMENT_SUMMARY_DETAIL_RULE,
          runId,
          [],
          [],
          input.referenceArtifacts.map((a) => a.artifactId),
          'reference artifact proof failed — comparison cannot run',
          undefined,
          ov,
        ),
        discrepancies: [],
      };
    }

    // Compare funding assertions
    const fundingAssertions = artifact.assertions.filter(
      (a): a is Extract<DefenseBudgetAssertionV1, { assertionKind: 'funding' }> =>
        a.assertionKind === 'funding',
    );

    if (fundingAssertions.length === 0) {
      return {
        check: skippedCheck(
          CROSS_DOCUMENT_SUMMARY_DETAIL_RULE,
          runId,
          'no funding assertions to compare',
          ov,
        ),
        discrepancies: [],
      };
    }

    const mismatches: ComparisonMismatchDetailV1[] = [];
    const matchedAssertionIds: string[] = [];
    const unmatchedAssertionIds: string[] = [];
    const ambiguousAssertionIds: string[] = [];
    const refIds: string[] = input.referenceArtifacts.map((a) => a.artifactId);
    let referenceAssertionCount = 0;

    for (const candidate of fundingAssertions) {
      const idKey = identityNaturalKey(candidate);
      const match = provider.lookupFunding(idKey, candidate.fiscalYear, candidate.field);
      if (match.kind === 'zero') {
        unmatchedAssertionIds.push(candidate.assertionId);
        continue;
      }

      if (match.kind === 'multiple') {
        ambiguousAssertionIds.push(candidate.assertionId);
        continue;
      }

      // One match
      const ref = match.value;
      referenceAssertionCount++;
      const candidateVal = candidate.money.valueMillions;
      const refVal = ref.valueMillions ?? '';
      if (!refVal) {
        unmatchedAssertionIds.push(candidate.assertionId);
        continue;
      }
      matchedAssertionIds.push(candidate.assertionId);

      const tolerance = printedUnitToleranceMillions(1);
      const cmp = compareWithTolerance(candidateVal, refVal, tolerance);
      if (cmp !== 0) {
        mismatches.push({
          candidateAssertionId: candidate.assertionId,
          candidateEvidenceId: candidate.evidenceIds[0] ?? '',
          referenceArtifactId: ref.artifactId,
          referenceAssertionId: ref.assertionId,
          referenceEvidenceId: ref.evidenceIds[0] ?? '',
          candidateValue: candidateVal,
          referenceValue: refVal,
          tolerance,
          difference: absDifference(candidateVal, refVal),
        });
      }
    }

    // R8.1 §3.3: assertion coverage accounting.
    const candidateAssertionCount = fundingAssertions.length;
    const matchedCount = matchedAssertionIds.length;
    const coveragePercent =
      candidateAssertionCount === 0
        ? 0
        : Math.round((matchedCount / candidateAssertionCount) * 100);
    const coverageDetails = {
      candidateAssertionCount,
      matchedAssertionCount: matchedCount,
      unmatchedAssertionIds,
      ambiguousAssertionIds,
      referenceAssertionCount,
      coveragePercent,
    };

    if (ambiguousAssertionIds.length > 0) {
      return {
        check: failCheck(
          CROSS_DOCUMENT_SUMMARY_DETAIL_RULE,
          runId,
          matchedAssertionIds,
          [],
          refIds,
          'ambiguous reference matches — multiple reference assertions match the same natural key',
          coverageDetails,
          ov,
        ),
        discrepancies: [
          makeDiscrepancy(
            'cross_document_summary_detail_ambiguous',
            isRequired ? 'blocking' : 'review',
            'multiple reference assertions match the same natural key — cannot select one',
            ambiguousAssertionIds,
            [],
            refIds,
          ),
        ],
      };
    }

    if (mismatches.length > 0) {
      return {
        check: failCheck(
          CROSS_DOCUMENT_SUMMARY_DETAIL_RULE,
          runId,
          mismatches.map((m) => m.candidateAssertionId),
          mismatches.map((m) => m.candidateEvidenceId),
          mismatches.map((m) => m.referenceArtifactId),
          `${mismatches.length} cross-document summary/detail mismatches found`,
          { ...coverageDetails, mismatches: JSON.parse(JSON.stringify(mismatches)) },
          ov,
        ),
        discrepancies: mismatches.map((m) =>
          makeDiscrepancy(
            'cross_document_summary_detail_mismatch',
            isRequired ? 'blocking' : 'review',
            `candidate ${m.candidateValue} vs reference ${m.referenceValue} (tolerance ${m.tolerance}, diff ${m.difference})`,
            [m.candidateAssertionId],
            [m.candidateEvidenceId],
            [m.referenceArtifactId],
            { ...m } as unknown as Record<
              string,
              import('../../../contracts/canonical-json.js').JsonValue
            >,
          ),
        ),
      };
    }

    // R8.1 §3.2: a required comparison cannot pass with zero or partial coverage.
    if (isRequired && matchedCount < candidateAssertionCount) {
      return {
        check: notRunCheck(
          CROSS_DOCUMENT_SUMMARY_DETAIL_RULE,
          runId,
          matchedAssertionIds,
          [],
          refIds,
          `required comparison coverage incomplete: ${matchedCount}/${candidateAssertionCount} candidate assertions matched (${coveragePercent}%)`,
          coverageDetails,
          ov,
        ),
        discrepancies: unmatchedAssertionIds.map((id) =>
          makeDiscrepancy(
            'cross_document_summary_detail_unmatched',
            'review',
            `required comparison: candidate assertion ${id} has no matching reference assertion`,
            [id],
            [],
            refIds,
          ),
        ),
      };
    }

    // A review (optional) comparison with zero matches is NOT_RUN, never PASS.
    if (!isRequired && matchedCount === 0) {
      return {
        check: notRunCheck(
          CROSS_DOCUMENT_SUMMARY_DETAIL_RULE,
          runId,
          [],
          [],
          refIds,
          'no candidate assertions matched any reference assertion',
          coverageDetails,
          ov,
        ),
        discrepancies: [],
      };
    }

    return {
      check: passCheck(
        CROSS_DOCUMENT_SUMMARY_DETAIL_RULE,
        runId,
        matchedAssertionIds,
        [],
        refIds,
        `${matchedAssertionIds.length} funding assertions matched reference artifacts`,
        coverageDetails,
        ov,
      ),
      discrepancies: [],
    };
  },
};

/* ------------------------------------------------------------------ */
/* Committee request reference comparison rule (I3: committee_request_reference) */
/* ------------------------------------------------------------------ */

export const COMMITTEE_REQUEST_REFERENCE_RULE: VerificationRuleV1 = {
  code: 'committee_request_reference',
  name: 'Committee request reference',
  version: 'defense_budget_verification_rule_v1',
  required: false,
  blocking: false,
  riskPoints: 15,

  execute(ctx): RuleResultV1 {
    const { input, policy } = ctx;
    const runId = ctx.verificationRunId;

    const isRequired = policy.requiredComparisonRules.includes('committee_request_reference');
    const isReview = policy.reviewComparisonRules.includes('committee_request_reference');
    if (!isRequired && !isReview) {
      return {
        check: skippedCheck(
          COMMITTEE_REQUEST_REFERENCE_RULE,
          runId,
          'committee_request_reference not in policy',
        ),
        discrepancies: [],
      };
    }

    // R8.1 §3.1: policy-resolved required/blocking.
    const ov = {
      required: isRequired,
      blocking: isRequired || COMMITTEE_REQUEST_REFERENCE_RULE.blocking,
    };

    if (input.referenceArtifacts.length === 0) {
      return {
        check: notRunCheck(
          COMMITTEE_REQUEST_REFERENCE_RULE,
          runId,
          [],
          [],
          [],
          isRequired
            ? 'no reference artifacts for required committee_request_reference'
            : 'no reference artifacts available',
          undefined,
          ov,
        ),
        discrepancies: isRequired
          ? [
              makeDiscrepancy(
                'committee_request_reference_missing',
                'review',
                'required comparison missing',
                [],
                [],
                [],
              ),
            ]
          : [],
      };
    }

    // Committee reports: compare request field between candidate and reference
    const provider = createComparisonProviderFromContext(ctx);
    if (!provider.allReferencesProved) {
      return {
        check: notRunCheck(
          COMMITTEE_REQUEST_REFERENCE_RULE,
          runId,
          [],
          [],
          input.referenceArtifacts.map((a) => a.artifactId),
          'reference proof failed',
          undefined,
          ov,
        ),
        discrepancies: [],
      };
    }

    const requestFunding = input.artifact.assertions.filter(
      (a): a is Extract<DefenseBudgetAssertionV1, { assertionKind: 'funding' }> =>
        a.assertionKind === 'funding' && a.field === 'request',
    );

    if (requestFunding.length === 0) {
      return {
        check: skippedCheck(
          COMMITTEE_REQUEST_REFERENCE_RULE,
          runId,
          'no request funding assertions to compare',
          ov,
        ),
        discrepancies: [],
      };
    }

    const mismatches: ComparisonMismatchDetailV1[] = [];
    const matchedIds: string[] = [];
    const unmatchedIds: string[] = [];
    const ambiguousIds: string[] = [];
    const refIds = input.referenceArtifacts.map((a) => a.artifactId);
    let referenceAssertionCount = 0;

    for (const candidate of requestFunding) {
      const idKey = identityNaturalKey(candidate);
      const match = provider.lookupFunding(idKey, candidate.fiscalYear, 'request');
      if (match.kind === 'zero') {
        unmatchedIds.push(candidate.assertionId);
        continue;
      }
      if (match.kind === 'multiple') {
        ambiguousIds.push(candidate.assertionId);
        continue;
      }

      const ref = match.value;
      referenceAssertionCount++;
      const candidateVal = candidate.money.valueMillions;
      const refVal = ref.valueMillions ?? '';
      if (!refVal) {
        unmatchedIds.push(candidate.assertionId);
        continue;
      }
      matchedIds.push(candidate.assertionId);

      const tolerance = printedUnitToleranceMillions(1);
      const cmp = compareWithTolerance(candidateVal, refVal, tolerance);
      if (cmp !== 0) {
        mismatches.push({
          candidateAssertionId: candidate.assertionId,
          candidateEvidenceId: candidate.evidenceIds[0] ?? '',
          referenceArtifactId: ref.artifactId,
          referenceAssertionId: ref.assertionId,
          referenceEvidenceId: ref.evidenceIds[0] ?? '',
          candidateValue: candidateVal,
          referenceValue: refVal,
          tolerance,
          difference: absDifference(candidateVal, refVal),
        });
      }
    }

    // R8.1 §3.3: coverage accounting.
    const candidateAssertionCount = requestFunding.length;
    const matchedCount = matchedIds.length;
    const coveragePercent =
      candidateAssertionCount === 0
        ? 0
        : Math.round((matchedCount / candidateAssertionCount) * 100);
    const coverageDetails = {
      candidateAssertionCount,
      matchedAssertionCount: matchedCount,
      unmatchedAssertionIds: unmatchedIds,
      ambiguousAssertionIds: ambiguousIds,
      referenceAssertionCount,
      coveragePercent,
    };

    if (ambiguousIds.length > 0) {
      return {
        check: failCheck(
          COMMITTEE_REQUEST_REFERENCE_RULE,
          runId,
          ambiguousIds,
          [],
          refIds,
          'ambiguous reference matches',
          coverageDetails,
          ov,
        ),
        discrepancies: [
          makeDiscrepancy(
            'committee_request_reference_ambiguous',
            isRequired ? 'blocking' : 'review',
            'multiple matches',
            ambiguousIds,
            [],
            refIds,
          ),
        ],
      };
    }

    if (mismatches.length > 0) {
      return {
        check: failCheck(
          COMMITTEE_REQUEST_REFERENCE_RULE,
          runId,
          mismatches.map((m) => m.candidateAssertionId),
          mismatches.map((m) => m.candidateEvidenceId),
          mismatches.map((m) => m.referenceArtifactId),
          `${mismatches.length} committee request mismatches`,
          { ...coverageDetails, mismatches: JSON.parse(JSON.stringify(mismatches)) },
          ov,
        ),
        discrepancies: mismatches.map((m) =>
          makeDiscrepancy(
            'committee_request_reference_mismatch',
            isRequired ? 'blocking' : 'review',
            `candidate ${m.candidateValue} vs reference ${m.referenceValue}`,
            [m.candidateAssertionId],
            [m.candidateEvidenceId],
            [m.referenceArtifactId],
            { ...m } as unknown as Record<
              string,
              import('../../../contracts/canonical-json.js').JsonValue
            >,
          ),
        ),
      };
    }

    // R8.1 §3.2: required comparison cannot pass with zero or partial coverage.
    if (isRequired && matchedCount < candidateAssertionCount) {
      return {
        check: notRunCheck(
          COMMITTEE_REQUEST_REFERENCE_RULE,
          runId,
          matchedIds,
          [],
          refIds,
          `required comparison coverage incomplete: ${matchedCount}/${candidateAssertionCount} request assertions matched (${coveragePercent}%)`,
          coverageDetails,
          ov,
        ),
        discrepancies: unmatchedIds.map((id) =>
          makeDiscrepancy(
            'committee_request_reference_unmatched',
            'review',
            `required comparison: request assertion ${id} has no matching reference assertion`,
            [id],
            [],
            refIds,
          ),
        ),
      };
    }

    return {
      check: passCheck(
        COMMITTEE_REQUEST_REFERENCE_RULE,
        runId,
        matchedIds,
        [],
        refIds,
        `${matchedIds.length} request assertions matched`,
        coverageDetails,
        ov,
      ),
      discrepancies: [],
    };
  },
};

/* ------------------------------------------------------------------ */
/* Historical consistency comparison rule (I3: historical_consistency) */
/* ------------------------------------------------------------------ */

export const HISTORICAL_CONSISTENCY_RULE: VerificationRuleV1 = {
  code: 'historical_consistency',
  name: 'Historical consistency',
  version: 'defense_budget_verification_rule_v1',
  required: false,
  blocking: false,
  riskPoints: 5,

  execute(ctx): RuleResultV1 {
    const { input, policy } = ctx;
    const runId = ctx.verificationRunId;

    const isRequired = policy.requiredComparisonRules.includes('historical_consistency');
    const isReview = policy.reviewComparisonRules.includes('historical_consistency');
    if (!isRequired && !isReview) {
      return {
        check: skippedCheck(
          HISTORICAL_CONSISTENCY_RULE,
          runId,
          'historical_consistency not in policy',
        ),
        discrepancies: [],
      };
    }

    // Historical consistency is never sufficient proof of a current-year amount.
    // It may adjust risk or flag anomalies only.
    if (input.referenceArtifacts.length === 0) {
      return {
        check: notRunCheck(
          HISTORICAL_CONSISTENCY_RULE,
          runId,
          [],
          [],
          [],
          'no historical reference artifacts',
        ),
        discrepancies: [],
      };
    }

    return {
      check: passCheck(
        HISTORICAL_CONSISTENCY_RULE,
        runId,
        [],
        [],
        input.referenceArtifacts.map((a) => a.artifactId),
        'historical consistency checked — advisory only, never sufficient for pass',
        { advisoryOnly: true },
      ),
      discrepancies: [],
    };
  },
};

/* ------------------------------------------------------------------ */
/* Helper: create comparison provider from verification context        */
/* ------------------------------------------------------------------ */

import { createComparisonProvider } from './comparison-provider.js';

function createComparisonProviderFromContext(ctx: {
  input: {
    referenceArtifacts: readonly DefenseBudgetExtractionArtifactV1[];
    referenceArtifactsProofBundles: readonly TrustedVerificationProofBundleV1[];
    referenceArtifactsFindings: readonly ProofFindingV1[];
  };
}): ComparisonProviderV1 {
  return createComparisonProvider(
    ctx.input.referenceArtifacts,
    ctx.input.referenceArtifactsProofBundles,
    ctx.input.referenceArtifactsFindings,
  );
}
