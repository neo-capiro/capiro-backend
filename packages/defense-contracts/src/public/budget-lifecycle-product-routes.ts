import type { DefenseAuthRole, DefenseHttpMethod } from './index.js';

/**
 * Phase 8 Session 11 — product/HTTP read route table.
 *
 * Deliberately NOT part of `DEFENSE_PUBLIC_ROUTES` in `./index.js`: that array
 * is the frozen Session 3 contract, permanently asserted at exactly 49 entries
 * by `scripts/verify-phase8-session3.mjs`, which parses ONLY that file. This
 * table lives in its own file, uses its own route-definition helper (never
 * the string `defineRoute(` so no static scan can confuse the two tables),
 * and is registered by its own controllers
 * (`BudgetLifecycleReadController`), never by `ProgramElementController` /
 * `BudgetLinesController` / `ProgramsController`.
 *
 * Every route here is GET. The Session 7 migration's own grant comment
 * ("HTTP serve reads the cycle-health state. The job/ingestion role is the
 * only writer") makes this a database-enforced boundary, not a style choice:
 * `capiro_defense_serve` — the role the HTTP process resolves to once the
 * deferred connection cutover lands — holds SELECT only on every table this
 * domain touches. Resolving a `review_required` hold is therefore a job-role
 * action (`scripts/run-review-resolution.mjs`), never an HTTP mutation.
 */
export interface DefenseProductRouteDefinition<
  TId extends string = string,
  TMethod extends DefenseHttpMethod = DefenseHttpMethod,
  TPath extends string = string,
> {
  readonly id: TId;
  readonly method: TMethod;
  readonly path: TPath;
  readonly minimumRole: DefenseAuthRole;
}

function defineProductRoute<
  const TId extends string,
  const TMethod extends DefenseHttpMethod,
  const TPath extends string,
>(
  id: TId,
  method: TMethod,
  path: TPath,
  minimumRole: DefenseAuthRole = 'standard_user',
): DefenseProductRouteDefinition<TId, TMethod, TPath> {
  return { id, method, path, minimumRole };
}

export const DEFENSE_BUDGET_LIFECYCLE_PRODUCT_ROUTES = [
  defineProductRoute(
    'budgetLifecycle.cycleHealth',
    'GET',
    'budget-lifecycle/cycles/:fiscalYear/health',
  ),
  defineProductRoute(
    'budgetLifecycle.expectedSources.list',
    'GET',
    'budget-lifecycle/cycles/:fiscalYear/expected-sources',
  ),
  defineProductRoute(
    'budgetLifecycle.expectedSources.detail',
    'GET',
    'budget-lifecycle/expected-sources/:id',
  ),
  defineProductRoute(
    'budgetLifecycle.reviewQueue.list',
    'GET',
    'budget-lifecycle/cycles/:fiscalYear/review-queue',
  ),
  defineProductRoute(
    'budgetLifecycle.signals.list',
    'GET',
    'budget-lifecycle/cycles/:fiscalYear/signals',
  ),
  defineProductRoute(
    'budgetLifecycle.scheduleTickHealth',
    'GET',
    'budget-lifecycle/schedule/tick-health',
  ),
] as const;
