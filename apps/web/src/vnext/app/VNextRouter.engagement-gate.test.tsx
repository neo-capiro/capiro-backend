/**
 * Engagement vNext tenant access gate (dogfood canary, capiro-internal only
 * for now). The Engagement vNext reskin shipped with all four destinations
 * (Meetings/Library/Outreach/Reports) claimed unconditionally by VNextRouter
 * as soon as ENGAGEMENT_DESTINATION_READY marked them ready — every
 * os.capiro.ai user on every tenant saw the new navy UI, with no way to hold
 * it back for a canary rollout. This locks in the real gate added on top:
 * `VNextRouter` now only takes the Engagement-interception branch when GET
 * /me's `features.engagementVNext` resolves `true`. Deliberately NOT the
 * nav-visibility-only `meFeature` mechanism in routeManifest.ts (confirmed
 * elsewhere that it only hides a rail link, not the route itself) — this
 * changes which component actually renders.
 *
 * Every OTHER vNext branch is irrelevant to this gate and is stubbed out so
 * the test stays hermetic and exercises only: isVNextEngagementPath (real,
 * imported from engagement-route-state.ts) ANDed with the new tenant check.
 * The canonical fallback is reproduced the same way App.tsx actually wires
 * it — a layout `<Route element={<VNextRouter/>}>` around a sibling
 * `<Route path="/engagement/*" element={...}/>`, so VNextRouter's own
 * `<Outlet/>` is what renders the canonical page when the gate is closed.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { VNextRouter } from './VNextRouter.js';

const useMeMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/me.js', () => ({ useMe: useMeMock }));

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
vi.mock('../pages/client-crm/VNextClientCrmRoute.js', () => ({
  VNextClientCrmRoute: () => <div data-testid="client-crm-stub" />,
}));
// isVNextEngagementPath is the REAL destination-readiness check (kept live
// via importActual) — only VNextEngagementRoutes itself is stubbed, since its
// real body pulls in useApi/useClientFilter and a lot of module weight that
// has nothing to do with the tenant gate under test here.
vi.mock('../pages/engagement/VNextEngagementRoutes.js', async () => {
  const real = await vi.importActual<typeof import('../pages/engagement/engagement-route-state.js')>(
    '../pages/engagement/engagement-route-state.js',
  );
  return {
    isVNextEngagementPath: real.isVNextEngagementPath,
    VNextEngagementRoutes: () => <div data-testid="vnext-engagement">vnext engagement</div>,
  };
});

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          {/* Mirrors App.tsx's real composition (<Route element={<BillingGate/>}>
              wrapping <Route path="/engagement/*" element={<EngagementPage/>}/>,
              with BillingGate rendering VNextApp -> ... -> VNextRouter): a
              layout route with no path renders VNextRouter, and the canonical
              page is a sibling child route that VNextRouter's own <Outlet/>
              resolves to whenever no vNext branch claims the path. */}
          <Route element={<VNextRouter />}>
            <Route
              path="/engagement/*"
              element={<div data-testid="canonical-engagement">canonical engagement</div>}
            />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('VNextRouter — Engagement tenant access gate', () => {
  it('renders vNext Engagement once features.engagementVNext resolves true', () => {
    useMeMock.mockReturnValue({
      isLoading: false,
      data: { features: { engagementVNext: true } },
    });
    renderAt('/engagement/meetings');
    expect(screen.getByTestId('vnext-engagement')).toBeInTheDocument();
    expect(screen.queryByTestId('canonical-engagement')).not.toBeInTheDocument();
  });

  it('falls through to canonical EngagementPage when the tenant flag is false', () => {
    useMeMock.mockReturnValue({
      isLoading: false,
      data: { features: { engagementVNext: false } },
    });
    renderAt('/engagement/meetings');
    expect(screen.getByTestId('canonical-engagement')).toBeInTheDocument();
    expect(screen.queryByTestId('vnext-engagement')).not.toBeInTheDocument();
  });

  it('falls through to canonical while /me is still loading — never flashes vNext before the flag is confirmed', () => {
    useMeMock.mockReturnValue({ isLoading: true, data: undefined });
    renderAt('/engagement/meetings');
    expect(screen.getByTestId('canonical-engagement')).toBeInTheDocument();
    expect(screen.queryByTestId('vnext-engagement')).not.toBeInTheDocument();
  });

  it('falls through to canonical for an older cached /me shape with no engagementVNext key at all', () => {
    useMeMock.mockReturnValue({ isLoading: false, data: { features: {} } });
    renderAt('/engagement/meetings');
    expect(screen.getByTestId('canonical-engagement')).toBeInTheDocument();
    expect(screen.queryByTestId('vnext-engagement')).not.toBeInTheDocument();
  });

  it('still claims the other three destinations once enabled, matching isVNextEngagementPath', () => {
    useMeMock.mockReturnValue({
      isLoading: false,
      data: { features: { engagementVNext: true } },
    });
    renderAt('/engagement/outreach');
    expect(screen.getByTestId('vnext-engagement')).toBeInTheDocument();
  });
});
