import { PLANNER_DEFAULT_TASK, type PlannerDateRule } from '@capiro/strategy-verifier';
import { plannerDateRuleReady } from './planner-date-rules.js';
import { validateResource } from './planner-resources.js';
const task = {
  ...PLANNER_DEFAULT_TASK,
  name: 'Date rule',
  dueOn: '2026-11-02',
  timeZone: 'America/New_York',
};
const approaching: PlannerDateRule = {
  trigger: 'due_approaching',
  schedule: { amount: 1, unit: 'days' },
};
describe('Planner scheduled date rules', () => {
  it('starts date-only approaching rules at local midnight across the DST fold and stops after due day', () => {
    expect(plannerDateRuleReady(task, approaching, new Date('2026-11-01T03:59:59Z'))).toBe(false);
    expect(plannerDateRuleReady(task, approaching, new Date('2026-11-01T04:00:00Z'))).toBe(true);
    expect(plannerDateRuleReady(task, approaching, new Date('2026-11-03T05:00:00Z'))).toBe(false);
  });
  it('uses calendar days for wall-clock dates, elapsed minutes for timed reminders, and ignores completed work', () => {
    const timed = { ...task, dueTime: '09:00' };
    expect(plannerDateRuleReady(timed, approaching, new Date('2026-11-01T13:59:59Z'))).toBe(false);
    expect(plannerDateRuleReady(timed, approaching, new Date('2026-11-01T14:00:00Z'))).toBe(true);
    const hour: PlannerDateRule = {
      trigger: 'due_approaching',
      schedule: { amount: 60, unit: 'minutes' },
    };
    expect(plannerDateRuleReady(timed, hour, new Date('2026-11-02T12:59:59Z'))).toBe(false);
    expect(plannerDateRuleReady(timed, hour, new Date('2026-11-02T13:00:00Z'))).toBe(true);
    expect(
      plannerDateRuleReady({ ...timed, status: 'done' }, hour, new Date('2026-11-02T13:30:00Z')),
    ).toBe(false);
  });
  it('date-only overdue begins on the following local day and timed overdue respects its offset', () => {
    const overdue: PlannerDateRule = { trigger: 'overdue', schedule: { amount: 0, unit: 'days' } };
    expect(plannerDateRuleReady(task, overdue, new Date('2026-11-03T04:59:59Z'))).toBe(false);
    expect(plannerDateRuleReady(task, overdue, new Date('2026-11-03T05:00:00Z'))).toBe(true);
    expect(
      plannerDateRuleReady(
        { ...task, dueTime: '09:00' },
        { ...overdue, schedule: { amount: 2, unit: 'hours' } },
        new Date('2026-11-02T16:00:00Z'),
      ),
    ).toBe(true);
  });
  it.each(['days', 'hours', 'minutes'] as const)(
    'catches a zero-%s timed reminder after the due instant instead of requiring an exact poll',
    (unit) => {
      const zero: PlannerDateRule = {
        trigger: 'due_approaching',
        schedule: { amount: 0, unit },
      };
      const timed = { ...task, dueTime: '09:00' };
      expect(plannerDateRuleReady(timed, zero, new Date('2026-11-02T13:59:59.999Z'))).toBe(false);
      expect(plannerDateRuleReady(timed, zero, new Date('2026-11-02T14:00:00.345Z'))).toBe(true);
      expect(plannerDateRuleReady(timed, zero, new Date('2026-11-02T14:05:00Z'))).toBe(true);
    },
  );
  it.each(['hours', 'minutes'] as const)(
    'catches a zero-%s untimed reminder after the end-of-day deadline',
    (unit) => {
      const zero: PlannerDateRule = {
        trigger: 'due_approaching',
        schedule: { amount: 0, unit },
      };
      expect(plannerDateRuleReady(task, zero, new Date('2026-11-03T04:59:59Z'))).toBe(false);
      expect(plannerDateRuleReady(task, zero, new Date('2026-11-03T05:00:00.345Z'))).toBe(true);
    },
  );
  it('keeps a positive-offset approaching reminder bounded by its deadline', () => {
    expect(
      plannerDateRuleReady(
        { ...task, dueTime: '09:00' },
        approaching,
        new Date('2026-11-02T14:00:00.345Z'),
      ),
    ).toBe(false);
  });
  it('bounds offsets and personal actions and rejects reminder schedules on direct-change triggers', () => {
    const rule = { ...approaching, enabled: true, conditions: {}, actions: { notify: true } };
    expect(validateResource('rule', rule)).toEqual(rule);
    for (const schedule of [
      { amount: -1, unit: 'days' },
      { amount: 366, unit: 'days' },
      { amount: 0.5, unit: 'hours' },
      { amount: 2, unit: 'weeks' },
    ])
      expect(() => validateResource('rule', { ...rule, schedule })).toThrow();
    expect(() => validateResource('rule', { ...rule, trigger: 'created' })).toThrow();
    expect(() => validateResource('rule', { ...rule, actions: { notify: false } })).toThrow();
    expect(() =>
      validateResource('my_tasks', {
        sections: [],
        placements: [],
        rules: [
          {
            ...approaching,
            id: crypto.randomUUID(),
            name: 'No action',
            enabled: true,
            notify: false,
          },
        ],
      }),
    ).toThrow();
  });
});
