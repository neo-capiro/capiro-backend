import {
  plannerBudgetAmounts,
  plannerBudgetCurrency,
  plannerRatedCost,
  type PlannerBudgetData,
  type PlannerBudgetAlert,
  type PlannerBudgetPerson,
  type PlannerProjectBudget,
} from '@capiro/strategy-verifier';
import { fail, keys, object } from './planner.validation.js';

const minor = (value: unknown) => typeof value === 'string' && /^(?:0|[1-9]\d{0,17})$/.test(value);
export function plannerBudgetData(
  value: unknown,
  previous: PlannerBudgetData,
  active: Map<string, string>,
): PlannerBudgetData {
  const raw = object(value);
  keys(raw, ['measurement', 'budgetMinutes', 'budgetMinor', 'actualFilter', 'rates']);
  const data = { ...previous, ...raw } as PlannerBudgetData;
  if (!plannerBudgetCurrency(data.currency) || !['time', 'cost'].includes(data.measurement))
    fail('Invalid project budget');
  if (
    data.budgetMinutes !== null &&
    (!Number.isSafeInteger(data.budgetMinutes) ||
      data.budgetMinutes <= 0 ||
      data.budgetMinutes > 100_000_000)
  )
    fail('Budget time requires 1–100,000,000 minutes or no limit');
  if (data.budgetMinor !== null && (!minor(data.budgetMinor) || BigInt(data.budgetMinor) <= 0n))
    fail('Budget cost requires a positive amount or no limit');
  if (!['all', 'billable', 'nonbillable'].includes(data.actualFilter))
    fail('Choose all, billable or non-billable time');
  if (!Array.isArray(data.rates) || data.rates.length > 500)
    fail('A project rate pool supports at most 500 people');
  const seen = new Set<string>(),
    old = new Map(previous.rates.map((r) => [r.userId, r]));
  data.rates = data.rates.map((value) => {
    const rate = object(value);
    keys(rate, ['userId', 'hourlyMinor', 'name']);
    if (
      typeof rate.userId !== 'string' ||
      !rate.userId ||
      rate.userId.length > 200 ||
      seen.has(rate.userId)
    )
      fail('Project rate people must be unique');
    if (!minor(rate.hourlyMinor)) fail('Hourly rates require a non-negative amount');
    const name = active.get(rate.userId) ?? old.get(rate.userId)?.name;
    if (!name) fail('Choose an active organization member');
    seen.add(rate.userId);
    // Names come from membership or the retained historical rate, never the caller.
    return { userId: rate.userId, name, hourlyMinor: rate.hourlyMinor as string };
  });
  return data;
}
export function plannerBudgetAlert(value: unknown): Omit<PlannerBudgetAlert, 'version'> {
  const raw = object(value);
  keys(raw, ['enabled', 'percent', 'comparison']);
  if (
    typeof raw.enabled !== 'boolean' ||
    !Number.isInteger(raw.percent) ||
    Number(raw.percent) < 1 ||
    Number(raw.percent) > 1000 ||
    !['budget', 'estimate'].includes(String(raw.comparison))
  )
    fail('Choose a budget alert threshold of 1–1000 percent');
  return raw as unknown as Omit<PlannerBudgetAlert, 'version'>;
}
export function plannerBudgetSummary(input: {
  projectId: string;
  projectName: string;
  version: number;
  data: PlannerBudgetData;
  alert: PlannerBudgetAlert;
  active: Map<string, string>;
  estimates: { userId: string | null; minutes: number }[];
  time: { userId: string; minutes: number; billable: boolean }[];
}): PlannerProjectBudget {
  const rates = new Map(input.data.rates.map((r) => [r.userId, r])),
    people = new Map<string | null, PlannerBudgetPerson>();
  const person = (id: string | null) => {
    if (!people.has(id))
      people.set(id, {
        userId: id,
        name: id ? (input.active.get(id) ?? rates.get(id)?.name ?? 'Former member') : 'Unassigned',
        active: !!id && input.active.has(id),
        hourlyMinor: id ? (rates.get(id)?.hourlyMinor ?? null) : null,
        estimatedMinutes: 0,
        actualMinutes: 0,
        estimatedMinor: null,
        actualMinor: null,
      });
    return people.get(id)!;
  };
  for (const rate of input.data.rates) person(rate.userId);
  for (const row of input.estimates) person(row.userId).estimatedMinutes += row.minutes;
  let billableMinutes = 0,
    nonbillableMinutes = 0;
  for (const row of input.time) {
    if (row.billable) billableMinutes += row.minutes;
    else nonbillableMinutes += row.minutes;
    if (
      input.data.actualFilter === 'all' ||
      (row.billable ? 'billable' : 'nonbillable') === input.data.actualFilter
    )
      person(row.userId).actualMinutes += row.minutes;
  }
  let estimatedMinutes = 0,
    actualMinutes = 0,
    unratedEstimatedMinutes = 0,
    unratedActualMinutes = 0,
    estimatedMinor = 0n,
    actualMinor = 0n;
  for (const p of people.values()) {
    if (!Number.isSafeInteger(p.estimatedMinutes) || !Number.isSafeInteger(p.actualMinutes))
      fail('Project time exceeds the supported integer range');
    estimatedMinutes += p.estimatedMinutes;
    actualMinutes += p.actualMinutes;
    if (p.hourlyMinor === null) {
      unratedEstimatedMinutes += p.estimatedMinutes;
      unratedActualMinutes += p.actualMinutes;
    } else {
      p.estimatedMinor = plannerRatedCost(p.estimatedMinutes, p.hourlyMinor);
      p.actualMinor = plannerRatedCost(p.actualMinutes, p.hourlyMinor);
      estimatedMinor += BigInt(p.estimatedMinor);
      actualMinor += BigInt(p.actualMinor);
    }
  }
  return {
    projectId: input.projectId,
    projectName: input.projectName,
    version: input.version,
    data: input.data,
    alert: input.alert,
    people: [...people.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || (a.userId ?? '').localeCompare(b.userId ?? ''),
    ),
    estimatedMinutes,
    actualMinutes,
    billableMinutes,
    nonbillableMinutes,
    unratedEstimatedMinutes,
    unratedActualMinutes,
    estimatedMinor: estimatedMinor.toString(),
    actualMinor: actualMinor.toString(),
  };
}
export function plannerBudgetAlertDue(budget: PlannerProjectBudget): boolean {
  const amounts = plannerBudgetAmounts(budget),
    alert = budget.alert;
  const reference = alert.comparison === 'budget' ? amounts.budget : amounts.estimated;
  // Unknown costs must never trigger a misleading monetary threshold alert.
  const complete =
    budget.data.measurement !== 'cost' ||
    (!budget.unratedActualMinutes &&
      (alert.comparison !== 'estimate' || !budget.unratedEstimatedMinutes));
  return (
    alert.enabled &&
    complete &&
    reference !== null &&
    BigInt(reference) > 0n &&
    BigInt(amounts.actual) * 100n >= BigInt(reference) * BigInt(alert.percent)
  );
}
