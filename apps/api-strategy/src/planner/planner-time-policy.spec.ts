import {
  PLANNER_DEFAULT_TIME_OPTIONS,
  plannerTimeDateBounds,
  plannerTimeToday,
  type PlannerTimeDetails,
} from '@capiro/strategy-verifier';
import {
  plannerTimeOptions,
  plannerTimeDateNotice,
  requirePlannerTimePolicy,
} from './planner-time-policy.js';
import { plannerTimesheetActions } from './planner-timesheets.js';

describe('Organization time rules', () => {
  const options = (patch = {}) => plannerTimeOptions(patch);
  const time: PlannerTimeDetails = {
    workedOn: '2026-10-07',
    timeZone: 'UTC',
    billable: false,
    projectId: null,
    category: 'Research',
  };
  it('merges legacy settings and partial changes without sharing category arrays', () => {
    const previous = options({ billableDefault: true, categories: [' Research '] });
    expect(options()).toEqual(PLANNER_DEFAULT_TIME_OPTIONS);
    expect(plannerTimeOptions({ futureWeeks: 0 }, previous)).toEqual({
      ...previous,
      futureWeeks: 0,
    });
    previous.categories.push('Delivery');
    expect(PLANNER_DEFAULT_TIME_OPTIONS.categories).toEqual([]);
  });
  it.each([
    { timeTrackingEnabled: 'true' },
    { billableEnabled: null },
    { generalWorkEnabled: 1 },
    { approvalProcess: 'automatic' },
    { futureWeeks: -1 },
    { pastLockWeeks: 521 },
    { pastLockWeeks: 0.5 },
    { timeZone: 'fake/zone' },
    { categories: [''] },
    { categories: ['Research', ' research '] },
    { categories: ['x'.repeat(101)] },
    { categories: 'Research' },
    { categories: Array.from({ length: 101 }, (_, i) => String(i)) },
    { extra: true },
  ])('rejects invalid organization settings %j', (input) => expect(() => options(input)).toThrow());
  it('uses the organization calendar across UTC Monday and daylight-saving boundaries', () => {
    const rules = options({ pastLockWeeks: 0, futureWeeks: 0, timeZone: 'America/New_York' });
    const utcMonday = new Date('2026-11-02T02:00:00Z');
    expect(plannerTimeToday(rules.timeZone, utcMonday)).toBe('2026-11-01');
    expect(plannerTimeDateBounds(rules, false, utcMonday)).toEqual({
      minOn: '2026-10-26',
      maxOn: '2026-11-01',
    });
    expect(plannerTimeDateBounds(rules, false, new Date('2026-11-02T05:00:00Z'))).toEqual({
      minOn: '2026-11-02',
      maxOn: '2026-11-08',
    });
  });
  it('allows only admins to correct locked past time and applies future limits to everyone', () => {
    const rules = options({ pastLockWeeks: 2, futureWeeks: 1 });
    const now = new Date('2026-10-07T12:00:00Z');
    expect(plannerTimeDateBounds(rules, false, now)).toEqual({
      minOn: '2026-09-21',
      maxOn: '2026-10-18',
    });
    expect(plannerTimeDateNotice('2026-09-20', rules, false, now)).toContain('locked');
    expect(plannerTimeDateNotice('2026-09-20', rules, true, now)).toBeNull();
    expect(plannerTimeDateNotice('2026-10-18', rules, true, now)).toBeNull();
    expect(plannerTimeDateNotice('2026-10-19', rules, true, now)).toContain('future');
    expect(
      plannerTimeDateNotice('2026-10-07', options({ timeTrackingEnabled: false }), true, now),
    ).toContain('disabled');
  });
  it('keeps historical billable and retired categories but rejects new disallowed values', () => {
    const rules = options({ billableEnabled: false, categories: ['Delivery'] });
    const previous = { ...time, billable: true };
    expect(() => requirePlannerTimePolicy(previous, rules, false, previous)).not.toThrow();
    expect(() =>
      requirePlannerTimePolicy({ ...previous, billable: false }, rules, false, previous),
    ).not.toThrow();
    expect(() => requirePlannerTimePolicy(previous, rules, false, time)).toThrow('billable');
    expect(() => requirePlannerTimePolicy(time, rules, false)).toThrow('configured');
    expect(() => requirePlannerTimePolicy({ ...time, category: '' }, rules, false)).not.toThrow();
    expect(() =>
      requirePlannerTimePolicy({ ...time, category: 'Delivery' }, rules, false),
    ).not.toThrow();
  });
  it('supports submission without a reviewer and preserves recall of old approvals', () => {
    const sheet = {
      weekOn: time.workedOn,
      reviewerId: null,
      status: 'draft' as const,
      notes: '',
      correctedAfterApproval: false,
    };
    expect(plannerTimesheetActions(sheet, 'owner', 'owner', 'full')).toEqual([]);
    expect(plannerTimesheetActions(sheet, 'owner', 'owner', 'simple')).toEqual(['submit']);
    expect(
      plannerTimesheetActions(
        { ...sheet, reviewerId: 'reviewer', status: 'submitted' },
        'owner',
        'reviewer',
        'simple',
      ),
    ).toEqual([]);
    expect(
      plannerTimesheetActions(
        { ...sheet, reviewerId: 'reviewer', status: 'approved' },
        'owner',
        'reviewer',
        'simple',
      ),
    ).toEqual(['recall_approval']);
  });
});
