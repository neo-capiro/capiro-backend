/**
 * Phase 7 Workstream M — projecting `canonical_rdte_budget_position` rows into
 * `getBudgetPositions`'/`getPbComparison`'s existing response shape.
 *
 * This is the cleanest 1:1 canonical mapping on the whole PE read surface (see
 * the registry entry for `rdte:ProgramElementBudgetPosition`), which is why it
 * is migrated first: it proves the projector pattern with the least amount of
 * novel business logic to review.
 *
 * Two things worth knowing before touching this file:
 *
 * 1. **The Phase 4 RDT&E projector always names the number "amount," regardless
 *    of `valueKind`.** `rdte-projection-planner-v1.ts` puts `valueMillions` into
 *    `values.amount` for both `'total'` and `'quantity'` rows, so both kinds'
 *    numbers travel through the canonical row's `money` axis identically. This
 *    projector is what splits that back onto the legacy contract's two separate
 *    columns (`amount` for `'total'`, `quantity` for `'quantity'`) — it is an
 *    inferred mapping, not something the upstream candidate states directly,
 *    because no real promotion has run yet to confirm it against actual data
 *    (see the session-7 handoff). Re-check this against a real promoted
 *    quantity-kind row the first time one exists.
 * 2. **`sourceUrl`/`pageNumber` have no upstream source for this entity at
 *    all.** The Phase 4 budget-position candidate's `values` bag never sets
 *    them (unlike the performer candidate, which does) — confirmed by reading
 *    the projection planner directly. They are honest `null`s here, not a
 *    projector bug, and are expected to surface as a `missing_data` shadow
 *    finding until Phase 4 is extended to carry them for this entity.
 */
import type { BudgetPositionLike } from '../budget-position.js';
import type { SnapshotReadRowV1 } from '../../defense-budget/promotion/manual-override-overlay-v1.js';

const CANONICAL_ENTITY = 'canonical_rdte_budget_position';

/** The exact shape `getBudgetPositions` returns today. */
export interface ProjectedBudgetPositionRowV1 {
  positionCycle: string;
  assertedFy: number;
  amount: string | null;
  quantity: string | null;
  valueKind: string;
  sourceUrl: string | null;
  pageNumber: number | null;
}

/**
 * Project one PE's budget-position rows. Rows missing `positionCycle`,
 * `valueKind`, or a fiscal year cannot be mapped onto the legacy row's
 * identity and are skipped rather than guessed — an upstream projection gap
 * should surface as a missing row (a real, honest `missing_data` shadow
 * finding), not as a row with an invented cycle or kind.
 *
 * Sorted to match `getBudgetPositions`' existing `orderBy`
 * (`assertedFy asc, positionCycle asc, valueKind asc`) exactly.
 */
export function projectPeBudgetPositionsV1(
  rows: readonly SnapshotReadRowV1[],
): ProjectedBudgetPositionRowV1[] {
  const out: ProjectedBudgetPositionRowV1[] = [];

  for (const row of rows) {
    if (row.canonicalEntity !== CANONICAL_ENTITY) continue;

    const positionCycle =
      typeof row.attributes.positionCycle === 'string' ? row.attributes.positionCycle : null;
    const valueKind =
      typeof row.attributes.valueKind === 'string' ? row.attributes.valueKind : null;
    const assertedFy = row.fiscalYear;
    if (positionCycle == null || valueKind == null || assertedFy == null) continue;

    const numericValue = row.money?.valueMillions ?? null;

    out.push({
      positionCycle,
      assertedFy,
      amount: valueKind === 'quantity' ? null : numericValue,
      quantity: valueKind === 'quantity' ? numericValue : null,
      valueKind,
      sourceUrl: null,
      pageNumber: null,
    });
  }

  out.sort(
    (a, b) =>
      a.assertedFy - b.assertedFy ||
      a.positionCycle.localeCompare(b.positionCycle) ||
      a.valueKind.localeCompare(b.valueKind),
  );
  return out;
}

/**
 * Narrows a projected row set to what `computePbComparison` needs. The helper
 * already coerces its own `amount` internally (`toAmount`, pre-existing,
 * accepted behavior) — this hands it the exact decimal string unmodified.
 * `getPbComparison` itself additionally filters to `valueKind === 'total'`
 * only, matching the legacy query; that filter is left to the caller rather
 * than duplicated here, since the two callers of this projector want different
 * subsets of the same rows.
 */
export function toBudgetPositionLikeV1(
  rows: readonly ProjectedBudgetPositionRowV1[],
): BudgetPositionLike[] {
  return rows.map((row) => ({
    positionCycle: row.positionCycle,
    assertedFy: row.assertedFy,
    amount: row.amount,
    valueKind: row.valueKind,
  }));
}
