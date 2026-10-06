import { describe, it, expect } from 'vitest';
import { parsePlannerCsv, importPlannerCsv, plannerCsvCell } from './planner-csv.js';
describe('Planner CSV transfers', () => {
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
