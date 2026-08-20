/*
 * Timeline model (STRATEGIES-HANDOFF §7.3) — pure, testable geometry for the
 * strategy timeline editor.
 *
 * Axis: a span of whole months across the firm's fiscal window (default FY27–FY29,
 * 36 months). The federal fiscal year starts in October, so FY27 = Oct 2026 …
 * Sep 2027. Fiscal-year boundaries are derived from that rule, never hard-coded
 * to calendar years. When the calendar service exposes explicit fiscal
 * boundaries, they should be threaded through `fiscalYearStartMonth`.
 *
 * Lane assignment is computed from overlap within each row group (§7.3, §4.1 #6):
 * steps are never hand-placed and the lane index is never persisted. Ordering is
 * stable across renders so cards do not jump.
 */

export interface MonthCell {
  /** Index in the axis, 0-based. */
  index: number;
  /** Calendar year of this month. */
  year: number;
  /** Calendar month 1–12. */
  month: number;
  /** Fiscal year this month belongs to. */
  fy: number;
  /** Short month label (OCT, NOV, …). */
  label: string;
  /** True when this month is the first of a fiscal year (boundary line). */
  fiscalYearStart: boolean;
}

export interface TimelineAxis {
  cells: MonthCell[];
  startFy: number;
  endFy: number;
  /** First day of the axis (UTC). */
  start: Date;
  /** First day after the axis (UTC). */
  end: Date;
}

const MONTH_LABELS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/**
 * Build a month axis across fiscal years [startFy, endFy] inclusive.
 * `fiscalYearStartMonth` is the calendar month a fiscal year begins (10 = October,
 * the US federal convention). FY27 = Oct 2026 … Sep 2027.
 */
export function buildFiscalAxis(startFy: number, endFy: number, fiscalYearStartMonth = 10): TimelineAxis {
  const cells: MonthCell[] = [];
  // Calendar year in which startFy begins: FY(startFy) begins in calendar (startFy-1)
  // when the fiscal year starts after January.
  const firstCalYear = fiscalYearStartMonth === 1 ? startFy : startFy - 1;
  const start = new Date(Date.UTC(firstCalYear, fiscalYearStartMonth - 1, 1));
  const monthCount = (endFy - startFy + 1) * 12;
  for (let i = 0; i < monthCount; i++) {
    const d = new Date(Date.UTC(firstCalYear, fiscalYearStartMonth - 1 + i, 1));
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const fy = month >= fiscalYearStartMonth ? year + 1 : year;
    cells.push({
      index: i,
      year,
      month,
      fy,
      label: MONTH_LABELS[month - 1]!,
      fiscalYearStart: month === fiscalYearStartMonth,
    });
  }
  const end = new Date(Date.UTC(firstCalYear, fiscalYearStartMonth - 1 + monthCount, 1));
  return { cells, startFy, endFy, start, end };
}

/** Fraction [0,1] of the way through the axis for a date (clamped). */
export function axisPosition(axis: TimelineAxis, date: Date): number {
  const span = axis.end.getTime() - axis.start.getTime();
  if (span <= 0) return 0;
  const t = (date.getTime() - axis.start.getTime()) / span;
  return Math.min(1, Math.max(0, t));
}

/* ─────────────────────────────────────────────────────────────────────────
 * Column geometry (design handoff `.dc.html` "Working timeline").
 *
 * The reference design does NOT position bars as a percentage of a free
 * track — it lays every row out as a CSS grid of `repeat(n, minmax(colW,1fr))`
 * month columns and places each bar with `grid-column: <start> / span <n>`.
 * That is what makes bars sit exactly under their month tick at every
 * viewport, and what stops a label from spilling past the bar it belongs to:
 * the grid area IS the bar's box.
 *
 * axisPosition above is still the right model for the TODAY marker, which is a
 * continuous position on the axis, not a month cell. Both share one axis, so
 * they cannot drift. The old percentage bar geometry and its timestamp-based
 * lane packer went with the free track they served.
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * The federal fiscal year containing `now` (FY starts in October).
 *
 * This is the same rule the strategy service uses to anchor everything it
 * generates (`apps/api-strategy/src/fiscal/fiscal.ts` fyOf / currentFyWindow):
 * the reference calendars, the PPBE lanes and the firm phases are all
 * materialized against `[fyOf(now), +1, +2]`. The editor axis has to be
 * derived the same way or it renders those rows against a window they were
 * never built for. Computed in UTC to match buildFiscalAxis's own frame.
 */
export function currentFiscalYear(now: Date = new Date(), fiscalYearStartMonth = 10): number {
  const month = now.getUTCMonth() + 1;
  return month >= fiscalYearStartMonth ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
}

/** Month-column index of a date on this axis. Negative / >= cells.length when off-axis. */
export function monthIndexOf(axis: TimelineAxis, date: Date): number {
  return (
    (date.getUTCFullYear() - axis.start.getUTCFullYear()) * 12 +
    (date.getUTCMonth() - axis.start.getUTCMonth())
  );
}

export interface ColumnSpan {
  /** 0-based first month column. */
  start: number;
  /** Number of month columns, >= 1. */
  span: number;
  clippedStart: boolean;
  clippedEnd: boolean;
  /** Columns the bar would occupy on its real dates, before any `minSpan` padding. */
  trueSpan: number;
}

/**
 * Month-column geometry for a dated bar, clipped (never dropped) at the axis
 * edges. Returns null only when the bar lies entirely outside the window.
 *
 * `minSpan` widens a bar that is too narrow to render its own label — a
 * point-in-time step (a gate with no end date) would otherwise be a ~46px
 * sliver with its title clipped to two characters. The pre-padding width is
 * returned as `trueSpan` so callers can still tell a real one-month bar from a
 * padded instant; the exact dates stay authoritative in the inspector.
 */
export function columnSpan(
  axis: TimelineAxis,
  startIso: string | null,
  endIso: string | null,
  minSpan = 1,
): ColumnSpan | null {
  const startDate = startIso ? new Date(startIso) : null;
  const endDate = endIso ? new Date(endIso) : null;
  const s = startDate && !Number.isNaN(startDate.getTime()) ? startDate : endDate;
  const e = endDate && !Number.isNaN(endDate.getTime()) ? endDate : startDate;
  if (!s || !e || Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return null;

  const n = axis.cells.length;
  const rawStart = monthIndexOf(axis, s);
  const rawEnd = Math.max(rawStart, monthIndexOf(axis, e));
  if (rawEnd < 0 || rawStart > n - 1) return null;

  const clippedStart = rawStart < 0;
  const clippedEnd = rawEnd > n - 1;
  let start = Math.max(0, rawStart);
  let end = Math.min(n - 1, rawEnd);
  const trueSpan = end - start + 1;

  // Pad a too-narrow bar to `minSpan`, preferring to grow rightward so the
  // bar still begins on the month it really begins on.
  let span = trueSpan;
  if (span < minSpan) {
    end = Math.min(n - 1, start + minSpan - 1);
    span = end - start + 1;
    if (span < minSpan) {
      start = Math.max(0, end - minSpan + 1);
      span = end - start + 1;
    }
  }
  return { start, span, clippedStart, clippedEnd, trueSpan };
}

export interface ColumnLaneItem {
  id: string;
  start: number;
  span: number;
}

/**
 * Lane assignment over COLUMN ranges rather than raw dates.
 *
 * assignLanes() above partitions by timestamp, which is right for a
 * continuous track but wrong for a month grid: "Floor & amendments"
 * (Jul 1 – Aug 17) and "Conference" (Aug 17 – Sep 22) do not overlap as dates
 * yet both occupy the August column, so laning them by date puts two bars in
 * the same grid cell and one covers the other. Laning by column is the only
 * partition that matches what is actually drawn.
 */
export function assignColumnLanes<T extends ColumnLaneItem>(items: T[]): Array<{ item: T; lane: number }> {
  const sorted = [...items].sort((a, b) => (a.start - b.start) || a.id.localeCompare(b.id));
  const laneEnds: number[] = [];
  const out: Array<{ item: T; lane: number }> = [];
  for (const item of sorted) {
    const end = item.start + item.span - 1;
    let lane = laneEnds.findIndex((laneEnd) => laneEnd < item.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[lane] = end;
    }
    out.push({ item, lane });
  }
  return out;
}

export function columnLaneCount<T extends ColumnLaneItem>(laned: Array<{ item: T; lane: number }>): number {
  return laned.reduce((n, l) => Math.max(n, l.lane + 1), 0);
}

/* ------------------------------------------------------------ date edits */

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Days in a UTC month (month is 1-12). */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** `YYYY-MM-DD` for a Date, in the UTC frame the axis uses. */
export function toDateOnly(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * Shift an ISO date by whole months, preserving day-of-month and clamping to
 * the target month's length (Jan 31 + 1mo -> Feb 28/29, never Mar 3).
 *
 * Dragging a bar moves it by whole COLUMNS, so applying the delta to the real
 * stored date is what keeps a milestone dated the 29th on the 29th. Snapping
 * bars to the 1st of a month on every save would quietly rewrite dates the
 * user never touched.
 */
export function shiftIsoMonths(iso: string, months: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const targetMonthIndex = d.getUTCMonth() + months;
  const year = d.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
  const month = ((targetMonthIndex % 12) + 12) % 12 + 1;
  const day = Math.min(d.getUTCDate(), daysInMonth(year, month));
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** First day of the month at `index` on this axis, as `YYYY-MM-DD`. */
export function monthStartIso(axis: TimelineAxis, index: number): string {
  const cell = axis.cells[Math.min(Math.max(index, 0), axis.cells.length - 1)]!;
  return `${cell.year}-${pad2(cell.month)}-01`;
}

/** Last day of the month at `index` on this axis, as `YYYY-MM-DD`. */
export function monthEndIso(axis: TimelineAxis, index: number): string {
  const cell = axis.cells[Math.min(Math.max(index, 0), axis.cells.length - 1)]!;
  return `${cell.year}-${pad2(cell.month)}-${pad2(daysInMonth(cell.year, cell.month))}`;
}
