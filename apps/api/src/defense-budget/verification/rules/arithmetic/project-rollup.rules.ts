/**
 * Workstream H4 — R-2A project rollup arithmetic rule.
 *
 * When project funding is present:
 * - sum all represented project assertions for PE + FY + field
 * - compare to R-2 PE total
 * - missing child values are not silently skipped
 * - an incomplete project list yields NOT_RUN or FAIL according to completeness
 * - a mismatched rollup is blocking for automatic pass
 */
import type { VerificationRuleV1, RuleResultV1 } from '../rule-types.js';
import { passCheck, failCheck, notRunCheck, makeDiscrepancy } from '../rule-types.js';
import {
  sumDecimals,
  compareWithTolerance,
  printedUnitToleranceMillions,
  absDifference,
} from './exact-arithmetic.js';
import type { DefenseBudgetAssertionV1 } from '../../../contracts/extraction-artifact-v1.js';

export const PROJECT_ROLLUP_RULE: VerificationRuleV1 = {
  code: 'project_rollup',
  name: 'R-2A Project Rollup',
  version: 'defense_budget_verification_rule_v1',
  required: false,
  blocking: true,
  riskPoints: 30,

  execute(ctx): RuleResultV1 {
    const { input, policy } = ctx;
    const runId = '';
    const { artifact } = input;

    if (!policy.arithmeticRules.includes('project_rollup')) {
      return {
        check: {
          checkId: '',
          code: PROJECT_ROLLUP_RULE.code,
          ruleVersion: PROJECT_ROLLUP_RULE.version,
          outcome: 'SKIPPED',
          required: false,
          blocking: false,
          riskPoints: 0,
          message: 'project_rollup not in policy.arithmeticRules',
          assertionIds: [],
          evidenceIds: [],
          referenceArtifactIds: [],
        },
        discrepancies: [],
      };
    }

    // Only run for R-2A artifacts
    if (artifact.source.exhibit !== 'R-2A') {
      return {
        check: {
          checkId: '',
          code: PROJECT_ROLLUP_RULE.code,
          ruleVersion: PROJECT_ROLLUP_RULE.version,
          outcome: 'SKIPPED',
          required: false,
          blocking: false,
          riskPoints: 0,
          message: 'not an R-2A artifact',
          assertionIds: [],
          evidenceIds: [],
          referenceArtifactIds: [],
        },
        discrepancies: [],
      };
    }

    // Group project_funding assertions by parentPeCode + fiscalYear + field
    const projectFunding = artifact.assertions.filter(
      (a): a is Extract<DefenseBudgetAssertionV1, { assertionKind: 'project_funding' }> =>
        a.assertionKind === 'project_funding',
    );
    const funding = artifact.assertions.filter(
      (a): a is Extract<DefenseBudgetAssertionV1, { assertionKind: 'funding' }> =>
        a.assertionKind === 'funding',
    );

    if (projectFunding.length === 0) {
      return {
        check: notRunCheck(
          PROJECT_ROLLUP_RULE,
          runId,
          [],
          [],
          [],
          'no project_funding assertions to roll up',
        ),
        discrepancies: [],
      };
    }

    // Group project funding by (parentPeCode, fiscalYear, field)
    const groups = new Map<string, typeof projectFunding>();
    for (const pf of projectFunding) {
      const key = `${pf.parentPeCode}|${pf.fiscalYear}|${pf.field}`;
      const existing = groups.get(key);
      if (existing) {
        existing.push(pf);
      } else {
        groups.set(key, [pf]);
      }
    }

    const discrepancies: ReturnType<typeof makeDiscrepancy>[] = [];
    const failingIds: string[] = [];

    for (const [key, pfGroup] of groups) {
      const [peCode, fyStr, field] = key.split('|');
      const fy = Number(fyStr);

      // Find matching R-2 PE total (funding assertion with same identity + FY + field)
      const peTotal = funding.find((f) => {
        if (f.identity.lineKind !== 'RDTE_PE') return false;
        return f.identity.peCode === peCode && f.fiscalYear === fy && f.field === field;
      });

      if (!peTotal) {
        // Missing parent total — NOT_RUN, not silently skipped
        discrepancies.push(
          makeDiscrepancy(
            'project_rollup_parent_total_missing',
            'review',
            `no PE funding total for ${peCode} FY ${fy} field ${field} to compare project rollup`,
            pfGroup.map((p) => p.assertionId),
            [],
            [],
          ),
        );
        continue;
      }

      // Sum project funding values
      const childValues = pfGroup.map((p) => p.money.valueMillions);
      const childSum = sumDecimals(childValues);
      const parentValue = peTotal.money.valueMillions;
      const tolerance = printedUnitToleranceMillions(pfGroup.length);
      const cmp = compareWithTolerance(parentValue, childSum, tolerance);

      if (cmp !== 0) {
        const diff = absDifference(parentValue, childSum);
        failingIds.push(peTotal.assertionId, ...pfGroup.map((p) => p.assertionId));
        discrepancies.push(
          makeDiscrepancy(
            'project_rollup_mismatch',
            'blocking',
            `project rollup mismatch: PE ${peCode} FY ${fy} field ${field}: parent=${parentValue}M, childSum=${childSum}M, diff=${diff}M, tolerance=${tolerance}M`,
            [peTotal.assertionId, ...pfGroup.map((p) => p.assertionId)],
            [],
            [],
          ),
        );
      }
    }

    if (failingIds.length > 0) {
      return {
        check: failCheck(
          PROJECT_ROLLUP_RULE,
          runId,
          [...new Set(failingIds)],
          [],
          [],
          `project rollup mismatches: ${discrepancies.filter((d) => d.severity === 'blocking').length}`,
        ),
        discrepancies,
      };
    }

    if (discrepancies.length > 0) {
      return {
        check: notRunCheck(
          PROJECT_ROLLUP_RULE,
          runId,
          [],
          [],
          [],
          `${discrepancies.length} project rollup groups lack parent totals`,
        ),
        discrepancies,
      };
    }

    return {
      check: passCheck(
        PROJECT_ROLLUP_RULE,
        runId,
        [],
        [],
        [],
        'all project rollups match parent PE totals within tolerance',
      ),
      discrepancies: [],
    };
  },
};
