/** Money is serialized in hundredths of a currency unit; never as binary floats. */
export interface PlannerProjectRate {
  userId: string;
  name: string;
  hourlyMinor: string;
}
export interface PlannerBudgetData {
  currency: string;
  measurement: 'time' | 'cost';
  budgetMinutes: number | null;
  budgetMinor: string | null;
  actualFilter: 'all' | 'billable' | 'nonbillable';
  rates: PlannerProjectRate[];
}
export interface PlannerBudgetAlert {
  version: number;
  enabled: boolean;
  percent: number;
  comparison: 'budget' | 'estimate';
}
export interface PlannerBudgetPerson {
  userId: string | null;
  name: string;
  active: boolean;
  hourlyMinor: string | null;
  estimatedMinutes: number;
  actualMinutes: number;
  estimatedMinor: string | null;
  actualMinor: string | null;
}
export interface PlannerProjectBudget {
  projectId: string;
  projectName: string;
  version: number;
  data: PlannerBudgetData;
  alert: PlannerBudgetAlert;
  estimatedMinutes: number;
  actualMinutes: number;
  billableMinutes: number;
  nonbillableMinutes: number;
  estimatedMinor: string;
  actualMinor: string;
  unratedEstimatedMinutes: number;
  unratedActualMinutes: number;
  people: PlannerBudgetPerson[];
}
export interface PlannerPortfolioBudgets {
  projects: PlannerProjectBudget[];
  estimatedMinutes: number;
  actualMinutes: number;
  budgetMinutes: number;
  currencies: {
    currency: string;
    estimatedMinor: string;
    actualMinor: string;
    budgetMinor: string;
    unratedEstimatedMinutes: number;
    unratedActualMinutes: number;
  }[];
}
export const PLANNER_DEFAULT_BUDGET_ALERT: PlannerBudgetAlert = {
  version: 0,
  enabled: false,
  percent: 80,
  comparison: 'budget',
};
export function plannerDefaultBudget(currency = 'USD'): PlannerBudgetData {
  return {
    currency,
    measurement: 'time',
    budgetMinutes: null,
    budgetMinor: null,
    actualFilter: 'all',
    rates: [],
  };
}
export function plannerBudgetCurrency(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) return false;
  const supported = (
    Intl as unknown as { supportedValuesOf(key: string): string[] }
  ).supportedValuesOf('currency');
  return supported.includes(value);
}
/** Accept decimal input, rounding rates to two decimal places using integer math. */
export function plannerMoneyMinor(value: string): string | null {
  if (!/^\d{1,16}(?:\.\d{1,8})?$/.test(value.trim())) return null;
  const [whole, fraction = ''] = value.trim().split('.');
  return (
    BigInt(whole!) * 100n +
    BigInt((fraction + '00').slice(0, 2)) +
    (Number(fraction[2] ?? 0) >= 5 ? 1n : 0n)
  ).toString();
}
export function plannerMoneyInput(minor: string): string {
  const value = BigInt(minor);
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
}
export function plannerMoneyFormat(minor: string, currency: string): string {
  const value = BigInt(minor),
    absolute = value < 0n ? -value : value;
  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const result = formatter
    .formatToParts(absolute / 100n)
    .map((part) =>
      part.type === 'fraction' ? (absolute % 100n).toString().padStart(2, '0') : part.value,
    )
    .join('');
  return value < 0n ? `−${result}` : result;
}
export function plannerRatedCost(minutes: number, hourlyMinor: string): string {
  return ((BigInt(minutes) * BigInt(hourlyMinor) + 30n) / 60n).toString();
}
export function plannerBudgetAmounts(budget: PlannerProjectBudget) {
  const cost = budget.data.measurement === 'cost';
  return {
    actual: cost ? budget.actualMinor : String(budget.actualMinutes),
    estimated: cost ? budget.estimatedMinor : String(budget.estimatedMinutes),
    budget: cost
      ? budget.data.budgetMinor
      : budget.data.budgetMinutes === null
        ? null
        : String(budget.data.budgetMinutes),
    complete: !cost || (!budget.unratedActualMinutes && !budget.unratedEstimatedMinutes),
  };
}
