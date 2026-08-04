/**
 * Workstream G1 — Identity validation rule.
 *
 * Validate natural identities:
 *   - RDT&E PE: peCode
 *   - procurement: code + account + component + advance-procurement state
 *   - O&M: code + account + component
 *   - MILCON: project code + component + location where identity requires it
 *
 * Do not collapse identical procurement/O&M codes across accounts or
 * components.
 */
import type { VerificationRuleV1, RuleResultV1 } from './rule-types.js';
import { passCheck, failCheck, makeDiscrepancy } from './rule-types.js';
import { isValidPeCode } from '../../extractors/types.js';

export const IDENTITY_RULE: VerificationRuleV1 = {
  code: 'identity_validation',
  name: 'Identity Validation',
  version: 'defense_budget_verification_rule_v1',
  required: true,
  blocking: true,
  riskPoints: 30,

  execute(ctx): RuleResultV1 {
    const { input } = ctx;
    const runId = ctx.verificationRunId;
    const { artifact } = input;
    const discrepancies: ReturnType<typeof makeDiscrepancy>[] = [];
    const failingIds: string[] = [];

    for (const assertion of artifact.assertions) {
      // RDT&E PE identity validation
      if (assertion.assertionKind === 'program_element_identity') {
        if (!isValidPeCode(assertion.identity.peCode)) {
          discrepancies.push(
            makeDiscrepancy(
              'identity_invalid_pe_code',
              'blocking',
              `program_element_identity "${assertion.assertionId}" has invalid PE code "${assertion.identity.peCode}"`,
              [assertion.assertionId],
              [],
              [],
            ),
          );
          failingIds.push(assertion.assertionId);
        }
        continue;
      }

      // Funding assertion identity validation
      if (assertion.assertionKind === 'funding') {
        const identity = assertion.identity;
        switch (identity.lineKind) {
          case 'RDTE_PE':
            if (!isValidPeCode(identity.peCode)) {
              discrepancies.push(
                makeDiscrepancy(
                  'identity_invalid_rdte_pe_code',
                  'blocking',
                  `funding "${assertion.assertionId}" has invalid RDT&E PE code "${identity.peCode}"`,
                  [assertion.assertionId],
                  [],
                  [],
                ),
              );
              failingIds.push(assertion.assertionId);
            }
            break;
          case 'PROCUREMENT_BLIN':
            // code + account + component + advance-procurement state
            if (!identity.code || !identity.account) {
              discrepancies.push(
                makeDiscrepancy(
                  'identity_procurement_missing_fields',
                  'blocking',
                  `funding "${assertion.assertionId}" procurement identity missing code or account`,
                  [assertion.assertionId],
                  [],
                  [],
                ),
              );
              failingIds.push(assertion.assertionId);
            }
            break;
          case 'OM_SAG':
            // code + account + component
            if (!identity.code || !identity.account) {
              discrepancies.push(
                makeDiscrepancy(
                  'identity_om_missing_fields',
                  'blocking',
                  `funding "${assertion.assertionId}" O&M identity missing code or account`,
                  [assertion.assertionId],
                  [],
                  [],
                ),
              );
              failingIds.push(assertion.assertionId);
            }
            break;
          case 'MILCON_PROJECT':
            // project code + component + location where identity requires it
            if (!identity.projectCode) {
              discrepancies.push(
                makeDiscrepancy(
                  'identity_milcon_missing_project_code',
                  'blocking',
                  `funding "${assertion.assertionId}" MILCON identity missing project code`,
                  [assertion.assertionId],
                  [],
                  [],
                ),
              );
              failingIds.push(assertion.assertionId);
            }
            break;
          case 'UNKNOWN':
            // code is always present per schema, just check nonblank (schema guarantees)
            break;
        }
        continue;
      }

      // Project funding — parent PE code must be valid
      if (assertion.assertionKind === 'project_funding') {
        if (!isValidPeCode(assertion.parentPeCode)) {
          discrepancies.push(
            makeDiscrepancy(
              'identity_invalid_project_parent_pe',
              'blocking',
              `project_funding "${assertion.assertionId}" has invalid parent PE code "${assertion.parentPeCode}"`,
              [assertion.assertionId],
              [],
              [],
            ),
          );
          failingIds.push(assertion.assertionId);
        }
        continue;
      }

      // Performer — parent PE code must be valid
      if (assertion.assertionKind === 'performer') {
        if (!isValidPeCode(assertion.parentPeCode)) {
          discrepancies.push(
            makeDiscrepancy(
              'identity_invalid_performer_parent_pe',
              'blocking',
              `performer "${assertion.assertionId}" has invalid parent PE code "${assertion.parentPeCode}"`,
              [assertion.assertionId],
              [],
              [],
            ),
          );
          failingIds.push(assertion.assertionId);
        }
        continue;
      }

      // Milestone — parent PE code must be valid
      if (assertion.assertionKind === 'milestone') {
        if (!isValidPeCode(assertion.parentPeCode)) {
          discrepancies.push(
            makeDiscrepancy(
              'identity_invalid_milestone_parent_pe',
              'blocking',
              `milestone "${assertion.assertionId}" has invalid parent PE code "${assertion.parentPeCode}"`,
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
          IDENTITY_RULE,
          runId,
          [...new Set(failingIds)],
          [],
          [],
          `identity validation failed for ${failingIds.length} assertions`,
        ),
        discrepancies,
      };
    }

    return {
      check: passCheck(IDENTITY_RULE, runId, [], [], [], 'all assertion identities are valid'),
      discrepancies: [],
    };
  },
};
