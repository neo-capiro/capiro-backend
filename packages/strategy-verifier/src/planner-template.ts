import type { PlannerTemplateData } from './planner.js';

/** Calendar dates are computed in UTC so the viewer's zone never moves them. */
export function plannerRelativeDate(anchor: string, offset: number | null, skipWeekends: boolean) {
  if (offset === null) return null;
  const date = new Date(`${anchor}T00:00:00Z`);
  const direction = offset < 0 ? -1 : 1;
  let remaining = Math.abs(offset);
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + direction);
    if (!skipWeekends || ![0, 6].includes(date.getUTCDay())) remaining--;
  }
  // A zero offset on a weekend uses the next workday.
  if (skipWeekends)
    while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() + direction);
  return date.toISOString().slice(0, 10);
}

export function plannerTemplateSchedule(
  config: PlannerTemplateData,
  anchorOn: string,
): PlannerTemplateData {
  const schedule = config.schedule;
  if (!schedule) return config;
  const dates = schedule.dates.map((date) => ({
    startOn: plannerRelativeDate(anchorOn, date.startOffset, schedule.skipWeekends),
    dueOn: plannerRelativeDate(anchorOn, date.dueOffset, schedule.skipWeekends),
  }));
  const all = dates
    .flatMap((date) => [date.startOn, date.dueOn])
    .filter((date): date is string => Boolean(date))
    .sort();
  const projectDates = [...all, anchorOn].sort();
  return {
    ...config,
    project: {
      ...config.project,
      startOn: projectDates[0]!,
      dueOn: projectDates.at(-1)!,
    },
    tasks: config.tasks.map((task, index) => {
      const datesForTask = dates[index]!;
      return {
        ...task,
        ...datesForTask,
        startTime: datesForTask.startOn ? task.startTime : null,
        dueTime: datesForTask.dueOn ? task.dueTime : null,
        recurrence:
          task.recurrence && datesForTask.dueOn
            ? {
                ...task.recurrence,
                anchorOn: datesForTask.dueOn,
                endsOn:
                  task.recurrence.endsOn && task.dueOn
                    ? plannerRelativeDate(
                        datesForTask.dueOn,
                        Math.round(
                          (Date.parse(task.recurrence.endsOn) - Date.parse(task.dueOn)) / 86400000,
                        ),
                        false,
                      )
                    : null,
              }
            : null,
      };
    }),
  };
}
