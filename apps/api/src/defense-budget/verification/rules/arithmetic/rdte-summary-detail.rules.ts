/**
 * Workstream H3 — R-1 ↔ R-2 summary/detail arithmetic rule.
 *
 * When an R-1 and R-2 reference artifact are available:
 * - compare same PE + FY + request field
 * - require identity and fiscal-year match
 * - use exact tolerance
 * - preserve both source artifact IDs and evidence IDs
 */
import type { VerificationRuleV1, RuleResultV1 } from '../rule-types.js';
import { passCheck, failCheck, notRunCheck, makeDiscrepancy } from '../rule-types.js';
import {
  sumDecimals,
  compareWithTolerance,
  printedUnitToleranceMillions,
  absDifference,
} from './exact-arithmetic.js';
import type {
  DefenseBudgetExtractionArtifactV1,
  DefenseBudgetAssertionV1,
} from '../../../contracts/extraction-artifact-v1.js';

export const RDTE_SUMMARY_DETAIL_RULE: VerificationRuleV1 = {
  code: 'rdte_summary_detail',
  name: 'R-1 ↔ R-2 Summary/Detail',
  version: 'defense_budget_verification_rule_v1',
  required: false,
  blocking: true,
  riskPoints: 30,

  execute(ctx): RuleResultV1 {
    const { input, policy } = ctx;
    const runId = '';
    const { artifact, referenceArtifacts } = input;

    // Only run when arithmeticRules includes this rule
    if (!policy.arithmeticRules.includes('rdte_summary_detail')) {
      return {
        check: {
          checkId: '',
          code: RDTE_SUMMARY_DETAIL_RULE.code,
          ruleVersion: RDTE_SUMMARY_DETAIL_RULE.version,
          outcome: 'SKIPPED',
          required: false,
          blocking: false,
          riskPoints: 0,
          message: 'rdte_summary_detail not in policy.arithmeticRules',
          assertionIds: [],
          evidenceIds: [],
          referenceArtifactIds: [],
        },
        discrepancies: [],
      };
    }

    // Only run for R-1 artifacts
    if (artifact.source.exhibit !== 'R-1') {
      return {
        check: {
          checkId: '',
          code: RDTE_SUMMARY_DETAIL_RULE.code,
          ruleVersion: RDTE_SUMMARY_DETAIL_RULE.version,
          outcome: 'SKIPPED',
          required: false,
          blocking: false,
          riskPoints: 0,
          message: 'not an R-1 artifact',
          assertionIds: [],
          evidenceIds: [],
          referenceArtifactIds: [],
        },
        discrepancies: [],
      };
    }

    // Find R-2 reference artifacts
    const r2Refs = referenceArtifacts.filter((a) => a.source.exhibit === 'R-2');
    if (r2Refs.length === 0) {
      return {
        check: {
          checkId: '',
          code: RDTE_SUMMARY_DETAIL_RULE.code,
          ruleVersion: RDTE_SUMMARY_DETAIL_RULE.version,
          outcome: 'NOT_RUN',
          required: false,
          blocking: false,
          riskPoints: 10,
          message: 'no R-2 reference artifact available',
          assertionIds: [],
          evidenceIds: [],
          referenceArtifactIds: [],
        },
        discrepancies: [],
      };
    }

    const discrepancies: ReturnType<typeof makeDiscrepancy>[] = [];
    const failingIds: string[] = [];
    const refIds: string[] = r2Refs.map((r) => r.artifactId);

    // For each R-1 funding assertion, find matching R-2 funding assertion
    const r1Funding = artifact.assertions.filter(
      (a): a is Extract<DefenseBudgetAssertionV1, { assertionKind: 'funding' }> =>
        a.assertionKind === 'funding',
    );
    const r2Funding = r2Refs.flatMap((r) =>
      r.assertions.filter(
        (a): a is Extract<DefenseBudgetAssertionV1, { assertionKind: 'funding' }> =>
          a.assertionKind === 'funding',
      ),
    );

    let matched = 0;
    let mismatched = 0;

    for (const r1Assertion of r1Funding) {
      // Match by identity + fiscalYear + field
      const key = JSON.stringify({
        identity: r1Assertion.identity,
        fiscalYear: r1Assertion.fiscalYear,
        field: r1Assertion.field,
      });
      const r2Match = r2Funding.find((a) => {
        const r2Key = JSON.stringify({
          identity: a.identity,
          fiscalYear: a.fiscalYear,
          field: a.field,
        });
        return r2Key === key;
      });

      if (!r2Match) continue;

      matched++;
      const r1Val = r1Assertion.money.valueMillions;
      const r2Val = r2Match.money.valueMillions;
      const tolerance = printedUnitToleranceMillions(1);
      const cmp = compareWithTolerance(r1Val, r2Val, tolerance);
      if (cmp !== 0) {
        mismatched++;
        const diff = absDifference(r1Val, r2Val);
        discrepancies.push(
          makeDiscrepancy(
            'rdte_summary_detail_mismatch',
            'blocking',
            `R-1/R-2 mismatch: PE ${JSON.stringify(r1Assertion.identity)} FY ${r1Assertion.fiscalYear} field ${r1Assertion.field}: R-1=${r1Val}M, R-2=${r2Val}M, diff=${diff}M`,
            [r1Assertion.assertionId, r2Match.assertionId],
            [],
            refIds,
          ),
        );
        failingIds.push(r1Assertion.assertionId);
      }
    }

    if (mismatched > 0) {
      return {
        check: failCheck(
          RDTE_SUMMARY_DETAIL_RULE,
          runId,
          [...new Set(failingIds)],
          [],
          refIds,
          `${mismatched} R-1/R-2 mismatches out of ${matched} matched`,
        ),
        discrepancies,
      };
    }

    if (matched === 0) {
      return {
        check: notRunCheck(
          RDTE_SUMMARY_DETAIL_RULE,
          runId,
          [],
          [],
          refIds,
          'no matching R-1/R-2 assertion pairs found',
        ),
        discrepancies: [],
      };
    }

    return {
      check: passCheck(
        RDTE_SUMMARY_DETAIL_RULE,
        runId,
        [],
        [],
        refIds,
        `${matched} R-1/R-2 assertion pairs match within tolerance`,
      ),
      discrepancies: [],
    };
  },
};
