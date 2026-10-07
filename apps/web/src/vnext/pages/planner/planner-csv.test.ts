import { describe, it, expect } from 'vitest';
import { parsePlannerCsv, importPlannerCsv, plannerCsvCell } from './planner-csv.js';
describe('Planner CSV transfers', () => {
  it('imports timed schedules and rejects missing zones or inverted times', () => {
    const columns = 'Task,Start date,Due date,Start time,Due time,Time zone\n';
    expect(
      importPlannerCsv(columns + 'One,2026-10-07,2026-10-07,08:00,09:30,America/New_York', [])[0],
    ).toMatchObject({
      startTime: '08:00',
      dueTime: '09:30',
      timeZone: 'America/New_York',
    });
    expect(() =>
      importPlannerCsv(columns + 'One,2026-10-07,2026-10-07,10:00,09:30,UTC', []),
    ).toThrow();
    expect(() =>
      importPlannerCsv(columns + 'One,2026-10-07,2026-10-07,08:00,09:30,', []),
    ).toThrow();
    expect(() =>
      importPlannerCsv(columns + 'One,2026-10-07,2026-10-07,08:00,09:30,Bad/Zone', []),
    ).toThrow();
  });
  it('reads commas, escaped quotes and newlines inside a quoted field', () =>
    expect(
      parsePlannerCsv('Task,Description\r\n"Review, approve","Say ""yes""\nthen launch"\r\n'),
    ).toEqual([
      ['Task', 'Description'],
      ['Review, approve', 'Say "yes"\nthen launch'],
    ]));
  it('rejects malformed quoting and inconsistent rows', () => {
    expect(() => parsePlannerCsv('Task\n"Unclosed')).toThrow();
    expect(() => importPlannerCsv('Task,Description\nOne,Two,Three', [])).toThrow();
  });
  it('rejects ambiguous assignees and impossible dates before creating any task', () => {
    expect(() =>
      importPlannerCsv('Task,Assignee\nOne,Alex', [
        { id: '1', name: 'Alex' },
        { id: '2', name: 'Alex' },
      ]),
    ).toThrow();
    expect(() => importPlannerCsv('Task,Due date\nOne,2026-02-30', [])).toThrow();
  });
  it('maps supported values and protects exported spreadsheet formulas', () => {
    expect(importPlannerCsv('Task,Status,Priority\nOne,In progress,High', [])[0]).toMatchObject({
      name: 'One',
      status: 'in_progress',
      priority: 'high',
    });
    expect(plannerCsvCell('=HYPERLINK("evil")')).toBe('"\'=HYPERLINK(""evil"")"');
  });
});
