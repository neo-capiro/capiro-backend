/*
 * Deterministic horizontal positioning for the working timeline.
 *
 * Pure by design: no DOM, no React. The caller measures the grid AFTER layout
 * and passes plain numbers in, so every clamping rule is unit-testable without
 * a layout engine — and the "center today" decision can never silently depend
 * on an arbitrary column count the way the previous mount-time approximation
 * (`mLeft(TODAY_M) - COLW * 1.5`) did.
 */

export interface TodayScrollInput {
  /** Today's x offset inside the grid content, px from the content's left edge. */
  todayX: number;
  /** Visible width of the horizontal grid scroller (clientWidth). */
  viewportWidth: number;
  /** Total scrollable width of the grid content (scrollWidth). */
  contentWidth: number;
}

const finite = (n: number) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

/**
 * The clamped `scrollLeft` that puts today in view: today centred in the
 * viewport, bounded to `[0, contentWidth - viewportWidth]` so a content width
 * at or below the viewport width (nothing to scroll) yields `0`.
 *
 * This used to carry two more branches — `todayX < rangeStartX → 0` and
 * `todayX > rangeEndX → maxScrollLeft` — meant to handle a plan lying entirely
 * outside the rendered range. They were **unreachable**: the only caller passes
 * the RENDERED AXIS as the range, and `buildCalendar` always builds that axis
 * as three fiscal years anchored on today, so today is always inside it. The
 * export/crop path never reaches here either (the centring effect returns early
 * when `isExport`). Only the pure-function unit tests, which passed numbers in
 * directly, ever exercised them. Removed in Phase 7 per Lia: an unreachable
 * clamp is dead code, not intended behaviour.
 *
 * The `[0, maxScrollLeft]` bound below is NOT that dead code — it is reachable
 * and necessary (today near either end of a real plan).
 */
export function todayScrollLeft(input: TodayScrollInput): number {
  const todayX = finite(input.todayX);
  const viewportWidth = Math.max(0, finite(input.viewportWidth));
  const contentWidth = Math.max(0, finite(input.contentWidth));

  const maxScrollLeft = Math.max(0, contentWidth - viewportWidth);
  if (maxScrollLeft === 0) return 0;

  const centered = todayX - viewportWidth / 2;
  return Math.min(maxScrollLeft, Math.max(0, centered));
}
