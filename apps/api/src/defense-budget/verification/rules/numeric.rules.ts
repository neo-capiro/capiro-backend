/**
 * Workstream G3 — Exact numeric validation rule.
 *
 * - Use canonical decimal strings.
 * - Never convert verification arithmetic to JS number.
 * - Reject malformed decimals.
 * - Reject non-finite values at contract boundary.
 * - Verify valueMillions exactly equals original value/unit scaling.
 * - Apply field-specific negative-value policy:
 *   - negative reprogramming adjustments may be valid;
 *   - negative canonical request/mark/enacted totals require review or
 *     rejection by policy;
 *   - quantities and unit costs may not be negative unless an explicit
 *     correction policy exists.
 */
import type { VerificationRuleV1, RuleResultV1 } from './rule-types.js';
import { passCheck, failCheck, notRunCheck, makeDiscrepancy } from './rule-types.js';
import { isCanonicalDecimalString, moneyToMillionsString } from '../../contracts/decimal-string.js';

export const NUMERIC_RULE: VerificationRuleV1 = {
  code: 'numeric_validation',
  name: 'Exact Numeric Validation',
  version: 'defense_budget_verification_rule_v1',
  required: true,
  blocking: true,
  riskPoints: 30,

  execute(ctx): RuleResultV1 {
    const { input } = ctx;
    const runId = '';
    const { artifact } = input;
    const discrepancies: ReturnType<typeof makeDiscrepancy>[] = [];
    const failingIds: string[] = [];
    const reviewIds: string[] = [];

    for (const assertion of artifact.assertions) {
      // Check money scaling for funding assertions
      if (assertion.assertionKind === 'funding') {
        const money = assertion.money;
        // Reject malformed decimals
        if (!isCanonicalDecimalString(money.valueMillions)) {
          discrepancies.push(
            makeDiscrepancy(
              'numeric_malformed_value_millions',
              'blocking',
              `funding "${assertion.assertionId}" valueMillions "${money.valueMillions}" is not a canonical decimal`,
              [assertion.assertionId],
              [],
              [],
            ),
          );
          failingIds.push(assertion.assertionId);
          continue;
        }
        // Verify valueMillions exactly equals original value/unit scaling
        let expected: string;
        try {
          expected = moneyToMillionsString(money.originalValue, money.originalUnit);
        } catch {
          discrepancies.push(
            makeDiscrepancy(
              'numeric_scaling_error',
              'blocking',
              `funding "${assertion.assertionId}" cannot scale money`,
              [assertion.assertionId],
              [],
              [],
            ),
          );
          failingIds.push(assertion.assertionId);
          continue;
        }
        if (money.valueMillions !== expected) {
          discrepancies.push(
            makeDiscrepancy(
              'numeric_scaling_mismatch',
              'blocking',
              `funding "${assertion.assertionId}" valueMillions "${money.valueMillions}" != exact scaling "${expected}"`,
              [assertion.assertionId],
              [],
              [],
            ),
          );
          failingIds.push(assertion.assertionId);
          continue;
        }

        // Negative-value policy
        if (money.valueMillions.startsWith('-')) {
          if (assertion.field === 'reprogrammed') {
            // negative reprogramming adjustments may be valid — review
            reviewIds.push(assertion.assertionId);
            discrepancies.push(
              makeDiscrepancy(
                'numeric_negative_reprogrammed',
                'review',
                `funding "${assertion.assertionId}" has negative reprogrammed value "${money.valueMillions}" — valid adjustment, review`,
                [assertion.assertionId],
                [],
                [],
              ),
            );
          } else {
            // negative request/mark/enacted totals require review or rejection
            discrepancies.push(
              makeDiscrepancy(
                'numeric_negative_canonical_total',
                'blocking',
                `funding "${assertion.assertionId}" field "${assertion.field}" has negative value "${money.valueMillions}"`,
                [assertion.assertionId],
                [],
                [],
              ),
            );
            failingIds.push(assertion.assertionId);
          }
        }
        continue;
      }

      // Project funding
      if (assertion.assertionKind === 'project_funding') {
        const money = assertion.money;
        if (!isCanonicalDecimalString(money.valueMillions)) {
          discrepancies.push(
            makeDiscrepancy(
              'numeric_malformed_project_funding',
              'blocking',
              `project_funding "${assertion.assertionId}" valueMillions is not canonical`,
              [assertion.assertionId],
              [],
              [],
            ),
          );
          failingIds.push(assertion.assertionId);
          continue;
        }
        let expected: string;
        try {
          expected = moneyToMillionsString(money.originalValue, money.originalUnit);
        } catch {
          discrepancies.push(
            makeDiscrepancy(
              'numeric_project_funding_scaling_error',
              'blocking',
              `project_funding "${assertion.assertionId}" cannot scale money`,
              [assertion.assertionId],
              [],
              [],
            ),
          );
          failingIds.push(assertion.assertionId);
          continue;
        }
        if (money.valueMillions !== expected) {
          discrepancies.push(
            makeDiscrepancy(
              'numeric_project_funding_scaling_mismatch',
              'blocking',
              `project_funding "${assertion.assertionId}" valueMillions mismatch`,
              [assertion.assertionId],
              [],
              [],
            ),
          );
          failingIds.push(assertion.assertionId);
        }
        continue;
      }

      // Quantity assertions — may not be negative
      if (assertion.assertionKind === 'quantity') {
        if (assertion.quantity.startsWith('-')) {
          discrepancies.push(
            makeDiscrepancy(
              'numeric_negative_quantity',
              'blocking',
              `quantity "${assertion.assertionId}" has negative value "${assertion.quantity}"`,
              [assertion.assertionId],
              [],
              [],
            ),
          );
          failingIds.push(assertion.assertionId);
        }
        continue;
      }

      // Unit cost assertions — may not be negative
      if (assertion.assertionKind === 'unit_cost') {
        if (assertion.unitCostDollars.startsWith('-')) {
          discrepancies.push(
            makeDiscrepancy(
              'numeric_negative_unit_cost',
              'blocking',
              `unit_cost "${assertion.assertionId}" has negative value "${assertion.unitCostDollars}"`,
              [assertion.assertionId],
              [],
              [],
            ),
          );
          failingIds.push(assertion.assertionId);
        }
        continue;
      }

      // Procurement line — check quantity and unit cost
      if (assertion.assertionKind === 'procurement_line') {
        if (assertion.quantity && assertion.quantity.startsWith('-')) {
          discrepancies.push(
            makeDiscrepancy(
              'numeric_negative_procurement_quantity',
              'blocking',
              `procurement_line "${assertion.assertionId}" has negative quantity`,
              [assertion.assertionId],
              [],
              [],
            ),
          );
          failingIds.push(assertion.assertionId);
        }
        if (assertion.unitCostDollars && assertion.unitCostDollars.startsWith('-')) {
          discrepancies.push(
            makeDiscrepancy(
              'numeric_negative_procurement_unit_cost',
              'blocking',
              `procurement_line "${assertion.assertionId}" has negative unit cost`,
              [assertion.assertionId],
              [],
              [],
            ),
          );
          failingIds.push(assertion.assertionId);
        }
        continue;
      }
    }

    if (failingIds.length > 0) {
      return {
        check: failCheck(
          NUMERIC_RULE,
          runId,
          [...new Set(failingIds)],
          [],
          [],
          `numeric validation failed for ${failingIds.length} assertions`,
        ),
        discrepancies,
      };
    }

    if (reviewIds.length > 0) {
      return {
        check: notRunCheck(
          NUMERIC_RULE,
          runId,
          [...new Set(reviewIds)],
          [],
          [],
          `${reviewIds.length} assertions have negative reprogrammed values requiring review`,
        ),
        discrepancies,
      };
    }

    return {
      check: passCheck(
        NUMERIC_RULE,
        runId,
        [],
        [],
        [],
        'all numeric values are canonical and correctly scaled',
      ),
      discrepancies: [],
    };
  },
};
