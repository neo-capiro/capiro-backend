import {
  plannerCapacityDateShift,
  type PlannerCapacityAllocation,
} from '@capiro/strategy-verifier';

type Column = { start: string; end: string };
export type CapacityColumnBounds = Column & { left: number; width: number };
const ordinal = (date: string) => Date.parse(`${date}T12:00:00Z`) / 86400000;

/** Calendar cells include weekends; effort remains distributed over workdays. */
export function capacityDateAt(x: number, columns: CapacityColumnBounds[]) {
  const column = columns.find((c) => x < c.left + c.width) ?? columns.at(-1);
  if (!column || !Number.isFinite(x) || !Number.isFinite(column.width) || column.width <= 0)
    throw new Error('The timeline changed. Try moving again.');
  const days = ordinal(column.end) - ordinal(column.start) + 1;
  const offset = Math.max(
    0,
    Math.min(days - 1, Math.floor(((x - column.left) / column.width) * days)),
  );
  return plannerCapacityDateShift(column.start, offset);
}

/** Each zoom column has equal display width, even when calendar months have different lengths. */
export function capacityAllocationLayout(rows: PlannerCapacityAllocation[], columns: Column[]) {
  if (!columns.length) return [];
  const first = ordinal(columns[0]!.start),
    last = ordinal(columns.at(-1)!.end) + 1;
  const position = (date: number) => {
    if (date <= first) return 0;
    if (date >= last) return 100;
    const index = columns.findIndex((c) => date <= ordinal(c.end));
    const c = columns[index]!;
    return (
      ((index + (date - ordinal(c.start)) / (ordinal(c.end) - ordinal(c.start) + 1)) /
        columns.length) *
      100
    );
  };
  const lanes: number[] = [];
  return rows
    .filter((a) => ordinal(a.data.startOn) < last && ordinal(a.data.endOn) >= first)
    .slice()
    .sort(
      (a, b) =>
        a.data.startOn.localeCompare(b.data.startOn) ||
        b.data.endOn.localeCompare(a.data.endOn) ||
        a.id.localeCompare(b.id),
    )
    .map((allocation) => {
      const start = Math.max(first, ordinal(allocation.data.startOn));
      const end = Math.min(last, ordinal(allocation.data.endOn) + 1);
      let lane = lanes.findIndex((value) => value <= start);
      if (lane < 0) lane = lanes.length;
      lanes[lane] = end;
      const left = position(start);
      return { allocation, lane, left, width: position(end) - left };
    });
}
