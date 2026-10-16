import { isStrategyStepOverdue } from '@capiro/strategy-verifier';
import {
  addMonths,
  buildColumns,
  columnIndexFor,
  endOfMonth,
  monthsBetween,
  parseDay,
  startOfMonth,
  startOfQuarter,
  timelineHorizonLabel as calendarHorizonLabel,
} from "./report-timeline-calendar.js";
import type {
  TimelineColumn,
  TimelineGranularity,
} from "./report-timeline-calendar.js";
import type { ExecutiveReportSnapshot, ReportNode } from "./report.types.js";

export { parseDay } from "./report-timeline-calendar.js";
export type { TimelineColumn, TimelineGranularity } from "./report-timeline-calendar.js";

/**
 * Shared, renderer-neutral timeline model. The DOCX renderer draws it as a
 * shaded Gantt table and the PPTX renderer draws it with native shapes; both
 * read the same fractions so the two deliverables always agree on placement.
 *
 * Everything here is derived from stored plan dates. No inference: a step with
 * no end date is drawn as a marker, an open-ended step is drawn to the horizon.
 */

const DAY_MS = 86_400_000;
const MAX_MONTH_COLUMNS = 18;
const MAX_QUARTER_COLUMNS = 8;
const MIN_FORWARD_DAYS = 90;
const MIN_BACKWARD_DAYS = 14;

export interface TimelineRow {
  node: ReportNode;
  /** 0..1 position of the bar start within the horizon. */
  startFraction: number;
  /** 0..1 position of the bar end within the horizon. */
  endFraction: number;
  /** Single-day steps (and all milestones/gates) render as a marker. */
  marker: boolean;
  /** The stored end date lies past the drawn horizon. */
  clippedEnd: boolean;
  /** The stored start date lies before the drawn horizon. */
  clippedStart: boolean;
  overdue: boolean;
  /** Column indexes (inclusive) that the bar intersects. */
  firstColumn: number;
  lastColumn: number;
}

export interface TimelineModel {
  granularity: TimelineGranularity;
  startMs: number;
  endMs: number;
  columns: TimelineColumn[];
  rows: TimelineRow[];
  /** 0..1 position of the as-of date, or null when outside the horizon. */
  asOfFraction: number | null;
  /** 0..1 position of the strategy target date, or null when absent/outside. */
  targetFraction: number | null;
  /** Steps that were not drawn because the row budget was exhausted. */
  omittedRows: number;
  /** Columns that were dropped because the plan runs past the drawable span. */
  truncatedHorizon: boolean;
}

export interface TimelineOptions {
  /** Maximum rows to draw; the rest are reported via `omittedRows`. */
  maxRows?: number;
}

export function buildTimelineModel(
  snapshot: ExecutiveReportSnapshot,
  nodes: readonly ReportNode[],
  options: TimelineOptions = {},
): TimelineModel | null {
  const asOfMs = parseDay(snapshot.asOf);
  const dated = nodes.filter((node) => parseDay(node.startsOn) !== null);
  if (dated.length === 0 || asOfMs === null) return null;

  const sorted = [...dated].sort((a, b) => {
    const delta = parseDay(a.startsOn)! - parseDay(b.startsOn)!;
    return delta !== 0 ? delta : a.title.localeCompare(b.title);
  });
  const maxRows = Math.max(1, options.maxRows ?? sorted.length);
  const drawn = sorted.slice(0, maxRows);

  const targetMs = snapshot.strategy.targetDate
    ? parseDay(snapshot.strategy.targetDate)
    : null;

  let earliest = Math.min(
    asOfMs - MIN_BACKWARD_DAYS * DAY_MS,
    ...drawn.map((node) => parseDay(node.startsOn)!),
  );
  let latest = Math.max(
    asOfMs + MIN_FORWARD_DAYS * DAY_MS,
    targetMs ?? Number.NEGATIVE_INFINITY,
    ...drawn.map((node) => nodeEndMs(node, asOfMs)),
  );

  let startMs = startOfMonth(earliest);
  let endMs = endOfMonth(latest);
  let granularity: TimelineGranularity = "month";
  let truncatedHorizon = false;
  const monthSpan = monthsBetween(startMs, endMs);
  if (monthSpan > MAX_MONTH_COLUMNS) {
    granularity = "quarter";
    startMs = startOfQuarter(startMs);
    const quarterSpan = Math.ceil(monthsBetween(startMs, endMs) / 3);
    if (quarterSpan > MAX_QUARTER_COLUMNS) {
      truncatedHorizon = true;
      endMs = addMonths(startMs, MAX_QUARTER_COLUMNS * 3) - 1;
    } else {
      endMs = addMonths(startMs, quarterSpan * 3) - 1;
    }
  }
  // Recompute after rounding so fractions map onto the drawn span exactly.
  earliest = startMs;
  latest = endMs;

  const columns = buildColumns(startMs, endMs, granularity, asOfMs);
  const fraction = (ms: number): number =>
    Math.min(1, Math.max(0, (ms - startMs) / Math.max(1, endMs - startMs)));

  const rows: TimelineRow[] = drawn.map((node) => {
    const rawStart = parseDay(node.startsOn)!;
    const rawEnd = nodeEndMs(node, asOfMs);
    const clippedStart = rawStart < earliest;
    const clippedEnd = rawEnd > latest;
    const singleDay =
      !node.openEnded && (!node.endsOn || node.endsOn === node.startsOn);
    const marker =
      singleDay || node.kind === "milestone" || node.kind === "gate";
    const startFraction = fraction(rawStart);
    const endFraction = marker ? startFraction : fraction(rawEnd);
    const overdue = isStrategyStepOverdue(node, new Date(asOfMs));
    return {
      node,
      startFraction,
      endFraction,
      marker,
      clippedStart,
      clippedEnd,
      overdue,
      firstColumn: columnIndexFor(columns, Math.max(rawStart, startMs)),
      lastColumn: columnIndexFor(
        columns,
        Math.min(marker ? rawStart : rawEnd, endMs),
      ),
    };
  });

  return {
    granularity,
    startMs,
    endMs,
    columns,
    rows,
    asOfFraction:
      asOfMs >= startMs && asOfMs <= endMs ? fraction(asOfMs) : null,
    targetFraction:
      targetMs !== null && targetMs >= startMs && targetMs <= endMs
        ? fraction(targetMs)
        : null,
    omittedRows: sorted.length - drawn.length,
    truncatedHorizon,
  };
}

/** Human label for the drawn horizon, e.g. "Aug 2026 – Mar 2027". */
export function timelineHorizonLabel(model: TimelineModel): string {
  return calendarHorizonLabel(model);
}

function nodeEndMs(node: ReportNode, asOfMs: number): number {
  const start = parseDay(node.startsOn)!;
  if (node.openEnded) {
    // Open-ended work is drawn to at least the near-term horizon so the bar
    // reads as "continuing" rather than as a one-day event.
    return Math.max(start, asOfMs) + MIN_FORWARD_DAYS * DAY_MS;
  }
  const end = node.endsOn ? parseDay(node.endsOn) : null;
  return end === null || end < start ? start : end;
}
