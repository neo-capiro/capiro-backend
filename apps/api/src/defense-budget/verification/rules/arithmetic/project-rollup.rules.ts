/**
 * R-2A project rollup arithmetic rule.
 *
 * Every represented project-funding group must have a matching PE total and
 * the exact decimal sum must match within printed-unit tolerance. PASS checks
 * retain all corroborated parent and child assertion IDs so page-only
 * reconciliation can identify exact coverage.
 */
import type { VerificationRuleV1, RuleResultV1 } from '../rule-types.js';
import { passCheck, failCheck, notRunCheck, skippedCheck, makeDiscrepancy } from '../rule-types.js';
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
    const runId = ctx.verificationRunId;
    const { artifact } = input;
    const isRequired = policy.requiredComparisonRules.includes('project_rollup');
    const overrides = {
      required: isRequired,
      blocking: isRequired || PROJECT_ROLLUP_RULE.blocking,
    };

    if (!policy.arithmeticRules.includes('project_rollup')) {
      return {
        check: skippedCheck(
          PROJECT_ROLLUP_RULE,
          runId,
          'project_rollup not in policy.arithmeticRules',
          overrides,
        ),
        discrepancies: [],
      };
    }

    if (artifact.source.exhibit !== 'R-2A') {
      return {
        check: skippedCheck(PROJECT_ROLLUP_RULE, runId, 'not an R-2A artifact', overrides),
        discrepancies: [],
      };
    }

    const projectFunding = artifact.assertions.filter(
      (assertion): assertion is Extract<
        DefenseBudgetAssertionV1,
        { assertionKind: 'project_funding' }
      > => assertion.assertionKind === 'project_funding',
    );
    const funding = artifact.assertions.filter(
      (assertion): assertion is Extract<
        DefenseBudgetAssertionV1,
        { assertionKind: 'funding' }
      > => assertion.assertionKind === 'funding',
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
          undefined,
          overrides,
        ),
        discrepancies: [],
      };
    }

    const groups = new Map<string, typeof projectFunding>();
    for (const assertion of projectFunding) {
      const key = `${assertion.parentPeCode}|${assertion.fiscalYear}|${assertion.field}`;
      const group = groups.get(key) ?? [];
      group.push(assertion);
      groups.set(key, group);
    }

    const discrepancies: ReturnType<typeof makeDiscrepancy>[] = [];
    const failingAssertionIds: string[] = [];
    const matchedAssertionIds: string[] = [];
    const matchedEvidenceIds: string[] = [];
    const missingGroupAssertionIds: string[] = [];
    let matchedGroupCount = 0;

    for (const [key, group] of groups) {
      const [peCode, fiscalYearText, field] = key.split('|');
      const fiscalYear = Number(fiscalYearText);
      const parentMatches = funding.filter((candidate) => {
        if (candidate.identity.lineKind !== 'RDTE_PE') return false;
        return (
          candidate.identity.peCode === peCode &&
          candidate.fiscalYear === fiscalYear &&
          candidate.field === field
        );
      });

      if (parentMatches.length === 0) {
        const groupIds = group.map((assertion) => assertion.assertionId);
        missingGroupAssertionIds.push(...groupIds);
        discrepancies.push(
          makeDiscrepancy(
            'project_rollup_parent_total_missing',
            'review',
            `no PE funding total for ${peCode} FY ${fiscalYear} field ${field}`,
            groupIds,
            group.flatMap((assertion) => assertion.evidenceIds),
            [],
          ),
        );
        continue;
      }

      if (parentMatches.length > 1) {
        const assertionIds = [
          ...parentMatches.map((assertion) => assertion.assertionId),
          ...group.map((assertion) => assertion.assertionId),
        ];
        failingAssertionIds.push(...assertionIds);
        discrepancies.push(
          makeDiscrepancy(
            'project_rollup_parent_total_ambiguous',
            'blocking',
            `multiple PE funding totals match ${peCode} FY ${fiscalYear} field ${field}`,
            assertionIds,
            [
              ...parentMatches.flatMap((assertion) => assertion.evidenceIds),
              ...group.flatMap((assertion) => assertion.evidenceIds),
            ],
            [],
          ),
        );
        continue;
      }

      const parent = parentMatches[0]!;
      const childSum = sumDecimals(group.map((assertion) => assertion.money.valueMillions));
      const parentValue = parent.money.valueMillions;
      const tolerance = printedUnitToleranceMillions(group.length);
      const assertionIds = [
        parent.assertionId,
        ...group.map((assertion) => assertion.assertionId),
      ];
      const evidenceIds = [
        ...parent.evidenceIds,
        ...group.flatMap((assertion) => assertion.evidenceIds),
      ];

      if (compareWithTolerance(parentValue, childSum, tolerance) !== 0) {
        const difference = absDifference(parentValue, childSum);
        failingAssertionIds.push(...assertionIds);
        discrepancies.push(
          makeDiscrepancy(
            'project_rollup_mismatch',
            'blocking',
            `project rollup mismatch for PE ${peCode} FY ${fiscalYear} field ${field}: ` +
              `parent=${parentValue}M childSum=${childSum}M ` +
              `difference=${difference}M tolerance=${tolerance}M`,
            assertionIds,
            evidenceIds,
            [],
          ),
        );
        continue;
      }

      matchedGroupCount++;
      matchedAssertionIds.push(...assertionIds);
      matchedEvidenceIds.push(...evidenceIds);
    }

    const details = {
      groupCount: groups.size,
      matchedGroupCount,
      missingGroupCount: discrepancies.filter(
        (discrepancy) => discrepancy.code === 'project_rollup_parent_total_missing',
      ).length,
      mismatchedGroupCount: discrepancies.filter(
        (discrepancy) =>
          discrepancy.code === 'project_rollup_mismatch' ||
          discrepancy.code === 'project_rollup_parent_total_ambiguous',
      ).length,
      matchedAssertionIds: [...new Set(matchedAssertionIds)].sort(),
      missingGroupAssertionIds: [...new Set(missingGroupAssertionIds)].sort(),
    };

    if (failingAssertionIds.length > 0) {
      return {
        check: failCheck(
          PROJECT_ROLLUP_RULE,
          runId,
          [...new Set(failingAssertionIds)],
          [...new Set(matchedEvidenceIds)],
          [],
          'one or more project rollups are ambiguous or mismatched',
          details,
          overrides,
        ),
        discrepancies,
      };
    }

    if (missingGroupAssertionIds.length > 0 || matchedGroupCount < groups.size) {
      return {
        check: notRunCheck(
          PROJECT_ROLLUP_RULE,
          runId,
          [...new Set(matchedAssertionIds)],
          [...new Set(matchedEvidenceIds)],
          [],
          `project rollup coverage incomplete: ${matchedGroupCount}/${groups.size} groups matched`,
          details,
          overrides,
        ),
        discrepancies,
      };
    }

    return {
      check: passCheck(
        PROJECT_ROLLUP_RULE,
        runId,
        [...new Set(matchedAssertionIds)],
        [...new Set(matchedEvidenceIds)],
        [],
        `all ${matchedGroupCount} project rollups match parent PE totals within tolerance`,
        details,
        overrides,
      ),
      discrepancies: [],
    };
  },
};
