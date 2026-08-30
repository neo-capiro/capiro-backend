/**
 * Workstream G4+G5 — Duplicate detection and cross-kind consistency.
 *
 * G4: Detect duplicates using maps, not O(n²) pair loops.
 *     For funding assertions, natural key includes:
 *       identity + fiscalYear + field + source artifact
 *     Two assertions on the same natural key are blocking unless they are
 *     explicitly represented as separate alternatives with a duplicate
 *     discrepancy. The verifier never chooses "last wins."
 *
 *     Phase 10B-13: for `exhibit === 'R-1'` ONLY, the natural key also
 *     includes the row's proven budget-activity dimension (persisted as
 *     `metadata.rowBudgetActivity` by r1-artifact-builder-v1, see PR
 *     #1355's Phase 10B-12/13 forensics). Two R-1 funding assertions for
 *     the same PE/FY/field but a genuinely different budget activity (the
 *     real production example: PE 0604201F, BA04 FY24 request 18,041 vs
 *     BA05 FY24 request 163,156, each independently rolling into its own
 *     budget-activity subtotal) are truthfully-represented, legitimate
 *     constituent rows, not a duplicate -- whether they can ever become
 *     one canonical ProgramElementYear.request is a projection-layer
 *     question the RDT&E projection planner already answers conservatively
 *     (never last-wins, never summed), not a verification-layer failure.
 *     An R-1 funding assertion with no persisted row-budget-activity
 *     context (older artifacts, or a structural-table document this
 *     reconstruction metadata never applied to) fails closed onto the
 *     exact original, identity-blind key, so a real duplicate is still
 *     caught. No other exhibit family's natural key changes at all.
 */
import type { VerificationRuleV1, RuleResultV1 } from './rule-types.js';
import { passCheck, failCheck, notRunCheck, makeDiscrepancy } from './rule-types.js';
import type { DefenseBudgetAssertionV1 } from '../../contracts/extraction-artifact-v1.js';

function fundingNaturalKey(
  a: Extract<DefenseBudgetAssertionV1, { assertionKind: 'funding' }>,
  exhibit: string | undefined,
): string {
  const base = {
    identity: a.identity,
    fiscalYear: a.fiscalYear,
    field: a.field,
    artifactId: '', // same artifact — all funding assertions from one artifact share this
  };
  if (exhibit === 'R-1') {
    const metadata = (a.metadata ?? {}) as Record<string, unknown>;
    const rowBudgetActivity =
      typeof metadata.rowBudgetActivity === 'string' ? metadata.rowBudgetActivity : null;
    if (rowBudgetActivity != null) {
      return JSON.stringify({ ...base, rowBudgetActivity });
    }
    // Fail closed: no persisted R-1 row context -- retain the exact
    // original, exhibit-agnostic key so a real duplicate is still caught.
  }
  return JSON.stringify(base);
}

export const DUPLICATE_RULE: VerificationRuleV1 = {
  code: 'duplicate_detection',
  name: 'Duplicate Detection',
  version: 'defense_budget_verification_rule_v1',
  required: true,
  blocking: true,
  riskPoints: 25,

  execute(ctx): RuleResultV1 {
    const { input } = ctx;
    const runId = ctx.verificationRunId;
    const { artifact } = input;
    const discrepancies: ReturnType<typeof makeDiscrepancy>[] = [];
    const failingIds: string[] = [];
    const reviewIds: string[] = [];

    // G4: Duplicate funding detection using a map
    const exhibit = artifact.source.exhibit;
    const seenKeys = new Map<string, string[]>();
    for (const assertion of artifact.assertions) {
      if (assertion.assertionKind !== 'funding') continue;
      const key = fundingNaturalKey(assertion, exhibit);
      const existing = seenKeys.get(key);
      if (existing) {
        existing.push(assertion.assertionId);
      } else {
        seenKeys.set(key, [assertion.assertionId]);
      }
    }

    for (const [key, ids] of seenKeys) {
      if (ids.length > 1) {
        // Two assertions on the same natural key are blocking
        for (const id of ids) {
          failingIds.push(id);
        }
        discrepancies.push(
          makeDiscrepancy(
            'duplicate_funding_natural_key',
            'blocking',
            `duplicate funding assertions on natural key: ${key} — assertion IDs: ${ids.join(', ')}`,
            ids,
            [],
            [],
          ),
        );
      }
    }

    // G5: Cross-kind consistency

    // Build identity sets for lookup
    const peCodes = new Set<string>();
    const projectCodes = new Set<string>();
    for (const a of artifact.assertions) {
      if (a.assertionKind === 'program_element_identity') {
        peCodes.add(a.identity.peCode);
      }
      if (a.assertionKind === 'project') {
        projectCodes.add(a.projectCode);
      }
    }

    // project funding must reference a represented project or force review
    for (const a of artifact.assertions) {
      if (a.assertionKind !== 'project_funding') continue;
      if (!projectCodes.has(a.projectCode)) {
        reviewIds.push(a.assertionId);
        discrepancies.push(
          makeDiscrepancy(
            'cross_kind_project_funding_without_project',
            'review',
            `project_funding "${a.assertionId}" references project "${a.projectCode}" which has no project assertion`,
            [a.assertionId],
            [],
            [],
          ),
        );
      }
      // performer must reference a known parent PE
      if (!peCodes.has(a.parentPeCode)) {
        reviewIds.push(a.assertionId);
        discrepancies.push(
          makeDiscrepancy(
            'cross_kind_project_funding_parent_pe_unknown',
            'review',
            `project_funding "${a.assertionId}" parent PE "${a.parentPeCode}" has no identity assertion`,
            [a.assertionId],
            [],
            [],
          ),
        );
      }
    }

    // performer must reference a known parent PE
    for (const a of artifact.assertions) {
      if (a.assertionKind !== 'performer') continue;
      if (!peCodes.has(a.parentPeCode)) {
        reviewIds.push(a.assertionId);
        discrepancies.push(
          makeDiscrepancy(
            'cross_kind_performer_parent_pe_unknown',
            'review',
            `performer "${a.assertionId}" parent PE "${a.parentPeCode}" has no identity assertion`,
            [a.assertionId],
            [],
            [],
          ),
        );
      }
    }

    // relationship endpoints cannot be identical for non-other relationships
    for (const a of artifact.assertions) {
      if (a.assertionKind !== 'relationship') continue;
      if (a.relationshipType !== 'other' && JSON.stringify(a.from) === JSON.stringify(a.to)) {
        discrepancies.push(
          makeDiscrepancy(
            'cross_kind_relationship_identical_endpoints',
            'blocking',
            `relationship "${a.assertionId}" type "${a.relationshipType}" has identical endpoints`,
            [a.assertionId],
            [],
            [],
          ),
        );
        failingIds.push(a.assertionId);
      }
    }

    if (failingIds.length > 0) {
      return {
        check: failCheck(
          DUPLICATE_RULE,
          runId,
          [...new Set(failingIds)],
          [],
          [],
          `duplicate/cross-kind violations: ${failingIds.length} blocking failures`,
        ),
        discrepancies,
      };
    }

    if (reviewIds.length > 0) {
      return {
        check: notRunCheck(
          DUPLICATE_RULE,
          runId,
          [...new Set(reviewIds)],
          [],
          [],
          `${reviewIds.length} cross-kind consistency issues requiring review`,
        ),
        discrepancies,
      };
    }

    return {
      check: passCheck(
        DUPLICATE_RULE,
        runId,
        [],
        [],
        [],
        'no duplicate natural keys and all cross-kind references are consistent',
      ),
      discrepancies: [],
    };
  },
};
