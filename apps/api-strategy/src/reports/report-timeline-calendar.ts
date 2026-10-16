/** UTC calendar and column geometry shared by every report timeline renderer. */
export type TimelineGranularity = "month" | "quarter";

export interface TimelineColumn {
  key: string;
  label: string;
  startMs: number;
  endMs: number;
  /** The column containing the report's as-of date. */
  isCurrent: boolean;
}

/** Human label for the drawn horizon, e.g. "Aug 2026 – Mar 2027". */
export function timelineHorizonLabel(model: {
  startMs: number;
  endMs: number;
}): string {
  const format = new Intl.DateTimeFormat("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  return `${format.format(new Date(model.startMs))} – ${format.format(
    new Date(model.endMs),
  )}`;
}

export function buildColumns(
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

export function columnIndexFor(columns: TimelineColumn[], ms: number): number {
  const index = columns.findIndex(
    (column) => ms >= column.startMs && ms <= column.endMs,
  );
  if (index >= 0) return index;
  return ms < columns[0]!.startMs ? 0 : columns.length - 1;
}

export function parseDay(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(`${value.slice(0, 10)}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

export function startOfMonth(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

export function endOfMonth(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - 1;
}

export function startOfQuarter(ms: number): number {
  const date = new Date(ms);
  const quarterMonth = Math.floor(date.getUTCMonth() / 3) * 3;
  return Date.UTC(date.getUTCFullYear(), quarterMonth, 1);
}

export function addMonths(ms: number, months: number): number {
  const date = new Date(ms);
  return Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth() + months,
    date.getUTCDate(),
  );
}

export function monthsBetween(startMs: number, endMs: number): number {
  const start = new Date(startMs);
  const end = new Date(endMs);
  return (
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (end.getUTCMonth() - start.getUTCMonth()) +
    1
  );
}
