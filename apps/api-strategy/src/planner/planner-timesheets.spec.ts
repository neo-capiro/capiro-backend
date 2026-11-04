import { plannerWeekOn, plannerWeekDate } from '@capiro/strategy-verifier';
import { plannerTimeDetails, plannerTimeEditable } from './planner-timesheets.js';

describe('Planner calendar time and weekly locks', () => {
  it('uses Monday calendar weeks across year and leap boundaries', () => {
    expect(plannerWeekOn('2027-01-01')).toBe('2026-12-28');
    expect(plannerWeekDate('2028-02-28', 6)).toBe('2028-03-05');
    expect(plannerWeekOn('2026-10-11')).toBe('2026-10-05');
  });
  it('rejects invalid dates, zones, billable flags and unknown metadata', () => {
    for (const time of [
      { workedOn: '2026-02-30' },
      { timeZone: 'fake/zone' },
      { billable: 'true' },
      { projectId: 'private' },
      { category: 'x'.repeat(101) },
      { ownerId: 'other' },
    ])
      expect(() => plannerTimeDetails(time)).toThrow();
    const before = plannerTimeDetails({
      workedOn: '2026-10-04',
      timeZone: 'America/New_York',
      billable: true,
    });
    expect(plannerTimeDetails({ workedOn: '2026-10-05' }, before)).toMatchObject({
      ...before,
      workedOn: '2026-10-05',
    });
  });
  it('enforces persisted weekly locks for submitters, reviewers and admins', () => {
    const data = {
      weekOn: '2026-10-05',
      reviewerId: 'reviewer',
      status: 'submitted' as const,
      notes: '',
      correctedAfterApproval: false,
    };
    expect(plannerTimeEditable(data, 'owner', 'owner', false)).toBe(false);
    expect(plannerTimeEditable(data, 'owner', 'reviewer', false)).toBe(true);
    expect(plannerTimeEditable({ ...data, status: 'approved' }, 'owner', 'reviewer', false)).toBe(
      false,
    );
    expect(plannerTimeEditable({ ...data, status: 'approved' }, 'owner', 'owner', true)).toBe(true);
    expect(plannerTimeEditable(data, 'owner', 'stranger', true)).toBe(false);
  });
});
