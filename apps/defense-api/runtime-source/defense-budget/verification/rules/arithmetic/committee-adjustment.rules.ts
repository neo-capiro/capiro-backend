/**
 * Phase 6 Workstream D — committee adjustment arithmetic.
 *
 * Verifies mark = printed request baseline + typed stage actions. Request
 * baselines are non-owning document facts and adjustments are
 * `defense_budget_stage_action_v1` document facts. The post-enactment
 * `reprogrammed` funding field is never used as a committee-adjustment proxy.
 */
import type {
  BudgetLineIdentityV1,
  DefenseBudgetAssertionV1,
} from '../../../contracts/extraction-artifact-v1.js';
import {
  DEFENSE_BUDGET_STAGE_ACTION_FIELD,
  committeeStageActionV1Schema,
  type CommitteeStageActionV1,
} from '../../../stages/authorization/committee-stage-facts-v1.js';
import { committeeRequestComparablesV1 } from '../comparison/committee-request-baseline.rules.js';
import {
  addDecimals,
  absDifference,
  compareWithTolerance,
  printedUnitToleranceMillions,
  sumDecimals,
} from './exact-arithmetic.js';
import {
  failCheck,
  makeDiscrepancy,
  notRunCheck,
  passCheck,
  skippedCheck,
  type RuleResultV1,
  type VerificationRuleV1,
} from '../rule-types.js';

export interface CommitteeAdjustmentGroupV1 {
  identity: BudgetLineIdentityV1;
  fiscalYear: number;
  mark: Extract<DefenseBudgetAssertionV1, { assertionKind: 'funding' }>;
  baselineCandidates: ReturnType<typeof committeeRequestComparablesV1>;
  actions: CommitteeStageActionV1[];
}

export function committeeStageActionsV1(
  assertions: readonly DefenseBudgetAssertionV1[],
): CommitteeStageActionV1[] {
  const out: CommitteeStageActionV1[] = [];
  for (const assertion of assertions) {
    if (
      assertion.assertionKind !== 'document_fact' ||
      assertion.fieldName !== DEFENSE_BUDGET_STAGE_ACTION_FIELD
    ) {
      continue;
    }
    const parsed = committeeStageActionV1Schema.safeParse(assertion.value);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export const COMMITTEE_ADJUSTMENT_RULE: VerificationRuleV1 = {
  code: 'committee_adjustment',
  name: 'Committee Adjustment Arithmetic',
  version: 'defense_budget_verification_rule_v1',
  required: false,
  blocking: true,
  riskPoints: 30,

  execute(ctx): RuleResultV1 {
    const { input, policy } = ctx;
    const runId = ctx.verificationRunId;
    const isRequired = policy.arithmeticRules.includes('committee_adjustment');
    const overrides = {
      required: isRequired,
      blocking: isRequired || COMMITTEE_ADJUSTMENT_RULE.blocking,
    };

    if (!policy.arithmeticRules.includes('committee_adjustment')) {
      return {
        check: skippedCheck(
          COMMITTEE_ADJUSTMENT_RULE,
          runId,
          'committee_adjustment not in policy.arithmeticRules',
          overrides,
        ),
        discrepancies: [],
      };
    }
    if (input.artifact.source.family !== 'committee') {
      return {
        check: skippedCheck(
          COMMITTEE_ADJUSTMENT_RULE,
          runId,
          'not a committee report artifact',
          overrides,
        ),
        discrepancies: [],
      };
    }

    const marks = input.artifact.assertions.filter(
      (assertion): assertion is Extract<DefenseBudgetAssertionV1, { assertionKind: 'funding' }> =>
        assertion.assertionKind === 'funding' &&
        ['hascMark', 'sascMark', 'hacDMark', 'sacDMark', 'ndaaConference', 'conference'].includes(
          assertion.field,
        ),
    );
    const baselines = committeeRequestComparablesV1(input.artifact);
    const actions = committeeStageActionsV1(input.artifact.assertions);

    if (marks.length === 0) {
      return {
        check: notRunCheck(
          COMMITTEE_ADJUSTMENT_RULE,
          runId,
          [],
          [],
          [],
          actions.length > 0
            ? 'typed committee actions exist, but no absolute committee mark was emitted'
            : 'no committee funding marks',
          undefined,
          overrides,
        ),
        discrepancies: [],
      };
    }

    const discrepancies: ReturnType<typeof makeDiscrepancy>[] = [];
    const failingIds: string[] = [];
    const passingIds: string[] = [];
    let evaluatedGroups = 0;

    for (const mark of marks) {
      const key = JSON.stringify(mark.identity);
      const matchingBaselines = baselines.filter(
        (baseline) =>
          JSON.stringify(baseline.identity) === key && baseline.fiscalYear === mark.fiscalYear,
      );
      const matchingActions = actions.filter(
        (action) =>
          action.identity != null &&
          JSON.stringify(action.identity) === key &&
          action.fiscalYear === mark.fiscalYear,
      );

      if (matchingBaselines.length !== 1) {
        discrepancies.push(
          makeDiscrepancy(
            matchingBaselines.length === 0
              ? 'committee_adjustment_baseline_absent'
              : 'committee_adjustment_baseline_ambiguous',
            'review',
            matchingBaselines.length === 0
              ? `no printed request baseline for ${key} FY${mark.fiscalYear}`
              : `multiple printed request baselines for ${key} FY${mark.fiscalYear}`,
            [mark.assertionId, ...matchingBaselines.map((item) => item.assertionId)],
            [],
            [],
          ),
        );
        continue;
      }
      if (matchingActions.length === 0) {
        discrepancies.push(
          makeDiscrepancy(
            'committee_adjustment_detail_absent',
            'review',
            `no typed action detail for ${key} FY${mark.fiscalYear}; zero adjustment is not inferred`,
            [mark.assertionId, matchingBaselines[0]!.assertionId],
            [],
            [],
          ),
        );
        continue;
      }

      evaluatedGroups += 1;
      const baseline = matchingBaselines[0]!;
      const netActions = sumDecimals(matchingActions.map((action) => action.signedValueMillions));
      const computed = addDecimals(baseline.money.valueMillions, netActions);
      const tolerance = printedUnitToleranceMillions(matchingActions.length + 2);
      if (compareWithTolerance(mark.money.valueMillions, computed, tolerance) !== 0) {
        failingIds.push(
          mark.assertionId,
          baseline.assertionId,
          ...matchingActions.map((action) => action.actionId),
        );
        discrepancies.push(
          makeDiscrepancy(
            'committee_adjustment_mismatch',
            'blocking',
            `request(${baseline.money.valueMillions}) + actions(${netActions}) = ${computed}M, mark=${mark.money.valueMillions}M, diff=${absDifference(mark.money.valueMillions, computed)}M`,
            [
              mark.assertionId,
              baseline.assertionId,
              ...matchingActions.map((action) => action.actionId),
            ],
            [],
            [],
          ),
        );
      } else {
        passingIds.push(
          mark.assertionId,
          baseline.assertionId,
          ...matchingActions.map((action) => action.actionId),
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
          `${discrepancies.filter((item) => item.severity === 'blocking').length} committee adjustment mismatches`,
          { evaluatedGroups, typedActionCount: actions.length },
          overrides,
        ),
        discrepancies,
      };
    }
    if (discrepancies.length > 0 || evaluatedGroups === 0) {
      return {
        check: notRunCheck(
          COMMITTEE_ADJUSTMENT_RULE,
          runId,
          [...new Set(passingIds)],
          [],
          [],
          `${discrepancies.length} committee mark groups lack exact baseline/action coverage`,
          { evaluatedGroups, typedActionCount: actions.length },
          overrides,
        ),
        discrepancies,
      };
    }
    return {
      check: passCheck(
        COMMITTEE_ADJUSTMENT_RULE,
        runId,
        [...new Set(passingIds)],
        [],
        [],
        `all ${evaluatedGroups} committee mark groups satisfy request + typed actions = mark`,
        { evaluatedGroups, typedActionCount: actions.length },
        overrides,
      ),
      discrepancies: [],
    };
  },
};
