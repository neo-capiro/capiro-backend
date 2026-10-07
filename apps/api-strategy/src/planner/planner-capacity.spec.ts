import {
  plannerCapacityMinutes,
  plannerCapacitySummary,
  plannerCapacityWorkdays,
  plannerCapacityDateShift,
  PLANNER_DEFAULT_CAPACITY_PLAN,
} from '@capiro/strategy-verifier';
import { capacityAllocationData, capacityRecordData } from './planner-capacity.validation.js';
const person = 'user_capacity',
  project = '20000000-0000-4000-8000-000000000045';
const allocation = (unit: 'hours' | 'percent', value: number, weeklyMinutes = 2400) =>
  ({
    id: project,
    projectId: project,
    archived: false,
    weeklyMinutes,
    data: {
      userId: person,
      placeholderId: null,
      startOn: '2026-10-02',
      endOn: '2026-10-08',
      effort: { unit, value },
    },
  }) as any;
describe('Capacity working-day effort', () => {
  it('distributes total hours over workdays, including partial date windows', () => {
    const a = allocation('hours', 20);
    expect(plannerCapacityWorkdays(a.data.startOn, a.data.endOn)).toEqual([
      '2026-10-02',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
    ]);
    expect(plannerCapacityMinutes(a, '2026-10-03', '2026-10-06')).toBe(480);
    expect(plannerCapacityMinutes(a)).toBe(1200);
    expect(plannerCapacityMinutes(a, '2026-10-03', '2026-10-04')).toBe(0);
  });
  it('uses individual weekly capacity for percentages and preserves fractions without rounding each day', () => {
    expect(plannerCapacityMinutes(allocation('percent', 50, 1800))).toBe(900);
    expect(plannerCapacityMinutes(allocation('percent', 100, 0))).toBe(0);
    const a = allocation('hours', 1 / 60);
    expect(plannerCapacityMinutes(a)).toBe(1);
    expect(plannerCapacityMinutes(a, '2026-10-02', '2026-10-02')).toBe(0.2);
  });
  it('uses calendar dates across DST and leap years', () => {
    expect(plannerCapacityDateShift('2026-10-31', 2)).toBe('2026-11-02');
    expect(plannerCapacityDateShift('2028-02-28', 1)).toBe('2028-02-29');
    expect(plannerCapacityDateShift('2028-03-01', -1)).toBe('2028-02-29');
  });
  it('counts unique people/projects while summing distinct shared allocations once', () => {
    const a = allocation('hours', 20),
      b = { ...a, id: 'second', data: { ...a.data, userId: null, placeholderId: 'placeholder' } };
    expect(
      plannerCapacitySummary([a, b, { ...a, archived: true }], a.data.startOn, a.data.endOn),
    ).toMatchObject({ minutes: 2400, people: 2, projects: 1 });
  });
});
describe('Capacity input boundary', () => {
  it.each([
    { userId: person, placeholderId: project },
    { userId: null, placeholderId: null },
    { effort: { unit: 'days', value: 2 } },
    { effort: { unit: 'percent', value: 1001 } },
    { effort: { unit: 'hours', value: NaN } },
    { effort: { unit: 'hours', value: 0 } },
    { startOn: '2026-10-03', endOn: '2026-10-04' },
    { startOn: '2026-02-30' },
    { startOn: '2026-01-01', endOn: '2040-01-01' },
    { unknown: 'bad' },
  ])('rejects invalid or forged allocation values: %j', (patch) =>
    expect(() =>
      capacityAllocationData({ ...allocation('percent', 100).data, ...patch }),
    ).toThrow(),
  );
  it('allows only admin/viewer plan grants and no unknown saved-view fields', () => {
    expect(() =>
      capacityRecordData('capacity_plan', {
        ...PLANNER_DEFAULT_CAPACITY_PLAN,
        members: [{ userId: person, role: 'editor' }],
      }),
    ).toThrow();
    expect(() =>
      capacityRecordData('capacity_plan', {
        ...PLANNER_DEFAULT_CAPACITY_PLAN,
        peopleIds: [person, person],
      }),
    ).toThrow();
    expect(
      capacityRecordData('capacity_plan', {
        ...PLANNER_DEFAULT_CAPACITY_PLAN,
        peopleIds: [person],
      }),
    ).toMatchObject({ peopleIds: [person] });
  });
});
