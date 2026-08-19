/*
 * Timeline geometry for the vNext Strategies editor.
 *
 * 2026-08-19 (Neo): this now PORTS the legacy planner's own math instead of
 * approximating it. The prior version built its own fiscal axis and rendered
 * bars as CSS-grid cells whose width shrank as the horizon widened (36 months
 * compressed to 46px/month) — legible on paper, but half the width of what
 * `app.capiro.ai/strategies/:id` actually renders (a fixed 100px/month,
 * always horizontally scrolled, never compressed), which is what made every
 * multi-word label read as truncated garbage in side-by-side comparison.
 *
 * The fix is to stop deriving a second, slightly-different fiscal model and
 * instead reuse `pages/strategy/fiscal.ts` directly — the exact module the
 * legacy planner itself is built on. It has no React import and no antd
 * import (verified: zero imports at all), so reusing it does not cross the
 * vNext/no-legacy-UI contract (`no-legacy-ui.contract.test.ts` only flags an
 * edge that reaches antd or a legacy stylesheet — a pure date-math module is
 * not that). Re-exported here so every vNext Strategies file imports fiscal
 * helpers from ONE place, same as before.
 */
export {
  buildCalendar,
  qOfDate,
  qToDate,
  qToDateLabel,
  fyQuarterToQ,
  idxToFyQ,
  quarterStartDateIso,
  quarterIndexOfDate,
  monthLabel,
  nodeRangeLabel,
  monthRangeLabel,
  parseDbDate,
  formatDbDate,
  addMonths,
  monthIndexOf,
  shiftNodeMonths,
  dateToMonthUnits,
  fyOf,
  type FiscalCalendar,
  type QuarterCol,
  type MonthCol,
} from '../../../../pages/strategy/fiscal.js';

/**
 * One item awaiting a lane. `s`/`e` are continuous MONTH-unit floats from the
 * calendar's axis origin (`qToMonth(qOfDate(date, cal))`, i.e. `q * 3`) — NOT
 * whole month indices. That continuity is what lets a bar's box reflect its
 * real date span instead of snapping to the nearest month boundary.
 */
export interface PackItem {
  s: number;
  e: number;
}

export interface Packed<T> {
  _row: number;
  /** `max(e, s + minSpan)` — the end used for BOTH lane packing and the
   * rendered box width, so a short event still gets a legible box instead of
   * a sliver, and two short events close together still land in different
   * lanes if their padded boxes would otherwise collide. */
  _packEnd: number;
}

/**
 * Interval-pack items into the fewest non-overlapping lanes, greedy by start
 * time — ported verbatim from the legacy `StrategyTimeline.tsx` (`packSpans`),
 * which is what both plans this port must match (the legislative band and
 * the strategy-step band) already use in production.
 *
 * `minSpan` (month units) pads a short item's packing/rendered end so its
 * label has room — the legacy legislative band calls this with `1.9`, giving
 * roughly a two-month-wide box at the shared COLW=100 (see strategy-editor.css
 * `--st-col-w`) even for a point-in-time milestone.
 */
export function packSpans<T extends PackItem>(
  items: T[],
  minSpan = 0,
): { items: Array<T & Packed<T>>; rows: number } {
  const rowEnd: number[] = [];
  const sorted = [...items].sort((a, b) => a.s - b.s) as Array<T & Packed<T>>;
  for (const it of sorted) {
    const end = Math.max(it.e, it.s + minSpan);
    it._packEnd = end;
    let row = rowEnd.findIndex((x) => it.s >= x);
    if (row === -1) {
      row = rowEnd.length;
      rowEnd.push(0);
    }
    it._row = row;
    rowEnd[row] = end;
  }
  return { items: sorted, rows: Math.max(1, rowEnd.length) };
}
