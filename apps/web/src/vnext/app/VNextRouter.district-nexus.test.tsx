/**
 * District Nexus vNext routing contract (Phase 2 port): VNextRouter claims
 * exactly `/intelligence/district-nexus` — the single canonical route App.tsx
 * registers for the surface (district selection travels in the `?district=`
 * query param, never the path) — and every other /intelligence path falls
 * through to the canonical page via VNextRouter's own <Outlet/>.
 *
 * The `district_nexus_v2` feature flag is deliberately NOT consulted here:
 * the vNext page reproduces the canonical IN-PAGE fail-closed guide, so the
 * claim is unconditional (flag-off tenants see the vNext guide, not the
 * legacy page). Every other vNext branch is stubbed so the test stays
 * hermetic and exercises only isVNextDistrictNexusPath (real, imported from
 * district-nexus-route.ts by the router). The canonical fallback is
 * reproduced the same way App.tsx actually wires it — a layout
 * `<Route element={<VNextRouter/>}>` around sibling canonical routes.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { VNextRouter } from './VNextRouter.js';

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
// The page itself is stubbed (its real body pulls query/API weight that has
// nothing to do with the routing contract); isVNextDistrictNexusPath stays
// REAL — it is what this test exercises.
vi.mock('../pages/district-nexus/DistrictNexusPageVNext.js', () => ({
  DistrictNexusPageVNext: () => <div data-testid="vnext-district-nexus">vnext district nexus</div>,
}));

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<VNextRouter />}>
            <Route
              path="/intelligence/district-nexus"
              element={<div data-testid="canonical-district-nexus">canonical district nexus</div>}
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

describe('VNextRouter — District Nexus claim (Phase 2)', () => {
  it('claims /intelligence/district-nexus — the canonical page is unreachable there', async () => {
    renderAt('/intelligence/district-nexus');
    expect(await screen.findByTestId('vnext-district-nexus')).toBeInTheDocument();
    expect(screen.queryByTestId('canonical-district-nexus')).not.toBeInTheDocument();
  });

  it('claims the trailing-slash variant too', async () => {
    renderAt('/intelligence/district-nexus/');
    expect(await screen.findByTestId('vnext-district-nexus')).toBeInTheDocument();
    expect(screen.queryByTestId('canonical-district-nexus')).not.toBeInTheDocument();
  });

  it('keeps the district query param on the claimed route (deep links open the drawer)', async () => {
    renderAt('/intelligence/district-nexus?district=TX-23&clientId=c1');
    expect(await screen.findByTestId('vnext-district-nexus')).toBeInTheDocument();
  });

  it('does NOT claim other /intelligence surfaces — they fall through to canonical', () => {
    for (const path of [
      '/intelligence/federal-spending',
      '/intelligence/opportunities',
      '/intelligence/district-nexus/some-subpage',
    ]) {
      const { unmount } = renderAt(path);
      expect(screen.getByTestId('canonical-intelligence')).toBeInTheDocument();
      expect(screen.queryByTestId('vnext-district-nexus')).not.toBeInTheDocument();
      unmount();
    }
  });
});
