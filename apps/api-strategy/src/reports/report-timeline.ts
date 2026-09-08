import { isStrategyStepOverdue } from '@capiro/strategy-verifier';
import type { ExecutiveReportSnapshot, ReportNode } from "./report.types.js";

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

export type TimelineGranularity = "month" | "quarter";

export interface TimelineColumn {
  key: string;
  label: string;
  startMs: number;
  endMs: number;
  /** The column containing the report's as-of date. */
  isCurrent: boolean;
}

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
  const format = new Intl.DateTimeFormat("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  return `${format.format(new Date(model.startMs))} – ${format.format(
    new Date(model.endMs),
  )}`;
}

function buildColumns(
  startMs: number,
  endMs: number,
  granularity: TimelineGranularity,
  asOfMs: number,
): TimelineColumn[] {
  const columns: TimelineColumn[] = [];
  const step = granularity === "month" ? 1 : 3;
  let cursor = startMs;
  while (cursor <= endMs) {
    const next = addMonths(cursor, step);
    const columnEnd = Math.min(next - 1, endMs);
    columns.push({
      key: new Date(cursor).toISOString().slice(0, 7),
      label: columnLabel(cursor, columnEnd, granularity),
      startMs: cursor,
      endMs: columnEnd,
      isCurrent: asOfMs >= cursor && asOfMs <= columnEnd,
    });
    cursor = next;
  }
  return columns;
}

function columnLabel(
  startMs: number,
  endMs: number,
  granularity: TimelineGranularity,
): string {
  const start = new Date(startMs);
  if (granularity === "month") {
    const month = new Intl.DateTimeFormat("en-US", {
      month: "short",
      timeZone: "UTC",
    }).format(start);
    return `${month} ’${String(start.getUTCFullYear()).slice(2)}`;
  }
  const end = new Date(endMs);
  const monthOf = (date: Date) =>
    new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(
      date,
    );
  return `${monthOf(start)}–${monthOf(end)} ${end.getUTCFullYear()}`;
}

function columnIndexFor(columns: TimelineColumn[], ms: number): number {
  const index = columns.findIndex(
    (column) => ms >= column.startMs && ms <= column.endMs,
  );
  if (index >= 0) return index;
  return ms < columns[0]!.startMs ? 0 : columns.length - 1;
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

export function parseDay(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(`${value.slice(0, 10)}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function startOfMonth(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function endOfMonth(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - 1;
}

function startOfQuarter(ms: number): number {
  const date = new Date(ms);
  const quarterMonth = Math.floor(date.getUTCMonth() / 3) * 3;
  return Date.UTC(date.getUTCFullYear(), quarterMonth, 1);
}

function addMonths(ms: number, months: number): number {
  const date = new Date(ms);
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth() + months,
    date.getUTCDate(),
  );
}

function monthsBetween(startMs: number, endMs: number): number {
  const start = new Date(startMs);
  const end = new Date(endMs);
  return (
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (end.getUTCMonth() - start.getUTCMonth()) +
    1
  );
}
