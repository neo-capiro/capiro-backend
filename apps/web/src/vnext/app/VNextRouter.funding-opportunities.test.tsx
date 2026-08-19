/**
 * Funding Opportunities claim contract (Phase 2 old-UI purge).
 *
 * VNextRouter must intercept BOTH canonical FO routes —
 * `/intelligence/opportunities` (list) and
 * `/intelligence/opportunities/:source/:sourceRecordId` (deep-linkable detail)
 * — so no legacy antd FO page can render on os.capiro.ai, while every other
 * `/intelligence/*` path still falls through to the canonical tree via
 * VNextRouter's own <Outlet/>.
 *
 * Mirrors VNextRouter.engagement-gate.test.tsx: every OTHER vNext branch is
 * stubbed so the test stays hermetic; isVNextFundingOpportunitiesPath is the
 * REAL predicate (kept live via importOriginal) and only the routes component
 * body is stubbed, since its real body lazy-loads the whole surface.
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
vi.mock('../pages/client-crm/VNextClientCrmRoute.js', () => ({
  VNextClientCrmRoute: () => <div data-testid="client-crm-stub" />,
}));
// The REAL path predicate, with only the routes body stubbed — the routing
// contract under test is "which paths does VNextRouter claim", not what the
// module renders once claimed.
vi.mock('../pages/funding-opportunities/VNextFundingOpportunitiesRoutes.js', async (importOriginal) => {
  const real = await importOriginal<
    typeof import('../pages/funding-opportunities/VNextFundingOpportunitiesRoutes.js')
  >();
  return {
    isVNextFundingOpportunitiesPath: real.isVNextFundingOpportunitiesPath,
    VNextFundingOpportunitiesRoutes: () => (
      <div data-testid="vnext-funding-opportunities">vnext funding opportunities</div>
    ),
  };
});

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          {/* Mirrors App.tsx's real composition: a layout route with no path
              renders VNextRouter, and the canonical pages are sibling child
              routes that VNextRouter's own <Outlet/> resolves to whenever no
              vNext branch claims the path. */}
          <Route element={<VNextRouter />}>
            <Route
              path="/intelligence/opportunities"
              element={<div data-testid="canonical-fo-list">canonical list</div>}
            />
            <Route
              path="/intelligence/opportunities/:source/:sourceRecordId"
              element={<div data-testid="canonical-fo-detail">canonical detail</div>}
            />
            <Route
              path="/intelligence/*"
              element={<div data-testid="canonical-intelligence">canonical intelligence</div>}
            />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('VNextRouter — Funding Opportunities claimed at both canonical routes', () => {
  it('claims the list route, so the legacy FundingOpportunitiesPage is unreachable', () => {
    renderAt('/intelligence/opportunities');
    expect(screen.getByTestId('vnext-funding-opportunities')).toBeInTheDocument();
    expect(screen.queryByTestId('canonical-fo-list')).not.toBeInTheDocument();
  });

  it('claims the deep-linkable detail route for every source rail', () => {
    for (const path of [
      '/intelligence/opportunities/sam_gov/11111111-1111-1111-1111-111111111111',
      '/intelligence/opportunities/grants_gov/GRANT-1',
      '/intelligence/opportunities/agency_forecast/FCST-1',
      '/intelligence/opportunities/dibbs/SPE4A625T1234',
      '/intelligence/opportunities/sbir_sttr/A26-001',
    ]) {
      const { unmount } = renderAt(path);
      expect(screen.getByTestId('vnext-funding-opportunities')).toBeInTheDocument();
      expect(screen.queryByTestId('canonical-fo-detail')).not.toBeInTheDocument();
      unmount();
    }
  });

  it('claims list-route deep links with query state (clientId / view / detail drawer refs)', () => {
    renderAt('/intelligence/opportunities?clientId=client-1&view=explore&tab=pursuing');
    expect(screen.getByTestId('vnext-funding-opportunities')).toBeInTheDocument();
  });

  it('claims malformed depths under the prefix too — nothing legacy may render there', () => {
    renderAt('/intelligence/opportunities/only-one-segment');
    expect(screen.getByTestId('vnext-funding-opportunities')).toBeInTheDocument();
    expect(screen.queryByTestId('canonical-intelligence')).not.toBeInTheDocument();
  });

  it('does NOT claim sibling /intelligence paths — they fall through to canonical', () => {
    for (const path of [
      '/intelligence/explorer',
      '/intelligence/hearing-watch',
      // Prefix hygiene: a path that merely STARTS with the same characters is
      // not the module's.
      '/intelligence/opportunitiesX',
    ]) {
      const { unmount } = renderAt(path);
      expect(screen.getByTestId('canonical-intelligence')).toBeInTheDocument();
      expect(screen.queryByTestId('vnext-funding-opportunities')).not.toBeInTheDocument();
      unmount();
    }
  });
});
