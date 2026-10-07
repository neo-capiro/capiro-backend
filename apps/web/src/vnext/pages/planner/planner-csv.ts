import {
  PLANNER_DEFAULT_TASK,
  plannerCalendarDate,
  plannerTime,
  plannerTimeZone,
  plannerScheduledInstant,
  type PlannerPerson,
  type PlannerProject,
  type PlannerTaskData,
} from '@capiro/strategy-verifier';
export type PlannerCsvTask = PlannerTaskData & { importedActualMinutes: number };
/** Asana CSV durations: hh:mm, hours/minutes labels, or a number of hours. */
export function plannerCsvTime(value: string): number {
  const source = value.trim().toLowerCase();
  if (!source) return 0;
  if (source.length > 40) throw new Error('Time values cannot exceed 1,000,000 minutes.');
  let minutes: bigint;
  const clock = /^(\d+):([0-5]\d)$/.exec(source);
  const units = /^(?:(\d+)\s*(?:hr|h)\s*)?(?:(\d+)\s*(?:min|m))?$/.exec(source);
  if (clock) minutes = BigInt(clock[1]!) * 60n + BigInt(clock[2]!);
  else if (units && (units[1] || units[2]))
    minutes = BigInt(units[1] ?? '0') * 60n + BigInt(units[2] ?? '0');
  else if (/^(?:\d+(?:\.\d{0,8})?|\.\d{1,8})$/.test(source)) {
    const [whole, fraction = ''] = source.split('.');
    const divisor = 10n ** BigInt(fraction.length);
    minutes = BigInt(whole || '0') * 60n + (BigInt(fraction || '0') * 60n + divisor / 2n) / divisor;
  } else throw new Error('Use hh:mm, 1hr 30min, 1h 30m, or a number of hours.');
  if (minutes > 1_000_000n) throw new Error('Time values cannot exceed 1,000,000 minutes.');
  return Number(minutes);
}
export function plannerCsvTimeLabel(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}
/** RFC 4180 quoted fields, including embedded commas, quotes and CRLF/newlines. */
export function parsePlannerCsv(source: string): string[][] {
  if (source.length > 2_000_000) throw new Error('CSV files must be smaller than 2 MB.');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let closed = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += c;
      continue;
    }
    if (c === '"') {
      if (cell || closed) throw new Error('A quote must begin a CSV field.');
      quoted = true;
      continue;
    }
    if (c === ',' || c === '\n' || c === '\r') {
      row.push(cell);
      cell = '';
      closed = false;
      if (c !== ',') {
        rows.push(row);
        row = [];
        if (c === '\r' && source[i + 1] === '\n') i++;
      }
      continue;
    }
    if (closed) throw new Error('Unexpected text after a quoted CSV field.');
    cell += c;
  }
  if (quoted) throw new Error('A quoted CSV field is not closed.');
  if (cell || row.length || closed) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((row) => row.some((cell) => cell.trim()));
}
export function importPlannerCsv(
  source: string,
  people: PlannerPerson[],
  project?: PlannerProject,
): PlannerCsvTask[] {
  const rows = parsePlannerCsv(source.replace(/^\uFEFF/, ''));
  if (!rows.length) throw new Error('The CSV is empty.');
  const headers = rows.shift()!.map((h) => h.trim().toLowerCase());
  const allowed = [
    'task',
    'name',
    'description',
    'assignee',
    'start date',
    'due date',
    'start time',
    'due time',
    'time zone',
    'priority',
    'status',
    'section',
    'estimated time',
    'actual time',
  ];
  if (headers.some((h) => !allowed.includes(h)) || new Set(headers).size !== headers.length)
    throw new Error(
      'Use the supported CSV columns: Task, Description, Assignee, Start date, Due date, Start time, Due time, Time zone, Priority, Status, Section, Estimated time, Actual time.',
    );
  if (!headers.includes('task') && !headers.includes('name'))
    throw new Error('The CSV needs a Task or Name column.');
  if (!rows.length || rows.length > 100)
    throw new Error('Import between 1 and 100 tasks at a time.');
  return rows.map((row, i) => {
    if (row.length !== headers.length)
      throw new Error(`Row ${i + 2} has the wrong number of columns.`);
    const get = (name: string) => row[headers.indexOf(name)]?.trim() ?? '';
    const name = get('task') || get('name');
    if (!name || name.length > 500)
      throw new Error(`Row ${i + 2} needs a task name of at most 500 characters.`);
    const description = get('description');
    if (description.length > 50000)
      throw new Error(`Row ${i + 2} has a description that is too long.`);
    const startOn = get('start date') || null,
      dueOn = get('due date') || null;
    if (
      [startOn, dueOn].some((d) => d && !plannerCalendarDate(d)) ||
      (startOn && dueOn && startOn > dueOn)
    )
      throw new Error(`Row ${i + 2} needs valid YYYY-MM-DD dates with start before due.`);
    const startTime = get('start time') || null,
      dueTime = get('due time') || null;
    const timeZone = get('time zone') || null;
    if (
      (startTime && (!startOn || !plannerTime(startTime))) ||
      (dueTime && (!dueOn || !plannerTime(dueTime))) ||
      (timeZone && !plannerTimeZone(timeZone)) ||
      ((startTime || dueTime) && !timeZone)
    )
      throw new Error(`Row ${i + 2} needs HH:mm times, matching dates and a valid IANA time zone.`);
    if (
      startOn &&
      dueOn &&
      startTime &&
      dueTime &&
      timeZone &&
      plannerScheduledInstant(startOn, startTime, timeZone) >
        plannerScheduledInstant(dueOn, dueTime, timeZone)
    )
      throw new Error(`Row ${i + 2} has a start time after its due time.`);
    const assignee = get('assignee');
    const matches = people.filter(
      (p) => p.id === assignee || p.name.toLowerCase() === assignee.toLowerCase(),
    );
    if (assignee && matches.length !== 1)
      throw new Error(`Row ${i + 2}: assignee must match exactly one team member’s name or ID.`);
    const priority = get('priority').toLowerCase() || 'none';
    if (!['none', 'low', 'medium', 'high'].includes(priority))
      throw new Error(`Row ${i + 2} has an unknown priority.`);
    const rawStatus = get('status').toLowerCase();
    const status =
      ((
        {
          'to do': 'todo',
          'in progress': 'in_progress',
          complete: 'done',
          completed: 'done',
        } as Record<string, string>
      )[rawStatus] ??
        rawStatus) ||
      'todo';
    if (!['todo', 'in_progress', 'blocked', 'done'].includes(status))
      throw new Error(`Row ${i + 2} has an unknown status.`);
    const section = get('section');
    const matchingSection = project?.sections.find(
      (s) => s.name.toLowerCase() === section.toLowerCase(),
    );
    if (section && !matchingSection)
      throw new Error(`Row ${i + 2} has a section that does not belong to this project.`);
    let estimateMinutes: number, importedActualMinutes: number;
    try {
      estimateMinutes = plannerCsvTime(get('estimated time'));
      importedActualMinutes = plannerCsvTime(get('actual time'));
    } catch (error) {
      throw new Error(`Row ${i + 2}: ${(error as Error).message}`);
    }
    return {
      ...PLANNER_DEFAULT_TASK,
      estimateMinutes,
      importedActualMinutes,
      startTime,
      dueTime,
      timeZone,
      name,
      description,
      startOn,
      dueOn,
      assigneeId: matches[0]?.id ?? null,
      priority: priority as PlannerTaskData['priority'],
      status: status as PlannerTaskData['status'],
      memberships: project
        ? [{ projectId: project.id, sectionId: matchingSection?.id ?? null, position: i * 1024 }]
        : [],
    };
  });
}
export function plannerCsvCell(value: unknown): string {
  let text = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(text) || /^[\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
