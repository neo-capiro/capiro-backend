import {
  PLANNER_DEFAULT_TASK,
  nextPlannerSchedule,
  plannerScheduledInstant,
  plannerTaskOverdue,
  plannerDueTimestamp,
  type PlannerTaskData,
} from '@capiro/strategy-verifier';
import { validateTask } from './planner.validation.js';
const task = (patch: Partial<PlannerTaskData>): PlannerTaskData => ({
  ...PLANNER_DEFAULT_TASK,
  name: 'Repeat QA',
  ...patch,
});
const completedAt = new Date('2026-10-08T00:30:00Z');
describe('Planner timed schedules and recurrence', () => {
  it('sorts deadlines by their instant across local calendar dates', () => {
    const late = task({ dueOn: '2026-10-06', dueTime: '20:00', timeZone: 'America/New_York' });
    const early = task({ dueOn: '2026-10-07', dueTime: '08:00', timeZone: 'Asia/Tokyo' });
    expect(plannerDueTimestamp(early)).toBeLessThan(plannerDueTimestamp(late));
    expect(plannerDueTimestamp({ ...late, dueTime: null })).toBeGreaterThan(
      plannerDueTimestamp(late),
    );
    expect(plannerDueTimestamp(task({}))).toBe(Number.POSITIVE_INFINITY);
  });
  it('keeps a monthly month-end anchor and its original duration', () => {
    const first = task({
      dueOn: '2026-01-31',
      startOn: '2026-01-29',
      recurrence: { frequency: 'monthly', interval: 1 },
    });
    const next = nextPlannerSchedule(first, completedAt)!;
    expect(next).toMatchObject({
      dueOn: '2026-02-28',
      startOn: '2026-02-26',
      recurrence: { anchorOn: '2026-01-31' },
    });
    expect(nextPlannerSchedule({ ...first, ...next }, completedAt)).toMatchObject({
      dueOn: '2026-03-31',
      startOn: '2026-03-29',
    });
  });
  it('restores leap day on a later yearly repeat', () => {
    const first = task({ dueOn: '2024-02-29', recurrence: { frequency: 'yearly', interval: 1 } });
    let current = first;
    for (let year = 2025; year <= 2028; year++) {
      current = { ...current, ...nextPlannerSchedule(current, completedAt)! };
      expect(current.dueOn).toBe(`${year}-02-${year === 2028 ? '29' : '28'}`);
    }
  });
  it('uses chosen weekdays in an anchored two-week cycle', () => {
    const first = task({
      dueOn: '2026-10-05',
      recurrence: { frequency: 'weekly', interval: 2, weekdays: [1, 3] },
    });
    const next = nextPlannerSchedule(first, completedAt)!;
    expect(next.dueOn).toBe('2026-10-07');
    expect(nextPlannerSchedule({ ...first, ...next }, completedAt)?.dueOn).toBe('2026-10-19');
  });
  it('anchors completion-based periodic work in the task time zone', () => {
    expect(
      nextPlannerSchedule(
        task({
          dueOn: '2026-10-01',
          timeZone: 'America/Los_Angeles',
          recurrence: { frequency: 'periodically', interval: 3 },
        }),
        completedAt,
      )?.dueOn,
    ).toBe('2026-10-10');
    expect(
      nextPlannerSchedule(
        task({
          dueOn: '2026-10-01',
          timeZone: 'Asia/Tokyo',
          recurrence: { frequency: 'daily', interval: 3, basedOn: 'completion_date' },
        }),
        completedAt,
      )?.dueOn,
    ).toBe('2026-10-11');
  });
  it('includes the end date but stops before a later successor', () => {
    const first = task({
      dueOn: '2026-10-05',
      recurrence: { frequency: 'daily', interval: 1, endsOn: '2026-10-06' },
    });
    const next = nextPlannerSchedule(first, completedAt)!;
    expect(next.dueOn).toBe('2026-10-06');
    expect(nextPlannerSchedule({ ...first, ...next }, completedAt)).toBeNull();
  });
  it('preserves local time across daylight saving changes', () => {
    expect(plannerScheduledInstant('2026-10-31', '09:00', 'America/New_York').toISOString()).toBe(
      '2026-10-31T13:00:00.000Z',
    );
    expect(plannerScheduledInstant('2026-11-01', '09:00', 'America/New_York').toISOString()).toBe(
      '2026-11-01T14:00:00.000Z',
    );
  });
  it('handles daylight saving gaps, folds and half-hour zones deterministically', () => {
    expect(plannerScheduledInstant('2026-03-08', '02:30', 'America/New_York').toISOString()).toBe(
      '2026-03-08T07:30:00.000Z',
    );
    expect(plannerScheduledInstant('2026-11-01', '01:30', 'America/New_York').toISOString()).toBe(
      '2026-11-01T05:30:00.000Z',
    );
    expect(plannerScheduledInstant('2026-10-06', '09:00', 'Asia/Kolkata').toISOString()).toBe(
      '2026-10-06T03:30:00.000Z',
    );
  });
  it('uses due time for overdue work while leaving date-only work open through its day', () => {
    const first = task({ dueOn: '2026-10-07', dueTime: '20:00', timeZone: 'America/Los_Angeles' });
    expect(plannerTaskOverdue(first, completedAt)).toBe(false);
    expect(plannerTaskOverdue(first, new Date('2026-10-08T03:01:00Z'))).toBe(true);
    expect(plannerTaskOverdue({ ...first, dueTime: null }, new Date('2026-10-08T03:01:00Z'))).toBe(
      false,
    );
    expect(plannerTaskOverdue({ ...first, status: 'done' }, new Date('2026-10-10T03:00:00Z'))).toBe(
      false,
    );
  });
  it.each([
    { dueTime: '24:01', dueOn: '2026-10-07', timeZone: 'UTC' },
    { dueTime: '09:00', dueOn: null, timeZone: 'UTC' },
    { dueTime: '09:00', dueOn: '2026-10-07', timeZone: null },
    { dueTime: '09:00', dueOn: '2026-10-07', timeZone: 'Bogus/Zone' },
    {
      startOn: '2026-10-07',
      dueOn: '2026-10-07',
      startTime: '10:00',
      dueTime: '09:00',
      timeZone: 'UTC',
    },
    { dueOn: '2026-10-07', recurrence: { frequency: 'weekly', interval: 1, weekdays: [1, 1] } },
    { dueOn: '2026-10-07', recurrence: { frequency: 'weekly', interval: 1, weekdays: [7] } },
    { dueOn: '2026-10-07', recurrence: { frequency: 'monthly', interval: 1, weekdays: [1] } },
    {
      dueOn: '2026-10-07',
      recurrence: { frequency: 'periodically', interval: 1, basedOn: 'due_date' },
    },
    { dueOn: '2026-10-07', recurrence: { frequency: 'daily', interval: 1, endsOn: '2026-10-06' } },
    {
      dueOn: '2026-10-07',
      recurrence: { frequency: 'daily', interval: 1, anchorOn: '2026-10-08' },
    },
  ])('rejects invalid schedule %j', (patch) => {
    expect(() => validateTask(task(patch as Partial<PlannerTaskData>))).toThrow();
  });
  it('accepts the legacy recurrence contract and date-only tasks without new fields', () => {
    expect(
      validateTask(task({ dueOn: '2026-10-07', recurrence: { frequency: 'weekly', interval: 1 } }))
        .dueTime,
    ).toBeNull();
    expect(
      nextPlannerSchedule(
        task({ dueOn: '2026-10-07', recurrence: { frequency: 'weekly', interval: 1 } }),
        completedAt,
      )?.dueOn,
    ).toBe('2026-10-14');
  });
});
