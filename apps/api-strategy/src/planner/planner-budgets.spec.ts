import {
  plannerDefaultBudget,
  PLANNER_DEFAULT_BUDGET_ALERT,
  plannerMoneyMinor,
  plannerMoneyFormat,
} from '@capiro/strategy-verifier';
import {
  plannerBudgetData,
  plannerBudgetSummary,
  plannerBudgetAlertDue,
  plannerBudgetAlert,
} from './planner-budgets.js';
const active = new Map([['alex', 'Alex']]);
const summary = (patch = {}) =>
  plannerBudgetSummary({
    projectId: 'project',
    projectName: 'Budget',
    version: 1,
    data: {
      ...plannerDefaultBudget(),
      measurement: 'cost',
      budgetMinor: '10000',
      rates: [{ userId: 'alex', name: 'Alex', hourlyMinor: '10000' }],
    },
    alert: { ...PLANNER_DEFAULT_BUDGET_ALERT, enabled: true },
    active,
    estimates: [{ userId: 'alex', minutes: 120 }],
    time: [{ userId: 'alex', minutes: 60, billable: true }],
    ...patch,
  });
describe('Integer project budget math and validation', () => {
  it('rounds decimal rates without binary float drift and formats huge amounts exactly', () => {
    expect(plannerMoneyMinor('0.005')).toBe('1');
    expect(plannerMoneyMinor('100.999')).toBe('10100');
    expect(plannerMoneyMinor('1e4')).toBeNull();
    expect(plannerMoneyMinor('-1')).toBeNull();
    expect(plannerMoneyFormat('999999999999999999', 'USD')).toBe('$9,999,999,999,999,999.99');
  });
  it('rounds after summing a person’s time and totals exactly the visible person costs', () => {
    const b = summary({
      time: Array.from({ length: 3 }, () => ({ userId: 'alex', minutes: 1, billable: true })),
    });
    expect(b.actualMinor).toBe('500');
    expect(b.people[0]?.actualMinor).toBe('500');
  });
  it('keeps unknown rates separate from explicit zero rates and filters only actual time', () => {
    const b = summary({
      data: {
        ...plannerDefaultBudget(),
        actualFilter: 'nonbillable',
        rates: [{ userId: 'alex', name: 'Alex', hourlyMinor: '0' }],
      },
      estimates: [
        { userId: null, minutes: 60 },
        { userId: 'alex', minutes: 30 },
      ],
      time: [
        { userId: 'alex', minutes: 40, billable: true },
        { userId: 'alex', minutes: 20, billable: false },
        { userId: 'former', minutes: 10, billable: false },
      ],
    });
    expect(b).toMatchObject({
      estimatedMinutes: 90,
      actualMinutes: 30,
      billableMinutes: 40,
      nonbillableMinutes: 30,
      estimatedMinor: '0',
      actualMinor: '0',
      unratedEstimatedMinutes: 60,
      unratedActualMinutes: 10,
    });
    expect(b.people.find((p) => p.userId === 'alex')).toMatchObject({
      actualMinor: '0',
      hourlyMinor: '0',
    });
  });
  it('uses exact integer threshold comparisons and waits for complete costs', () => {
    expect(plannerBudgetAlertDue(summary())).toBe(true);
    expect(
      plannerBudgetAlertDue(summary({ time: [{ userId: 'alex', minutes: 47, billable: true }] })),
    ).toBe(false);
    expect(
      plannerBudgetAlertDue(
        summary({ time: [{ userId: 'unknown', minutes: 60, billable: true }] }),
      ),
    ).toBe(false);
    expect(
      plannerBudgetAlertDue(
        summary({
          alert: { ...PLANNER_DEFAULT_BUDGET_ALERT, enabled: true, comparison: 'estimate' },
        }),
      ),
    ).toBe(false);
    expect(
      plannerBudgetAlertDue(
        summary({
          data: { ...plannerDefaultBudget(), budgetMinutes: 60 },
          alert: { ...PLANNER_DEFAULT_BUDGET_ALERT, enabled: true },
        }),
      ),
    ).toBe(true);
  });
  it('retains departed rates and authoritative names while rejecting fabricated people and fields', () => {
    const previous = {
      ...plannerDefaultBudget(),
      rates: [{ userId: 'departed', name: 'Retained', hourlyMinor: '5000' }],
    };
    expect(
      plannerBudgetData(
        { rates: [{ userId: 'departed', name: 'Forged', hourlyMinor: '1000' }] },
        previous,
        active,
      ).rates[0]?.name,
    ).toBe('Retained');
    expect(() =>
      plannerBudgetData({ rates: [{ userId: 'new', hourlyMinor: '100' }] }, previous, active),
    ).toThrow();
    expect(() => plannerBudgetData({ currency: 'EUR' }, previous, active)).toThrow();
    expect(() =>
      plannerBudgetData({ rates: [{ userId: 'alex', hourlyMinor: '1.2' }] }, previous, active),
    ).toThrow();
    expect(() =>
      plannerBudgetData(
        {
          rates: [
            { userId: 'alex', hourlyMinor: '1' },
            { userId: 'alex', hourlyMinor: '1' },
          ],
        },
        previous,
        active,
      ),
    ).toThrow();
    expect(() => plannerBudgetAlert({ enabled: true, percent: 0, comparison: 'budget' })).toThrow();
  });
  it('needs estimated rates only when the alert references estimated cost', () => {
    const b = summary({ estimates: [{ userId: null, minutes: 60 }] });
    expect(plannerBudgetAlertDue(b)).toBe(true);
    expect(plannerBudgetAlertDue({ ...b, alert: { ...b.alert, comparison: 'estimate' } })).toBe(
      false,
    );
  });
});
