/**
 * Bidirectional R-1 ↔ R-2 summary/detail arithmetic rule.
 *
 * R-1 and R-2 policies both require this comparison. The candidate may be
 * either exhibit and must be compared against independently proved artifacts
 * from the opposite exhibit. Required comparisons demand complete candidate
 * funding coverage. PASS checks carry every matched candidate assertion ID so
 * page-only reconciliation can clear only exact corroborated assertions.
 */
import type { VerificationRuleV1, RuleResultV1 } from '../rule-types.js';
import { passCheck, failCheck, notRunCheck, skippedCheck, makeDiscrepancy } from '../rule-types.js';
import {
  compareWithTolerance,
  printedUnitToleranceMillions,
  absDifference,
} from './exact-arithmetic.js';
import type { DefenseBudgetAssertionV1 } from '../../../contracts/extraction-artifact-v1.js';

export const RDTE_SUMMARY_DETAIL_RULE: VerificationRuleV1 = {
  code: 'rdte_summary_detail',
  name: 'R-1 ↔ R-2 Summary/Detail',
  version: 'defense_budget_verification_rule_v1',
  required: false,
  blocking: true,
  riskPoints: 30,

  execute(ctx): RuleResultV1 {
    const { input, policy } = ctx;
    const runId = ctx.verificationRunId;
    const { artifact, referenceArtifacts } = input;
    const isRequired = policy.requiredComparisonRules.includes('rdte_summary_detail');
    const overrides = {
      required: isRequired,
      blocking: isRequired || RDTE_SUMMARY_DETAIL_RULE.blocking,
    };

    if (!policy.arithmeticRules.includes('rdte_summary_detail')) {
      return {
        check: skippedCheck(
          RDTE_SUMMARY_DETAIL_RULE,
          runId,
          'rdte_summary_detail not in policy.arithmeticRules',
          overrides,
        ),
        discrepancies: [],
      };
    }

    const candidateExhibit = artifact.source.exhibit;
    if (candidateExhibit !== 'R-1' && candidateExhibit !== 'R-2') {
      return {
        check: skippedCheck(
          RDTE_SUMMARY_DETAIL_RULE,
          runId,
          'candidate is neither R-1 nor R-2',
          overrides,
        ),
        discrepancies: [],
      };
    }

    const requiredReferenceExhibit = candidateExhibit === 'R-1' ? 'R-2' : 'R-1';
    const oppositeReferences = referenceArtifacts.filter(
      (reference) => reference.source.exhibit === requiredReferenceExhibit,
    );
    if (oppositeReferences.length === 0) {
      return {
        check: notRunCheck(
          RDTE_SUMMARY_DETAIL_RULE,
          runId,
          [],
          [],
          [],
          `no independently proved ${requiredReferenceExhibit} reference artifact available`,
          {
            candidateExhibit,
            requiredReferenceExhibit,
          },
          overrides,
        ),
        discrepancies: [],
      };
    }

    const candidateFunding = artifact.assertions.filter(
      (assertion): assertion is Extract<
        DefenseBudgetAssertionV1,
        { assertionKind: 'funding' }
      > => assertion.assertionKind === 'funding',
    );
    const referenceFunding = oppositeReferences.flatMap((reference) =>
      reference.assertions
        .filter(
          (assertion): assertion is Extract<
            DefenseBudgetAssertionV1,
            { assertionKind: 'funding' }
          > => assertion.assertionKind === 'funding',
        )
        .map((assertion) => ({ assertion, artifactId: reference.artifactId })),
    );
    const referenceArtifactIds = oppositeReferences
      .map((reference) => reference.artifactId)
      .sort();
    const matchedAssertionIds: string[] = [];
    const matchedEvidenceIds: string[] = [];
    const unmatchedAssertionIds: string[] = [];
    const ambiguousAssertionIds: string[] = [];
    const mismatchAssertionIds: string[] = [];
    const discrepancies: ReturnType<typeof makeDiscrepancy>[] = [];

    for (const candidate of candidateFunding) {
      const key = JSON.stringify({
        identity: candidate.identity,
        fiscalYear: candidate.fiscalYear,
        field: candidate.field,
      });
      const matches = referenceFunding.filter(
        ({ assertion }) =>
          JSON.stringify({
            identity: assertion.identity,
            fiscalYear: assertion.fiscalYear,
            field: assertion.field,
          }) === key,
      );

      if (matches.length === 0) {
        unmatchedAssertionIds.push(candidate.assertionId);
        continue;
      }
      if (matches.length > 1) {
        ambiguousAssertionIds.push(candidate.assertionId);
        continue;
      }

      const match = matches[0]!;
      matchedAssertionIds.push(candidate.assertionId);
      matchedEvidenceIds.push(...candidate.evidenceIds);
      const candidateValue = candidate.money.valueMillions;
      const referenceValue = match.assertion.money.valueMillions;
      const tolerance = printedUnitToleranceMillions(1);
      if (compareWithTolerance(candidateValue, referenceValue, tolerance) !== 0) {
        mismatchAssertionIds.push(candidate.assertionId);
        const difference = absDifference(candidateValue, referenceValue);
        discrepancies.push(
          makeDiscrepancy(
            'rdte_summary_detail_mismatch',
            'blocking',
            `${candidateExhibit}/${requiredReferenceExhibit} mismatch for ` +
              `${candidate.assertionId}: candidate=${candidateValue}M ` +
              `reference=${referenceValue}M tolerance=${tolerance}M ` +
              `difference=${difference}M`,
            [candidate.assertionId, match.assertion.assertionId],
            [...candidate.evidenceIds, ...match.assertion.evidenceIds],
            [match.artifactId],
          ),
        );
      }
    }

    const candidateAssertionCount = candidateFunding.length;
    const matchedAssertionCount = matchedAssertionIds.length;
    const coveragePercent =
      candidateAssertionCount === 0
        ? 0
        : Math.round((matchedAssertionCount / candidateAssertionCount) * 100);
    const details = {
      candidateExhibit,
      requiredReferenceExhibit,
      candidateAssertionCount,
      matchedAssertionCount,
      unmatchedAssertionIds,
      ambiguousAssertionIds,
      mismatchAssertionIds,
      referenceAssertionCount: referenceFunding.length,
      coveragePercent,
    };

    if (ambiguousAssertionIds.length > 0) {
      return {
        check: failCheck(
          RDTE_SUMMARY_DETAIL_RULE,
          runId,
          ambiguousAssertionIds,
          [],
          referenceArtifactIds,
          `multiple ${requiredReferenceExhibit} assertions match one or more ` +
            `${candidateExhibit} assertions`,
          details,
          overrides,
        ),
        discrepancies: [
          ...discrepancies,
          ...ambiguousAssertionIds.map((assertionId) =>
            makeDiscrepancy(
              'rdte_summary_detail_ambiguous',
              'blocking',
              `multiple ${requiredReferenceExhibit} assertions match candidate assertion ${assertionId}`,
              [assertionId],
              [],
              referenceArtifactIds,
            ),
          ),
        ],
      };
    }

    if (mismatchAssertionIds.length > 0) {
      return {
        check: failCheck(
          RDTE_SUMMARY_DETAIL_RULE,
          runId,
          mismatchAssertionIds,
          matchedEvidenceIds,
          referenceArtifactIds,
          `${mismatchAssertionIds.length} R-1/R-2 value mismatches found`,
          details,
          overrides,
        ),
        discrepancies,
      };
    }

    if (candidateAssertionCount === 0 || matchedAssertionCount === 0) {
      return {
        check: notRunCheck(
          RDTE_SUMMARY_DETAIL_RULE,
          runId,
          [],
          [],
          referenceArtifactIds,
          'no matching R-1/R-2 assertion pairs found',
          details,
          overrides,
        ),
        discrepancies: [],
      };
    }

    if (isRequired && unmatchedAssertionIds.length > 0) {
      return {
        check: notRunCheck(
          RDTE_SUMMARY_DETAIL_RULE,
          runId,
          matchedAssertionIds,
          matchedEvidenceIds,
          referenceArtifactIds,
          `required R-1/R-2 coverage incomplete: ` +
            `${matchedAssertionCount}/${candidateAssertionCount} assertions matched`,
          details,
          overrides,
        ),
        discrepancies: unmatchedAssertionIds.map((assertionId) =>
          makeDiscrepancy(
            'rdte_summary_detail_unmatched',
            'review',
            `required comparison has no ${requiredReferenceExhibit} match for ` +
              `candidate assertion ${assertionId}`,
            [assertionId],
            [],
            referenceArtifactIds,
          ),
        ),
      };
    }

    return {
      check: passCheck(
        RDTE_SUMMARY_DETAIL_RULE,
        runId,
        matchedAssertionIds,
        [...new Set(matchedEvidenceIds)],
        referenceArtifactIds,
        `${matchedAssertionCount} R-1/R-2 assertion pairs match within tolerance`,
        details,
        overrides,
      ),
      discrepancies: [],
    };
  },
};
