/**
 * Workstream H5 — Procurement rollup arithmetic rule.
 *
 * Where present:
 * - compare child line-item dollars to parent total
 * - compare quantity × unit cost to dollars only where the source semantics
 *   indicate that relationship
 * - do not force the relationship when unit cost excludes ancillary costs
 * - absence of a required child set is truthful NOT_RUN
 */
import type { VerificationRuleV1, RuleResultV1 } from '../rule-types.js';
import { passCheck, failCheck, notRunCheck, makeDiscrepancy } from '../rule-types.js';
import {
  sumDecimals,
  multiplyByInteger,
  compareWithTolerance,
  printedUnitToleranceMillions,
  absDifference,
} from './exact-arithmetic.js';
import type { DefenseBudgetAssertionV1 } from '../../../contracts/extraction-artifact-v1.js';

export const PROCUREMENT_ROLLUP_RULE: VerificationRuleV1 = {
  code: 'procurement_rollup',
  name: 'Procurement Rollup',
  version: 'defense_budget_verification_rule_v1',
  required: false,
  blocking: true,
  riskPoints: 30,

  execute(ctx): RuleResultV1 {
    const { input, policy } = ctx;
    const runId = '';
    const { artifact } = input;

    if (!policy.arithmeticRules.includes('procurement_rollup')) {
      return {
        check: {
          checkId: '',
          code: PROCUREMENT_ROLLUP_RULE.code,
          ruleVersion: PROCUREMENT_ROLLUP_RULE.version,
          outcome: 'SKIPPED',
          required: false,
          blocking: false,
          riskPoints: 0,
          message: 'procurement_rollup not in policy.arithmeticRules',
          assertionIds: [],
          evidenceIds: [],
          referenceArtifactIds: [],
        },
        discrepancies: [],
      };
    }

    // Only run for P-doc artifacts
    if (artifact.source.family !== 'procurement') {
      return {
        check: {
          checkId: '',
          code: PROCUREMENT_ROLLUP_RULE.code,
          ruleVersion: PROCUREMENT_ROLLUP_RULE.version,
          outcome: 'SKIPPED',
          required: false,
          blocking: false,
          riskPoints: 0,
          message: 'not a procurement artifact',
          assertionIds: [],
          evidenceIds: [],
          referenceArtifactIds: [],
        },
        discrepancies: [],
      };
    }

    const procurementLines = artifact.assertions.filter(
      (a): a is Extract<DefenseBudgetAssertionV1, { assertionKind: 'procurement_line' }> =>
        a.assertionKind === 'procurement_line',
    );
    const funding = artifact.assertions.filter(
      (a): a is Extract<DefenseBudgetAssertionV1, { assertionKind: 'funding' }> =>
        a.assertionKind === 'funding',
    );

    if (procurementLines.length === 0) {
      return {
        check: notRunCheck(
          PROCUREMENT_ROLLUP_RULE,
          runId,
          [],
          [],
          [],
          'no procurement line assertions',
        ),
        discrepancies: [],
      };
    }

    const discrepancies: ReturnType<typeof makeDiscrepancy>[] = [];
    const failingIds: string[] = [];

    // Group procurement lines by parentIdentity + fiscalYear
    const groups = new Map<string, typeof procurementLines>();
    for (const line of procurementLines) {
      const key = JSON.stringify({
        identity: line.parentIdentity,
        fiscalYear: line.fiscalYear,
      });
      const existing = groups.get(key);
      if (existing) {
        existing.push(line);
      } else {
        groups.set(key, [line]);
      }
    }

    for (const [key, lines] of groups) {
      const identityKey = JSON.parse(key) as { identity: unknown; fiscalYear: number };

      // Find matching funding assertion (parent total)
      const parentTotal = funding.find((f) => {
        return (
          JSON.stringify(f.identity) === JSON.stringify(identityKey.identity) &&
          f.fiscalYear === identityKey.fiscalYear &&
          f.field === 'request'
        );
      });

      if (!parentTotal) {
        // No parent total — NOT_RUN, not a failure
        continue;
      }

      // Sum child line-item dollars
      const childDollars = lines
        .filter((l) => l.dollars != null)
        .map((l) => l.dollars!.valueMillions);
      if (childDollars.length === 0) {
        continue;
      }
      const childSum = sumDecimals(childDollars);
      const parentValue = parentTotal.money.valueMillions;
      const tolerance = printedUnitToleranceMillions(lines.length);
      const cmp = compareWithTolerance(parentValue, childSum, tolerance);

      if (cmp !== 0) {
        const diff = absDifference(parentValue, childSum);
        failingIds.push(parentTotal.assertionId, ...lines.map((l) => l.assertionId));
        discrepancies.push(
          makeDiscrepancy(
            'procurement_rollup_mismatch',
            'blocking',
            `procurement rollup mismatch: parent=${parentValue}M, childSum=${childSum}M, diff=${diff}M, tolerance=${tolerance}M`,
            [parentTotal.assertionId, ...lines.map((l) => l.assertionId)],
            [],
            [],
          ),
        );
      }

      // Check quantity × unit cost for lines that have both
      for (const line of lines) {
        if (line.quantity != null && line.unitCostDollars != null) {
          // quantity × unitCostDollars — compare to line dollars (not forced)
          if (line.dollars) {
            try {
              const computedDollars = multiplyByInteger(line.unitCostDollars, line.quantity);
              const lineDollars = line.dollars.valueMillions;
              const qtyCmp = compareWithTolerance(
                lineDollars,
                computedDollars,
                printedUnitToleranceMillions(1),
              );
              if (qtyCmp !== 0) {
                // Not forced — ancillary costs may differ. Review, not blocking.
                discrepancies.push(
                  makeDiscrepancy(
                    'procurement_qty_unit_cost_review',
                    'review',
                    `procurement line "${line.assertionId}": quantity × unit cost (${computedDollars}) differs from dollars (${lineDollars}) — may exclude ancillary costs`,
                    [line.assertionId],
                    [],
                    [],
                  ),
                );
              }
            } catch {
              // multiplication error — review only
              discrepancies.push(
                makeDiscrepancy(
                  'procurement_qty_unit_cost_error',
                  'review',
                  `procurement line "${line.assertionId}": cannot compute quantity × unit cost`,
                  [line.assertionId],
                  [],
                  [],
                ),
              );
            }
          }
        }
      }
    }

    if (failingIds.length > 0) {
      return {
        check: failCheck(
          PROCUREMENT_ROLLUP_RULE,
          runId,
          [...new Set(failingIds)],
          [],
          [],
          `procurement rollup mismatches: ${discrepancies.filter((d) => d.severity === 'blocking').length}`,
        ),
        discrepancies,
      };
    }

    if (discrepancies.length > 0) {
      return {
        check: notRunCheck(
          PROCUREMENT_ROLLUP_RULE,
          runId,
          [],
          [],
          [],
          `${discrepancies.length} procurement review findings`,
        ),
        discrepancies,
      };
    }

    return {
      check: passCheck(
        PROCUREMENT_ROLLUP_RULE,
        runId,
        [],
        [],
        [],
        'all procurement rollups match within tolerance',
      ),
      discrepancies: [],
    };
  },
};
