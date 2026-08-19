/**
 * VNextRouter claims the WHOLE /settings prefix (purge Phase 2). Mirrors the
 * engagement-gate test's hermetic setup: every other vNext branch is stubbed;
 * isVNextSettingsPath is the REAL predicate (imported from the UI-free
 * settings-route.ts by both the router and this test); only the Settings
 * module body is stubbed, since its real tree pulls fourteen pages of module
 * weight that has nothing to do with the routing contract under test.
 *
 * The canonical fallback is reproduced the way App.tsx actually wires it — a
 * layout `<Route element={<VNextRouter/>}>` around sibling canonical routes,
 * so VNextRouter's own `<Outlet/>` renders the canonical page for unclaimed
 * paths.
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
vi.mock('../pages/district-nexus/district-nexus-route.js', () => ({
  isVNextDistrictNexusPath: () => false,
}));
vi.mock('../pages/district-nexus/DistrictNexusPageVNext.js', () => ({
  DistrictNexusPageVNext: () => <div data-testid="dn-stub" />,
}));
vi.mock('../pages/explorer/DataExplorerVNext.js', () => ({
  DataExplorerVNext: () => <div data-testid="explorer-stub" />,
}));
vi.mock('../pages/bills/VNextBillRoutes.js', () => ({
  isVNextBillPath: () => false,
  VNextBillRoutes: () => <div data-testid="bills-stub" />,
}));
// Settings: REAL predicate (settings-route.ts is imported un-mocked by the
// router), stubbed body.
vi.mock('../pages/settings/VNextSettingsRoutes.js', () => ({
  VNextSettingsRoutes: () => <div data-testid="vnext-settings">vnext settings</div>,
}));

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<VNextRouter />}>
            <Route
              path="/settings/*"
              element={<div data-testid="canonical-settings">canonical settings</div>}
            />
            <Route
              path="/admin"
              element={<div data-testid="canonical-admin">canonical admin redirect</div>}
            />
            <Route
              path="/help"
              element={<div data-testid="canonical-help">canonical help</div>}
            />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('VNextRouter — Settings claimed for the whole /settings prefix', () => {
  it('renders vNext Settings at /settings (never the canonical layout)', async () => {
    renderAt('/settings');
    expect(await screen.findByTestId('vnext-settings')).toBeInTheDocument();
    expect(screen.queryByTestId('canonical-settings')).not.toBeInTheDocument();
  });

  it('renders vNext Settings at a sub-page path (/settings/team)', async () => {
    renderAt('/settings/team');
    expect(await screen.findByTestId('vnext-settings')).toBeInTheDocument();
    expect(screen.queryByTestId('canonical-settings')).not.toBeInTheDocument();
  });

  it('renders vNext Settings for the Policy Packs query-param tab path', async () => {
    renderAt('/settings/skills?view=policy-packs');
    expect(await screen.findByTestId('vnext-settings')).toBeInTheDocument();
    expect(screen.queryByTestId('canonical-settings')).not.toBeInTheDocument();
  });

  it('leaves the canonical /admin redirect and unrelated paths to fall through', () => {
    renderAt('/admin');
    expect(screen.getByTestId('canonical-admin')).toBeInTheDocument();
    expect(screen.queryByTestId('vnext-settings')).not.toBeInTheDocument();
  });

  it('does not intercept a non-settings path', () => {
    renderAt('/help');
    expect(screen.getByTestId('canonical-help')).toBeInTheDocument();
    expect(screen.queryByTestId('vnext-settings')).not.toBeInTheDocument();
  });
});
