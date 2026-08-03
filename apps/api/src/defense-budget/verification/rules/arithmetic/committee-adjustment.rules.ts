/**
 * Workstream H6 — Committee adjustment arithmetic rule.
 *
 * When a report provides request, adjustment, and mark:
 *   mark = request + additions - reductions ± transfers/rescissions
 *
 * Only run when all required terms are represented.
 * If adjustment detail is absent, return NOT_RUN; do not infer zero
 * adjustments.
 */
import type { VerificationRuleV1, RuleResultV1 } from '../rule-types.js';
import { passCheck, failCheck, notRunCheck, makeDiscrepancy } from '../rule-types.js';
import {
  addDecimals,
  subtractDecimals,
  compareWithTolerance,
  printedUnitToleranceMillions,
  absDifference,
} from './exact-arithmetic.js';
import type { DefenseBudgetAssertionV1 } from '../../../contracts/extraction-artifact-v1.js';

export const COMMITTEE_ADJUSTMENT_RULE: VerificationRuleV1 = {
  code: 'committee_adjustment',
  name: 'Committee Adjustment Arithmetic',
  version: 'defense_budget_verification_rule_v1',
  required: false,
  blocking: true,
  riskPoints: 30,

  execute(ctx): RuleResultV1 {
    const { input, policy } = ctx;
    const runId = '';
    const { artifact } = input;

    if (!policy.arithmeticRules.includes('committee_adjustment')) {
      return {
        check: {
          checkId: '',
          code: COMMITTEE_ADJUSTMENT_RULE.code,
          ruleVersion: COMMITTEE_ADJUSTMENT_RULE.version,
          outcome: 'SKIPPED',
          required: false,
          blocking: false,
          riskPoints: 0,
          message: 'committee_adjustment not in policy.arithmeticRules',
          assertionIds: [],
          evidenceIds: [],
          referenceArtifactIds: [],
        },
        discrepancies: [],
      };
    }

    // Only run for committee report artifacts
    if (artifact.source.family !== 'committee') {
      return {
        check: {
          checkId: '',
          code: COMMITTEE_ADJUSTMENT_RULE.code,
          ruleVersion: COMMITTEE_ADJUSTMENT_RULE.version,
          outcome: 'SKIPPED',
          required: false,
          blocking: false,
          riskPoints: 0,
          message: 'not a committee report artifact',
          assertionIds: [],
          evidenceIds: [],
          referenceArtifactIds: [],
        },
        discrepancies: [],
      };
    }

    const funding = artifact.assertions.filter(
      (a): a is Extract<DefenseBudgetAssertionV1, { assertionKind: 'funding' }> =>
        a.assertionKind === 'funding',
    );

    if (funding.length === 0) {
      return {
        check: notRunCheck(
          COMMITTEE_ADJUSTMENT_RULE,
          runId,
          [],
          [],
          [],
          'no funding assertions',
        ),
        discrepancies: [],
      };
    }

    // Group by identity + fiscalYear
    const groups = new Map<string, typeof funding>();
    for (const f of funding) {
      const key = JSON.stringify({ identity: f.identity, fiscalYear: f.fiscalYear });
      const existing = groups.get(key);
      if (existing) {
        existing.push(f);
      } else {
        groups.set(key, [f]);
      }
    }

    const discrepancies: ReturnType<typeof makeDiscrepancy>[] = [];
    const failingIds: string[] = [];

    for (const [key, group] of groups) {
      const request = group.find((f) => f.field === 'request');
      const mark = group.find(
        (f) => f.field === 'hascMark' || f.field === 'sascMark' || f.field === 'hacDMark' || f.field === 'sacDMark' || f.field === 'ndaaConference' || f.field === 'conference',
      );

      // Only run when both request and mark are present
      if (!request || !mark) continue;

      // For now, we only check the simple identity:
      //   mark = request + adjustments
      // If there are no adjustment assertions (separate reprogramming/transfer
      // assertions), we return NOT_RUN — do not infer zero adjustments.
      const hasAdjustments = group.some(
        (f) => f.field === 'reprogrammed',
      );

      if (!hasAdjustments) {
        // No adjustment detail — NOT_RUN, do not infer zero
        discrepancies.push(
          makeDiscrepancy(
            'committee_adjustment_detail_absent',
            'review',
            `no adjustment detail for ${key}: cannot verify mark = request + adjustments`,
            [request.assertionId, mark.assertionId],
            [],
            [],
          ),
        );
        continue;
      }

      // mark = request + additions - reductions
      // The adjustment is in the reprogrammed field
      const adjustment = group.find((f) => f.field === 'reprogrammed');
      if (!adjustment) continue;

      const requestVal = request.money.valueMillions;
      const adjustmentVal = adjustment.money.valueMillions;
      const markVal = mark.money.valueMillions;
      const computedMark = addDecimals(requestVal, adjustmentVal);
      const tolerance = printedUnitToleranceMillions(group.length);
      const cmp = compareWithTolerance(markVal, computedMark, tolerance);

      if (cmp !== 0) {
        const diff = absDifference(markVal, computedMark);
        failingIds.push(request.assertionId, mark.assertionId, adjustment.assertionId);
        discrepancies.push(
          makeDiscrepancy(
            'committee_adjustment_mismatch',
            'blocking',
            `committee adjustment: request(${requestVal}) + adjustment(${adjustmentVal}) = ${computedMark}M, mark=${markVal}M, diff=${diff}M`,
            [request.assertionId, mark.assertionId, adjustment.assertionId],
            [],
            [],
          ),
        );
      }
    }

    if (failingIds.length > 0) {
      return {
        check: failCheck(
          COMMITTEE_ADJUSTMENT_RULE,
          runId,
          [...new Set(failingIds)],
          [],
          [],
          `committee adjustment mismatches: ${discrepancies.filter((d) => d.severity === 'blocking').length}`,
        ),
        discrepancies,
      };
    }

    if (discrepancies.length > 0) {
      return {
        check: notRunCheck(
          COMMITTEE_ADJUSTMENT_RULE,
          runId,
          [],
          [],
          [],
          `${discrepancies.length} groups lack adjustment detail`,
        ),
        discrepancies,
      };
    }

    return {
      check: passCheck(
        COMMITTEE_ADJUSTMENT_RULE,
        runId,
        [],
        [],
        [],
        'all committee adjustments verified',
      ),
      discrepancies: [],
    };
  },
};
