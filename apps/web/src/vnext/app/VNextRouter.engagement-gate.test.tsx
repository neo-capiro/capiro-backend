/**
 * Engagement vNext GA contract (gate REMOVED 2026-08-18, owner decision: no
 * legacy UI on os.capiro.ai). During the dogfood canary, VNextRouter took the
 * Engagement-interception branch only when GET /me's `features.engagementVNext`
 * resolved `true`; every other tenant fell through to the canonical
 * EngagementPage. That per-tenant gate is gone: the four destinations
 * (Meetings/Library/Outreach/Reports) are claimed unconditionally, exactly
 * like every other ported module. These tests lock the new contract —
 * Engagement paths render vNext for every tenant, regardless of what the /me
 * flag says (false, absent, or still loading), and VNextRouter no longer
 * consults /me at all. If a tenant-level hold-back is ever needed again, see
 * git history on this file and VNextRouter.tsx for the canary-era wiring.
 *
 * Every OTHER vNext branch is irrelevant here and is stubbed out so the test
 * stays hermetic and exercises only isVNextEngagementPath (real, imported
 * from engagement-route-state.ts). The canonical fallback is reproduced the
 * same way App.tsx actually wires it — a layout `<Route element={<VNextRouter/>}>`
 * around a sibling `<Route path="/engagement/*" element={...}/>`, so
 * VNextRouter's own `<Outlet/>` is what renders the canonical page for paths
 * no vNext branch claims (none of the Engagement ones, anymore).
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
// has nothing to do with the routing contract under test here.
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

describe('VNextRouter — Engagement claimed unconditionally (post-GA)', () => {
  it('renders vNext Engagement when the legacy flag would have been true', () => {
    useMeMock.mockReturnValue({
      isLoading: false,
      data: { features: { engagementVNext: true } },
    });
    renderAt('/engagement/meetings');
    expect(screen.getByTestId('vnext-engagement')).toBeInTheDocument();
    expect(screen.queryByTestId('canonical-engagement')).not.toBeInTheDocument();
  });

  it('renders vNext Engagement even when the legacy tenant flag is false', () => {
    useMeMock.mockReturnValue({
      isLoading: false,
      data: { features: { engagementVNext: false } },
    });
    renderAt('/engagement/meetings');
    expect(screen.getByTestId('vnext-engagement')).toBeInTheDocument();
    expect(screen.queryByTestId('canonical-engagement')).not.toBeInTheDocument();
  });

  it('renders vNext Engagement while /me is still loading — no canonical flash on slow tenants', () => {
    useMeMock.mockReturnValue({ isLoading: true, data: undefined });
    renderAt('/engagement/meetings');
    expect(screen.getByTestId('vnext-engagement')).toBeInTheDocument();
    expect(screen.queryByTestId('canonical-engagement')).not.toBeInTheDocument();
  });

  it('renders vNext Engagement for an older cached /me shape with no engagementVNext key at all', () => {
    useMeMock.mockReturnValue({ isLoading: false, data: { features: {} } });
    renderAt('/engagement/meetings');
    expect(screen.getByTestId('vnext-engagement')).toBeInTheDocument();
    expect(screen.queryByTestId('canonical-engagement')).not.toBeInTheDocument();
  });

  it('claims all four destinations, matching isVNextEngagementPath', () => {
    useMeMock.mockReturnValue({ isLoading: false, data: { features: {} } });
    for (const path of [
      '/engagement/meetings',
      '/engagement/meeting-library',
      '/engagement/outreach',
      '/engagement/reports',
    ]) {
      const { unmount } = renderAt(path);
      expect(screen.getByTestId('vnext-engagement')).toBeInTheDocument();
      unmount();
    }
  });

  it('claims EVERY /engagement path — the canonical EngagementPage is unreachable on the vNext surface', () => {
    useMeMock.mockReturnValue({ isLoading: false, data: { features: {} } });
    // engagementDestination() maps any unrecognized /engagement path to
    // 'meetings', and all four ENGAGEMENT_DESTINATION_READY entries are true,
    // so isVNextEngagementPath accepts the whole /engagement subtree. That IS
    // the post-GA invariant: no old-UI EngagementPage can render on
    // os.capiro.ai through any engagement URL shape.
    for (const path of ['/engagement', '/engagement/some-unknown-subpage']) {
      const { unmount } = renderAt(path);
      expect(screen.getByTestId('vnext-engagement')).toBeInTheDocument();
      expect(screen.queryByTestId('canonical-engagement')).not.toBeInTheDocument();
      unmount();
    }
  });
});
