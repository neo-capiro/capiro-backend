import { describe, expect, it } from 'vitest';
import { DEFENSE_BUDGET_LIFECYCLE_ROOT, isVNextDefenseBudgetLifecyclePath } from './defense-budget-lifecycle-routes.js';

describe('defense-budget-lifecycle vNext route contract', () => {
  it('claims the root path', () => {
    expect(isVNextDefenseBudgetLifecyclePath(DEFENSE_BUDGET_LIFECYCLE_ROOT)).toBe(true);
  });

  it('claims the review-queue sub-route', () => {
    expect(isVNextDefenseBudgetLifecyclePath(`${DEFENSE_BUDGET_LIFECYCLE_ROOT}/review-queue`)).toBe(true);
  });

  it('does not claim an unrelated path', () => {
    expect(isVNextDefenseBudgetLifecyclePath('/program-elements')).toBe(false);
    expect(isVNextDefenseBudgetLifecyclePath('/defense-budget-lifecycle-other')).toBe(false);
  });
});
