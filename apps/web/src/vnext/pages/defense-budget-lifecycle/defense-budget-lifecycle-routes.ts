/**
 * Phase 8 Session 11 — Defense Budget Lifecycle vNext route contract.
 *
 * A genuinely new module: there is no canonical (pre-vNext) page for this
 * domain at all, so unlike Program Elements/Directory this claims a brand
 * new path rather than substituting an existing one — same posture as
 * Funding Opportunities when it first shipped.
 *
 * Route shape:
 *   /defense-budget-lifecycle                           Cycle health + coverage (default FY)
 *   /defense-budget-lifecycle?fiscalYear=2027
 *   /defense-budget-lifecycle/review-queue?fiscalYear=2027
 */
export const DEFENSE_BUDGET_LIFECYCLE_ROOT = '/defense-budget-lifecycle';

export function isVNextDefenseBudgetLifecyclePath(pathname: string): boolean {
  return (
    pathname === DEFENSE_BUDGET_LIFECYCLE_ROOT ||
    pathname.startsWith(`${DEFENSE_BUDGET_LIFECYCLE_ROOT}/`)
  );
}
