import { describe, it, expect } from 'vitest';
import {
  parsePlannerCsv,
  importPlannerCsv,
  plannerCsvCell,
  plannerCsvTime,
  plannerCsvTimeLabel,
} from './planner-csv.js';
describe('Planner CSV transfers', () => {
  it('accepts clock, labeled and numeric-hour time formats without confusing hours with minutes', () => {
    for (const value of ['1:30', '1hr 30min', '1h 30m', '1.5'])
      expect(plannerCsvTime(value)).toBe(90);
    expect(plannerCsvTime('15')).toBe(900);
    expect(plannerCsvTime('.5')).toBe(30);
    expect(plannerCsvTime('1.')).toBe(60);
    expect(plannerCsvTime('45min')).toBe(45);
    expect(plannerCsvTime('0')).toBe(0);
    expect(plannerCsvTime('')).toBe(0);
    expect(plannerCsvTime('0.00833333')).toBe(0);
    expect(plannerCsvTime('0.00833334')).toBe(1);
    expect(plannerCsvTimeLabel(901)).toBe('15:01');
    expect(plannerCsvTime(plannerCsvTimeLabel(1_000_000))).toBe(1_000_000);
  });
  it('rejects malformed, negative, exponent and oversized time before creating tasks', () => {
    for (const value of [
      '1:60',
      '1:3',
      '-1',
      '+2',
      '1e3',
      '1h garbage',
      'NaN',
      'Infinity',
      '20000',
      '1m 1h',
      '9'.repeat(41),
    ])
      expect(() => plannerCsvTime(value)).toThrow();
    expect(() => importPlannerCsv('Task,Estimated time\nOne,1h\nTwo,1:99', [])).toThrow('Row 3');
  });
  it('preserves per-task estimates and actual totals in exported time columns', () => {
    const rows = importPlannerCsv(
      'Task,Estimated time,Actual time\nOne,2hr 15min,1:30\nTwo,15,0',
      [],
    );
    expect(rows[0]).toMatchObject({ estimateMinutes: 135, importedActualMinutes: 90 });
    expect(rows[1]).toMatchObject({ estimateMinutes: 900, importedActualMinutes: 0 });
    expect(importPlannerCsv('Task\nLegacy', [])[0]).toMatchObject({
      estimateMinutes: 0,
      importedActualMinutes: 0,
    });
  });
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
