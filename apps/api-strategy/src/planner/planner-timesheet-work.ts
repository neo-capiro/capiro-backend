import {
  plannerTimeWorkKey,
  type PlannerTimeEntry,
  type PlannerTimesheetWorkRef,
  type PlannerTimesheetWorkRow,
} from '@capiro/strategy-verifier';

export interface PlannerTimeWorkSource extends PlannerTimesheetWorkRef {
  taskName: string | null;
  projectName: string | null;
  canLogTime: boolean;
}
/** Sources have already passed current tenant and task/project authorization. */
export function plannerTimesheetWorkRows(
  dates: string[],
  entries: PlannerTimeEntry[],
  manual: PlannerTimeWorkSource[],
  automatic: PlannerTimeWorkSource[],
  excludedTasks: string[],
  canEditWeek: boolean,
  sourceForEntry: (entry: PlannerTimeEntry) => PlannerTimeWorkSource,
): PlannerTimesheetWorkRow[] {
  const rows = new Map<string, PlannerTimesheetWorkRow>();
  const add = (source: PlannerTimeWorkSource, origin: PlannerTimesheetWorkRow['origin']) => {
    const key = plannerTimeWorkKey(source);
    const existing = rows.get(key);
    if (existing) return existing;
    const row: PlannerTimesheetWorkRow = {
      ...source,
      key,
      origin,
      totalMinutes: 0,
      billableMinutes: 0,
      days: dates.map((date) => ({ date, totalMinutes: 0, billableMinutes: 0 })),
      canLogTime: canEditWeek && source.canLogTime,
      canRemove: canEditWeek,
    };
    rows.set(key, row);
    return row;
  };
  for (const entry of entries) {
    const row = add(sourceForEntry(entry), 'tracked');
    row.totalMinutes += entry.minutes ?? 0;
    if (entry.time.billable) row.billableMinutes += entry.minutes ?? 0;
    const day = row.days.find((d) => d.date === entry.time.workedOn)!;
    day.totalMinutes += entry.minutes ?? 0;
    if (entry.time.billable) day.billableMinutes += entry.minutes ?? 0;
    row.canRemove = false;
  }
  for (const source of manual) add(source, 'added');
  // A tracked or explicitly added allocation replaces its automatic placeholder.
  const includedTasks = new Set([...rows.values()].flatMap((r) => (r.taskId ? [r.taskId] : [])));
  for (const source of automatic)
    if (
      source.taskId &&
      !includedTasks.has(source.taskId) &&
      !excludedTasks.includes(source.taskId)
    )
      add(source, 'automatic');
  return [...rows.values()].sort(
    (a, b) =>
      (a.projectName ?? '').localeCompare(b.projectName ?? '') ||
      (a.taskName ?? '').localeCompare(b.taskName ?? '') ||
      a.key.localeCompare(b.key),
  );
}
