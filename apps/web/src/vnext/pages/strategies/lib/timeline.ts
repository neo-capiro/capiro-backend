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

/**
 * Geometry for a dated bar: left/width as percentages of the axis. A bar partly
 * outside the range is CLIPPED to the visible range, never dropped (§7.3).
 * Returns null only when the bar is entirely outside the axis.
 */
export function barGeometry(
  axis: TimelineAxis,
  startIso: string | null,
  endIso: string | null,
): { left: number; width: number; clippedStart: boolean; clippedEnd: boolean } | null {
  const start = startIso ? new Date(startIso) : null;
  const end = endIso ? new Date(endIso) : null;
  const s = start && !Number.isNaN(start.getTime()) ? start : end;
  const e = end && !Number.isNaN(end.getTime()) ? end : start;
  if (!s || !e) return null;
  if (e.getTime() < axis.start.getTime() || s.getTime() > axis.end.getTime()) return null;
  const clippedStart = s.getTime() < axis.start.getTime();
  const clippedEnd = e.getTime() > axis.end.getTime();
  const left = axisPosition(axis, s) * 100;
  const right = axisPosition(axis, e) * 100;
  // A point-in-time (due date) still renders a sliver so it stays visible.
  const width = Math.max(0.6, right - left);
  return { left, width: Math.min(100 - left, width), clippedStart, clippedEnd };
}

/** A bar that needs a lane. Generic over the carried payload. */
export interface LaneItem {
  id: string;
  startIso: string | null;
  endIso: string | null;
}

export interface LanedItem<T extends LaneItem> {
  item: T;
  lane: number;
}

function dayMs(iso: string | null, fallback: number): number {
  if (!iso) return fallback;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? fallback : t;
}

/**
 * Assign lanes so no two overlapping bars collide (§4.1 #6). Greedy interval
 * partitioning; input is sorted by (start, id) for stable, jump-free output.
 */
export function assignLanes<T extends LaneItem>(items: T[]): LanedItem<T>[] {
  const sorted = [...items].sort((a, b) => {
    const d = dayMs(a.startIso, 0) - dayMs(b.startIso, 0);
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });
  const laneEnds: number[] = [];
  const out: LanedItem<T>[] = [];
  for (const item of sorted) {
    const start = dayMs(item.startIso, 0);
    const end = dayMs(item.endIso, start);
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start);
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

export function laneCount<T extends LaneItem>(laned: LanedItem<T>[]): number {
  return laned.reduce((n, l) => Math.max(n, l.lane + 1), 0);
}
