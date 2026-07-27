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
  /** Left edge of the rendered grid range, px from the content's left edge. */
  rangeStartX: number;
  /** Right edge of the rendered grid range, px from the content's left edge. */
  rangeEndX: number;
  /** Visible width of the horizontal grid scroller (clientWidth). */
  viewportWidth: number;
  /** Total scrollable width of the grid content (scrollWidth). */
  contentWidth: number;
}

const finite = (n: number) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

/**
 * The clamped `scrollLeft` that puts today in view.
 *
 * - today inside the rendered range → centered in the viewport;
 * - today before the range → `0`;
 * - today after the range → `maxScrollLeft`;
 * - always clamped to `[0, contentWidth - viewportWidth]`, so a content width
 *   at or below the viewport width (nothing to scroll) yields `0`.
 */
export function todayScrollLeft(input: TodayScrollInput): number {
  const todayX = finite(input.todayX);
  const rangeStartX = finite(input.rangeStartX);
  const rangeEndX = finite(input.rangeEndX);
  const viewportWidth = Math.max(0, finite(input.viewportWidth));
  const contentWidth = Math.max(0, finite(input.contentWidth));

  const maxScrollLeft = Math.max(0, contentWidth - viewportWidth);
  if (maxScrollLeft === 0) return 0;

  if (todayX < rangeStartX) return 0;
  if (todayX > rangeEndX) return maxScrollLeft;

  // Center today in the visible grid viewport, then clamp.
  const centered = todayX - viewportWidth / 2;
  return Math.min(maxScrollLeft, Math.max(0, centered));
}
