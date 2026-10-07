import { plannerTimesheetWorkRows, type PlannerTimeWorkSource } from './planner-timesheet-work.js';
import type { PlannerTimeEntry } from '@capiro/strategy-verifier';

describe('Weekly work rows', () => {
  const dates = ['2026-10-05', '2026-10-06'];
  const source: PlannerTimeWorkSource = {
    taskId: 'task',
    projectId: 'project',
    taskName: 'Task',
    projectName: 'Project',
    canLogTime: true,
  };
  const entry = {
    id: 'entry',
    taskId: 'task',
    projectId: null,
    minutes: 30,
    time: { workedOn: dates[0], billable: true, projectId: 'project' },
  } as PlannerTimeEntry;
  it('groups complete time entries once, replacing automatic placeholders with tracked work', () => {
    const rows = plannerTimesheetWorkRows(
      dates,
      [
        entry,
        {
          ...entry,
          id: 'second',
          minutes: 15,
          time: { ...entry.time, workedOn: dates[1]!, billable: false },
        },
      ],
      [source],
      [{ ...source, projectId: null }],
      [],
      true,
      () => source,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      origin: 'tracked',
      totalMinutes: 45,
      billableMinutes: 30,
      canRemove: false,
    });
    expect(rows[0]?.days.map((d) => d.totalMinutes)).toEqual([30, 15]);
  });
  it('adds zero-hour work without time and respects week exclusions and edit locks', () => {
    const rows = plannerTimesheetWorkRows(
      dates,
      [],
      [source],
      [{ ...source, taskId: 'other' }],
      ['other'],
      false,
      () => source,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      origin: 'added',
      totalMinutes: 0,
      billableMinutes: 0,
      canLogTime: false,
      canRemove: false,
    });
  });
  it('keeps distinct project allocations for the same task and private personal work', () => {
    const rows = plannerTimesheetWorkRows(
      dates,
      [],
      [
        source,
        { ...source, projectId: 'other' },
        { ...source, taskId: 'personal', projectId: null, projectName: null },
      ],
      [],
      [],
      true,
      () => source,
    );
    expect(new Set(rows.map((r) => r.key)).size).toBe(3);
    expect(rows.every((r) => r.canRemove && r.totalMinutes === 0)).toBe(true);
  });
});
