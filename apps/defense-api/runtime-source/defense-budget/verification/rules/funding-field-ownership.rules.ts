/**
 * Workstream G2 — Funding field ownership rule.
 *
 * Enforce source-authority field ownership:
 *   request            -> dod-comptroller / approved manual correction only
 *   hascMark           -> HASC
 *   sascMark           -> SASC
 *   hacDMark           -> HAC-D
 *   sacDMark           -> SAC-D
 *   ndaaConference     -> NDAA conference
 *   conference         -> appropriations conference
 *   enacted            -> public law
 *   reprogrammed       -> reprogramming
 *   executed           -> execution
 *
 * Contextual request columns printed in committee reports must be
 * represented as comparison/context facts, not written as committee-owned
 * request assertions.
 */
import type { VerificationRuleV1, RuleResultV1 } from './rule-types.js';
import { passCheck, failCheck, makeDiscrepancy } from './rule-types.js';
import type { BudgetAuthorityV1, FundingFieldV1 } from '../../contracts/extraction-artifact-v1.js';

const FIELD_OWNERSHIP: Record<FundingFieldV1, BudgetAuthorityV1[]> = {
  request: ['dod-comptroller', 'manual'],
  hascMark: ['hasc'],
  sascMark: ['sasc'],
  hacDMark: ['hac_d'],
  sacDMark: ['sac_d'],
  ndaaConference: ['ndaa_conference'],
  conference: ['appropriations_conference'],
  enacted: ['public_law'],
  reprogrammed: ['reprogramming'],
  executed: ['execution'],
};

export const FUNDING_FIELD_OWNERSHIP_RULE: VerificationRuleV1 = {
  code: 'funding_field_ownership',
  name: 'Funding Field Ownership',
  version: 'defense_budget_verification_rule_v1',
  required: true,
  blocking: true,
  riskPoints: 35,

  execute(ctx): RuleResultV1 {
    const { input } = ctx;
    const runId = ctx.verificationRunId;
    const { artifact } = input;
    const sourceAuthority = artifact.source.authority;
    const discrepancies: ReturnType<typeof makeDiscrepancy>[] = [];
    const failingIds: string[] = [];

    for (const assertion of artifact.assertions) {
      if (assertion.assertionKind !== 'funding') continue;

      const field = assertion.field;
      const allowedAuthorities = FIELD_OWNERSHIP[field];
      if (!allowedAuthorities) continue;

      if (!allowedAuthorities.includes(sourceAuthority)) {
        discrepancies.push(
          makeDiscrepancy(
            'funding_field_ownership_violation',
            'blocking',
            `funding assertion "${assertion.assertionId}" field "${field}" is owned by [${allowedAuthorities.join(', ')}] but artifact source authority is "${sourceAuthority}"`,
            [assertion.assertionId],
            [],
            [],
          ),
        );
        failingIds.push(assertion.assertionId);
      }
    }

    if (failingIds.length > 0) {
      return {
        check: failCheck(
          FUNDING_FIELD_OWNERSHIP_RULE,
          runId,
          [...new Set(failingIds)],
          [],
          [],
          `field ownership violations: ${failingIds.length} assertions have wrong source authority`,
        ),
        discrepancies,
      };
    }

    return {
      check: passCheck(
        FUNDING_FIELD_OWNERSHIP_RULE,
        runId,
        [],
        [],
        [],
        'all funding assertions have correct source authority for their fields',
      ),
      discrepancies: [],
    };
  },
};
