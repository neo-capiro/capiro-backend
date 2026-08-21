/**
 * Defense Budget Lifecycle claim contract (Phase 8 Session 11).
 *
 * VNextRouter must intercept `/defense-budget-lifecycle` and its
 * `/review-queue` sub-route — a brand-new module with no canonical
 * counterpart at all — while every unrelated path still falls through to the
 * canonical tree via VNextRouter's own <Outlet/>.
 *
 * Mirrors VNextRouter.funding-opportunities.test.tsx: every OTHER vNext
 * branch is stubbed so the test stays hermetic; isVNextDefenseBudgetLifecyclePath
 * is the REAL predicate (kept live via importOriginal) and only the routes
 * component body is stubbed, since its real body lazy-loads the whole page
 * surface (which itself needs a live API/query context this test does not
 * set up).
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { VNextRouter } from './VNextRouter.js';

vi.mock('../../lib/me.js', () => ({ useMe: () => ({ isLoading: false, data: undefined }) }));

vi.mock('../pages/dashboard/DashboardVNext.js', () => ({
  DashboardVNext: () => <div data-testid="dashboard-stub" />,
}));
vi.mock('../pages/strategies/VNextStrategiesRoutes.js', () => ({
  VNextStrategiesRoutes: () => <div data-testid="strategies-stub" />,
}));
vi.mock('../pages/directory/VNextDirectoryRoutes.js', () => ({
  isVNextDirectoryPath: () => false,
  VNextDirectoryRoutes: () => <div data-testid="directory-stub" />,
}));
vi.mock('../pages/program-elements/VNextProgramElementsRoutes.js', () => ({
  isVNextProgramElementsPath: () => false,
  VNextProgramElementsRoutes: () => <div data-testid="pe-stub" />,
}));
vi.mock('../pages/legiwatch/VNextLegiWatchRoutes.js', () => ({
  isVNextLegiWatchPath: () => false,
  VNextLegiWatchRoutes: () => <div data-testid="legiwatch-stub" />,
}));
vi.mock('../pages/workspace/WorkspaceVNextRoutes.js', () => ({
  isWorkspaceVNextRoute: () => false,
  WorkspaceVNextRoutes: () => <div data-testid="workspace-stub" />,
}));
vi.mock('../pages/engagement/VNextEngagementRoutes.js', () => ({
  isVNextEngagementPath: () => false,
  VNextEngagementRoutes: () => <div data-testid="engagement-stub" />,
}));
vi.mock('../pages/funding-opportunities/VNextFundingOpportunitiesRoutes.js', () => ({
  isVNextFundingOpportunitiesPath: () => false,
  VNextFundingOpportunitiesRoutes: () => <div data-testid="fo-stub" />,
}));
vi.mock('../pages/client-crm/VNextClientCrmRoute.js', () => ({
  VNextClientCrmRoute: () => <div data-testid="client-crm-stub" />,
}));
// The REAL path predicate, with only the routes body stubbed.
vi.mock('../pages/defense-budget-lifecycle/VNextDefenseBudgetLifecycleRoutes.js', async (importOriginal) => {
  const real = await importOriginal<
    typeof import('../pages/defense-budget-lifecycle/VNextDefenseBudgetLifecycleRoutes.js')
  >();
  return {
    isVNextDefenseBudgetLifecyclePath: real.isVNextDefenseBudgetLifecyclePath,
    VNextDefenseBudgetLifecycleRoutes: () => (
      <div data-testid="vnext-defense-budget-lifecycle">vnext defense budget lifecycle</div>
    ),
  };
});

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<VNextRouter />}>
            <Route path="*" element={<div data-testid="canonical-other">canonical other</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('VNextRouter — Defense Budget Lifecycle claimed at its two routes', () => {
  it('claims the cycle-health root', () => {
    renderAt('/defense-budget-lifecycle');
    expect(screen.getByTestId('vnext-defense-budget-lifecycle')).toBeInTheDocument();
    expect(screen.queryByTestId('canonical-other')).not.toBeInTheDocument();
  });

  it('claims the review-queue sub-route, with query state', () => {
    renderAt('/defense-budget-lifecycle/review-queue?fiscalYear=2027');
    expect(screen.getByTestId('vnext-defense-budget-lifecycle')).toBeInTheDocument();
  });

  it('does NOT claim an unrelated path — it falls through to canonical', () => {
    renderAt('/program-elements');
    expect(screen.queryByTestId('vnext-defense-budget-lifecycle')).not.toBeInTheDocument();
  });
});
