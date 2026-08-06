/** Phase 6 Workstream G — conference arithmetic only when the source defines it. */
import {
  NDAA_CONFERENCE_CHAMBER_POSITIONS_FIELD,
  parseNdaaConferenceChamberPositionsV1,
} from '../../../stages/authorization/ndaa-conference/ndaa-conference-facts-v1.js';
import { addDecimals } from './exact-arithmetic.js';
import {
  failCheck,
  makeDiscrepancy,
  passCheck,
  skippedCheck,
  type VerificationRuleV1,
} from '../rule-types.js';

export const NDAA_CONFERENCE_ARITHMETIC_RULE: VerificationRuleV1 = {
  code: 'ndaa_conference_arithmetic',
  name: 'NDAA conference arithmetic',
  version: 'defense_budget_verification_rule_v1',
  required: false,
  blocking: false,
  riskPoints: 25,

  execute(ctx) {
    if (!ctx.policy.arithmeticRules.includes(this.code)) {
      return {
        check: skippedCheck(this, ctx.verificationRunId, `${this.code} not in policy`),
        discrepancies: [],
      };
    }
    const rows = ctx.input.artifact.assertions.flatMap((assertion) => {
      if (
        assertion.assertionKind !== 'document_fact' ||
        assertion.fieldName !== NDAA_CONFERENCE_CHAMBER_POSITIONS_FIELD
      )
        return [];
      return [{ assertion, value: parseNdaaConferenceChamberPositionsV1(assertion.value) }];
    });
    const defined = rows.filter(
      (item) => item.value.requestBaseline != null && item.value.change != null,
    );
    const mismatches = defined.filter(
      (item) =>
        addDecimals(item.value.requestBaseline!.valueMillions, item.value.change!.valueMillions) !==
        item.value.conference.money.valueMillions,
    );
    const overrides = { required: true, blocking: true };
    if (mismatches.length > 0) {
      const ids = mismatches.map((item) => item.assertion.assertionId);
      return {
        check: failCheck(
          this,
          ctx.verificationRunId,
          ids,
          mismatches.flatMap((item) => item.assertion.evidenceIds),
          [],
          `${mismatches.length} NDAA conference rows violate explicit request + change = conference arithmetic`,
          undefined,
          overrides,
        ),
        discrepancies: [
          makeDiscrepancy(
            'ndaa_conference_arithmetic_mismatch',
            'blocking',
            'explicit conference arithmetic does not reconcile',
            ids,
            mismatches.flatMap((item) => item.assertion.evidenceIds),
            [],
          ),
        ],
      };
    }
    return {
      check: passCheck(
        this,
        ctx.verificationRunId,
        defined.map((item) => item.assertion.assertionId),
        defined.flatMap((item) => item.assertion.evidenceIds),
        [],
        defined.length === 0
          ? 'source defines no request+change conference arithmetic; no arithmetic relation was invented'
          : `${defined.length} explicit conference arithmetic rows reconcile exactly`,
        { arithmeticRowsChecked: defined.length },
        overrides,
      ),
      discrepancies: [],
    };
  },
};
