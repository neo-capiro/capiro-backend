/**
 * Phase 7 Workstream M — projecting `canonical_rdte_project` rows into
 * `getProjects`' existing response shape.
 *
 * The second entity migrated after `canonical_rdte_budget_position`, and the
 * first one where the legacy contract is genuinely wider than the canonical
 * identity. Four of the nine legacy columns have no canonical source, and each
 * is a different kind of absence — worth stating individually rather than as one
 * "not available yet", because only two of them are expected to close:
 *
 * 1. **`id`** is a legacy database primary key. It is not data, it is a row
 *    address in a mutable table this migration exists to stop being the source
 *    of truth. It has no snapshot analogue by design and never will. Projected
 *    as `null`; a consumer using it as a React key should switch to
 *    `projectCode`, which is the real identity (scoped to the parent PE — see
 *    the registry note, project codes are never globally unique alone).
 * 2. **`fy`** is not part of R-2A project *identity*. The canonical natural key
 *    is `['peCode', 'projectCode']`, deliberately: a project persists across
 *    fiscal years and its per-year money lives in
 *    `canonical_rdte_project_budget_position`. The legacy column conflates the
 *    identity with the cycle it happened to be read from. Honest `null` rather
 *    than the parent snapshot's cycle year, which would look like a fact and be
 *    an invention.
 * 3. **`sourceUrl`/`pageNumber`** have no upstream source on this entity's
 *    candidate. `rdte-projection-planner-v1.ts` builds the project candidate's
 *    `values` bag with exactly `peCode`, `projectCode`, `title`, and optionally
 *    `mission`/`budgetActivity` — confirmed by reading the planner directly.
 *    Same honest-`null` situation as the budget-position projector, and the same
 *    expectation: a `missing_data` shadow finding until Phase 4 carries them.
 * 4. **`confidence`** is a per-assertion extraction score. It exists upstream on
 *    the assertion but is deliberately not projected onto a canonical row: a
 *    promoted row has already passed verification and promotion authorization,
 *    so re-exposing an extraction confidence next to it invites reading a
 *    governed value as provisional. Honest `null`.
 *
 * Expect the shadow comparison to report `missing_data` on these until either
 * Phase 4 is extended (2, 3) or the legacy contract drops them (1, 4). That is
 * the projector being truthful, not a defect to route around.
 */
import type { SnapshotReadRowV1 } from '../../defense-budget/promotion/manual-override-overlay-v1.js';

const CANONICAL_ENTITY = 'canonical_rdte_project';

/** The exact shape `getProjects` returns today. */
export interface ProjectedPeProjectRowV1 {
  id: string | null;
  projectCode: string;
  title: string | null;
  mission: string | null;
  budgetActivity: string | null;
  fy: number | null;
  sourceUrl: string | null;
  pageNumber: number | null;
  confidence: number | null;
}

function attr(row: SnapshotReadRowV1, key: string): string | null {
  const value = row.attributes[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Project one PE's R-2A project rows.
 *
 * A row with no resolvable `projectCode` is skipped rather than guessed: the
 * project code is the whole identity of the record, and emitting one without it
 * would produce a row the caller cannot match to anything. The code is read
 * from `attributes` first and falls back to the second segment of the canonical
 * natural key (`peCode|projectCode`), because `buildAttributes` drops any value
 * already consumed by a typed axis and the identity axis is exactly where a
 * natural-key component is consumed.
 *
 * Sorted by `projectCode` to match `getProjects`' existing
 * `orderBy: [{ projectCode: 'asc' }]` exactly.
 */
export function projectPeProjectsV1(
  rows: readonly SnapshotReadRowV1[],
): ProjectedPeProjectRowV1[] {
  const out: ProjectedPeProjectRowV1[] = [];

  for (const row of rows) {
    if (row.canonicalEntity !== CANONICAL_ENTITY) continue;

    const projectCode = attr(row, 'projectCode') ?? row.canonicalNaturalKey.split('|')[1] ?? null;
    if (projectCode == null || projectCode.length === 0) continue;

    out.push({
      id: null,
      projectCode,
      title: attr(row, 'title') ?? row.textValue,
      mission: attr(row, 'mission'),
      budgetActivity: attr(row, 'budgetActivity'),
      fy: null,
      sourceUrl: null,
      pageNumber: null,
      confidence: null,
    });
  }

  out.sort((a, b) => a.projectCode.localeCompare(b.projectCode));
  return out;
}
