import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { CapiroSkeleton } from '../../components/feedback/index.js';
import { DEFENSE_BUDGET_LIFECYCLE_ROOT } from './defense-budget-lifecycle-routes.js';

const DefenseBudgetLifecycleHealthPage = lazy(async () => ({
  default: (await import('./DefenseBudgetLifecycleHealthPage.js')).DefenseBudgetLifecycleHealthPage,
}));
const DefenseBudgetLifecycleReviewQueuePage = lazy(async () => ({
  default: (await import('./DefenseBudgetLifecycleReviewQueuePage.js')).DefenseBudgetLifecycleReviewQueuePage,
}));
const ReviewedPartialPeTotalsPage = lazy(async () => ({
  default: (await import('../program-elements/reviewed-partial/ReviewedPartialPeTotalsPage.js')).ReviewedPartialPeTotalsPage,
}));

function Loading() {
  return (
    <div className="dbl-vnext" aria-busy="true" style={{ padding: 24 }}>
      <CapiroSkeleton height={200} />
    </div>
  );
}

/**
 * Phase 8 Session 11 — Defense Budget Lifecycle module router.
 *
 * Three routes, all read-only:
 *   /defense-budget-lifecycle                    cycle health + coverage
 *   /defense-budget-lifecycle/review-queue       review queue (no write action)
 *   /defense-budget-lifecycle/reviewed-partial   Phase 10B-35: bounded,
 *     individually-reviewed partial PE totals -- a separate publication
 *     class from cycle/expected-source coverage above; never implies
 *     complete fiscal-year or family coverage.
 */
export function VNextDefenseBudgetLifecycleRoutes() {
  return (
    <Routes>
      <Route
        path={DEFENSE_BUDGET_LIFECYCLE_ROOT}
        element={
          <Suspense fallback={<Loading />}>
            <DefenseBudgetLifecycleHealthPage />
          </Suspense>
        }
      />
      <Route
        path={`${DEFENSE_BUDGET_LIFECYCLE_ROOT}/review-queue`}
        element={
          <Suspense fallback={<Loading />}>
            <DefenseBudgetLifecycleReviewQueuePage />
          </Suspense>
        }
      />
      <Route
        path={`${DEFENSE_BUDGET_LIFECYCLE_ROOT}/reviewed-partial`}
        element={
          <Suspense fallback={<Loading />}>
            <ReviewedPartialPeTotalsPage />
          </Suspense>
        }
      />
      <Route path="*" element={<Navigate to={DEFENSE_BUDGET_LIFECYCLE_ROOT} replace />} />
    </Routes>
  );
}

export { isVNextDefenseBudgetLifecyclePath } from './defense-budget-lifecycle-routes.js';
