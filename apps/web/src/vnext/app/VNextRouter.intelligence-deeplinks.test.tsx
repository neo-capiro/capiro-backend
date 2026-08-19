/**
 * Intelligence deep-link claim contract (Phase 3 old-UI purge).
 *
 * VNextRouter must intercept the five deep-link-only intelligence routes —
 * `/intelligence/federal-spending`, `/intelligence/issues/:code`,
 * `/intelligence/graph`, `/intelligence/changes`, `/intelligence-center` —
 * so no legacy antd page can render there on os.capiro.ai, while every
 * still-canonical /intelligence path (redirect routes, the catch-all, the
 * hearing-watch index) keeps falling through to the canonical tree via
 * VNextRouter's own <Outlet/>.
 *
 * Mirrors VNextRouter.funding-opportunities.test.tsx: every OTHER vNext
 * branch is stubbed so the test stays hermetic; isVNextIntelligencePath is
 * the REAL predicate (kept live via importOriginal) and only the routes
 * component body is stubbed, since its real body lazy-loads the pages.
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
// The REAL path predicate, with only the routes body stubbed — the routing
// contract under test is "which paths does VNextRouter claim", not what the
// module renders once claimed.
vi.mock('../pages/intelligence/VNextIntelligenceRoutes.js', async (importOriginal) => {
  const real = await importOriginal<
    typeof import('../pages/intelligence/VNextIntelligenceRoutes.js')
  >();
  return {
    ...real,
    VNextIntelligenceRoutes: () => (
      <div data-testid="vnext-intelligence">vnext intelligence</div>
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
              path="/intelligence"
              element={<div data-testid="canonical-intelligence-root">canonical root redirect</div>}
            />
            <Route
              path="/intelligence-center"
              element={<div data-testid="canonical-intelligence-center">canonical coming soon</div>}
            />
            <Route
              path="/intelligence/*"
              element={<div data-testid="canonical-intelligence">canonical intelligence</div>}
            />
            <Route
              path="*"
              element={<div data-testid="canonical-other">canonical other</div>}
            />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('VNextRouter — intelligence deep links claimed (Phase 3)', () => {
  it('claims all five deep-link routes, so no legacy intelligence page can render there', () => {
    for (const path of [
      '/intelligence/federal-spending',
      '/intelligence/issues/DEF',
      '/intelligence/issues/tax-policy',
      '/intelligence/graph',
      '/intelligence/changes',
      '/intelligence-center',
    ]) {
      const { unmount } = renderAt(path);
      expect(screen.getByTestId('vnext-intelligence'), path).toBeInTheDocument();
      expect(screen.queryByTestId('canonical-intelligence'), path).not.toBeInTheDocument();
      expect(screen.queryByTestId('canonical-intelligence-center'), path).not.toBeInTheDocument();
      unmount();
    }
  });

  it('claims trailing-slash variants and query-state deep links', () => {
    for (const path of [
      '/intelligence/federal-spending/',
      '/intelligence/federal-spending?tab=subawards&state=VA&district=10&clientId=client-1',
      '/intelligence/issues/DEF/',
      '/intelligence/changes?clientId=client-1',
    ]) {
      const { unmount } = renderAt(path);
      expect(screen.getByTestId('vnext-intelligence'), path).toBeInTheDocument();
      unmount();
    }
  });

  it('claims encoded issue codes exactly as the canonical param route would resolve them', () => {
    renderAt('/intelligence/issues/TAX%20POLICY');
    expect(screen.getByTestId('vnext-intelligence')).toBeInTheDocument();
  });

  it('does NOT claim the still-canonical intelligence routes — they fall through', () => {
    for (const path of [
      // Redirect routes that stay canonical <Navigate>s in App.tsx:
      '/intelligence/hearing-watch',
      '/intelligence/bills/119-hr-8800',
      '/intelligence/client/client-1',
      '/intelligence/client/client-1/graph',
      // The catch-all:
      '/intelligence/something-else',
      // An issue path with no code is NOT the leaderboard:
      '/intelligence/issues',
      '/intelligence/issues/',
      // A deeper issues path is not a single-segment :code:
      '/intelligence/issues/DEF/extra',
      // Prefix hygiene: merely starting with the same characters is not a claim.
      '/intelligence/graphs',
      '/intelligence/changes-feed',
      '/intelligence/federal-spending-v2',
    ]) {
      const { unmount } = renderAt(path);
      expect(screen.getByTestId('canonical-intelligence'), path).toBeInTheDocument();
      expect(screen.queryByTestId('vnext-intelligence'), path).not.toBeInTheDocument();
      unmount();
    }
  });

  it('does NOT claim the /intelligence root redirect or near-miss center paths', () => {
    const root = renderAt('/intelligence');
    expect(screen.getByTestId('canonical-intelligence-root')).toBeInTheDocument();
    expect(screen.queryByTestId('vnext-intelligence')).not.toBeInTheDocument();
    root.unmount();

    const nearMiss = renderAt('/intelligence-centerx');
    expect(screen.getByTestId('canonical-other')).toBeInTheDocument();
    expect(screen.queryByTestId('vnext-intelligence')).not.toBeInTheDocument();
    nearMiss.unmount();
  });
});
