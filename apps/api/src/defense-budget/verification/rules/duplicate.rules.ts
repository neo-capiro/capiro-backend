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
 *     Phase 10B-13/10B-14: for `exhibit === 'R-1'` ONLY, the natural key
 *     also includes the row's proven budget-activity (+ line-number, when
 *     reliably known on every candidate sharing that budget activity)
 *     dimension, persisted as `metadata.rowBudgetActivity` /
 *     `metadata.rowLineNumber` by r1-artifact-builder-v1 (PR #1355's Phase
 *     10B-12/13/14 forensics). Two R-1 funding assertions for the same
 *     PE/FY/field but a genuinely different budget activity (the real
 *     production example: PE 0604201F, BA04 FY24 request 18,041 vs BA05
 *     FY24 request 163,156, each independently rolling into its own
 *     budget-activity subtotal) are truthfully-represented, legitimate
 *     constituent rows, not a duplicate. Within the SAME budget activity,
 *     a different, reliably-known line number is likewise a different row
 *     identity (two constituent lines can share a PE and a BA); whether
 *     any of this can ever become one canonical ProgramElementYear.request
 *     is a projection-layer question the RDT&E projection planner already
 *     answers conservatively (never last-wins, never summed), not a
 *     verification-layer failure.
 *
 *     Comparison rule (same budget activity):
 *       same BA + same line               -> same row identity
 *       same BA + different KNOWN line     -> different row identity
 *       same BA + line unknown on either side -> fall back conservatively
 *                                                to BA-level comparison
 *                                                (same row identity)
 *     Different BA is always a different row identity regardless of line
 *     number. An R-1 funding assertion with no persisted row-budget-
 *     activity context at all (older artifacts, or a structural-table
 *     document this reconstruction metadata never applied to) fails
 *     closed onto the exact original, identity-blind key, so a real
 *     duplicate is still caught. No other exhibit family's natural key
 *     changes at all.
 *
 *     Because "fall back to BA-level when either side lacks a line
 *     number" is a PAIRWISE decision (not computable from one assertion in
 *     isolation the way a flat per-assertion key is), R-1 funding
 *     assertions are grouped in two passes: first by budget activity (the
 *     always-available base key), then, only within a BA group where every
 *     member has a line number, sub-partitioned by line number. A BA group
 *     with any member missing a line number is never sub-partitioned --
 *     it stays one group, i.e. BA-level comparison.
 */
import type { VerificationRuleV1, RuleResultV1 } from './rule-types.js';
import { passCheck, failCheck, notRunCheck, makeDiscrepancy } from './rule-types.js';
import type { DefenseBudgetAssertionV1 } from '../../contracts/extraction-artifact-v1.js';

type FundingAssertionV1 = Extract<DefenseBudgetAssertionV1, { assertionKind: 'funding' }>;

function fundingBaseKey(a: FundingAssertionV1): string {
  return JSON.stringify({
    identity: a.identity,
    fiscalYear: a.fiscalYear,
    field: a.field,
    artifactId: '', // same artifact — all funding assertions from one artifact share this
  });
}

function rowBudgetActivityOf(a: FundingAssertionV1): string | null {
  const metadata = (a.metadata ?? {}) as Record<string, unknown>;
  return typeof metadata.rowBudgetActivity === 'string' ? metadata.rowBudgetActivity : null;
}

function rowLineNumberOf(a: FundingAssertionV1): string | null {
  const metadata = (a.metadata ?? {}) as Record<string, unknown>;
  return typeof metadata.rowLineNumber === 'string' ? metadata.rowLineNumber : null;
}

/**
 * Partitions R-1 funding assertions into natural-key groups per the
 * comparison rule above. Non-R-1 assertions, and R-1 assertions with no
 * persisted budget-activity context, each form their own single-assertion-
 * per-key groups keyed by the plain, exhibit-agnostic base key (fail
 * closed: a later assertion sharing that exact base key still lands in
 * the same group and is still caught as a duplicate).
 */
function groupFundingAssertionsByNaturalKey(
  assertions: readonly FundingAssertionV1[],
  exhibit: string | undefined,
): Map<string, FundingAssertionV1[]> {
  const groups = new Map<string, FundingAssertionV1[]>();
  const addTo = (key: string, a: FundingAssertionV1) => {
    const existing = groups.get(key);
    if (existing) existing.push(a);
    else groups.set(key, [a]);
  };

  if (exhibit !== 'R-1') {
    for (const a of assertions) addTo(fundingBaseKey(a), a);
    return groups;
  }

  // Pass 1: base key + budget activity (or the plain base key when budget
  // activity is unknown -- fail closed onto the original comparison).
  const baGroups = new Map<string, FundingAssertionV1[]>();
  for (const a of assertions) {
    const base = fundingBaseKey(a);
    const ba = rowBudgetActivityOf(a);
    addToMap(baGroups, ba != null ? `${base}|ba:${ba}` : base, a);
  }

  // Pass 2: within each BA group, sub-partition by line number ONLY when
  // every member has one; otherwise keep the whole BA group as one
  // natural key (BA-level comparison).
  for (const [baKey, members] of baGroups) {
    const allHaveLine = members.every((a) => rowLineNumberOf(a) != null);
    if (!allHaveLine) {
      groups.set(baKey, members);
      continue;
    }
    for (const a of members) {
      addTo(`${baKey}|line:${rowLineNumberOf(a)}`, a);
    }
  }

  return groups;
}

function addToMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
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
    const fundingAssertions = artifact.assertions.filter(
      (a): a is FundingAssertionV1 => a.assertionKind === 'funding',
    );
    const seenKeys = groupFundingAssertionsByNaturalKey(fundingAssertions, exhibit);

    for (const [key, members] of seenKeys) {
      if (members.length > 1) {
        // Two assertions on the same natural key are blocking
        const ids = members.map((a) => a.assertionId);
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
