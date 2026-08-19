/**
 * VNextRouter claims the six admin+misc paths (purge Phase 3). Mirrors the
 * settings-claim test's hermetic setup: every other vNext branch is stubbed;
 * isVNextAdminMiscPath is the REAL predicate (imported from the UI-free
 * admin-misc-routes.ts by both the router and this test); only the module body
 * is stubbed, since its real tree pulls six pages of module weight that has
 * nothing to do with the routing contract under test.
 *
 * The canonical fallback is reproduced the way App.tsx actually wires it — a
 * layout `<Route element={<VNextRouter/>}>` around sibling canonical routes,
 * so VNextRouter's own `<Outlet/>` renders the canonical page for unclaimed
 * paths. Critically, /admin, /admin/* and /capiro-admin must KEEP falling
 * through: they are canonical <Navigate> redirects into Settings and no UI
 * renders there.
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
vi.mock('../pages/funding-opportunities/VNextFundingOpportunitiesRoutes.js', () => ({
  isVNextFundingOpportunitiesPath: () => false,
  VNextFundingOpportunitiesRoutes: () => <div data-testid="fo-stub" />,
}));
vi.mock('../pages/settings/settings-route.js', () => ({
  isVNextSettingsPath: () => false,
}));
vi.mock('../pages/settings/VNextSettingsRoutes.js', () => ({
  VNextSettingsRoutes: () => <div data-testid="settings-stub" />,
}));
// Admin+misc: REAL predicate (admin-misc-routes.ts is imported un-mocked by
// the router), stubbed body.
vi.mock('../pages/admin-misc/VNextAdminMiscRoutes.js', () => ({
  VNextAdminMiscRoutes: () => <div data-testid="vnext-admin-misc">vnext admin misc</div>,
}));

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<VNextRouter />}>
            <Route
              path="/admin/analyst-console"
              element={<div data-testid="canonical-console">canonical console</div>}
            />
            <Route
              path="/actions"
              element={<div data-testid="canonical-actions">canonical actions</div>}
            />
            <Route
              path="/reviews"
              element={<div data-testid="canonical-reviews">canonical reviews</div>}
            />
            <Route
              path="/help"
              element={<div data-testid="canonical-help">canonical help</div>}
            />
            <Route
              path="/admin"
              element={<div data-testid="canonical-admin-redirect">canonical admin redirect</div>}
            />
            <Route
              path="/admin/*"
              element={<div data-testid="canonical-admin-wildcard">canonical admin wildcard</div>}
            />
            <Route
              path="/capiro-admin"
              element={<div data-testid="canonical-capiro-admin">canonical capiro-admin</div>}
            />
            <Route
              path="/nonexistent-path-xyz"
              element={<div data-testid="canonical-unclaimed">canonical unclaimed</div>}
            />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('VNextRouter — admin+misc paths claimed (Phase 3)', () => {
  it.each([
    '/admin/analyst-console',
    '/admin/program-element/reconciliation',
    '/admin/program-element/match-queue',
    '/actions',
    '/reviews',
    '/help',
  ])('renders the vNext module at %s (never canonical)', async (path) => {
    renderAt(path);
    expect(await screen.findByTestId('vnext-admin-misc')).toBeInTheDocument();
    expect(screen.queryByTestId('canonical-console')).not.toBeInTheDocument();
    expect(screen.queryByTestId('canonical-actions')).not.toBeInTheDocument();
    expect(screen.queryByTestId('canonical-help')).not.toBeInTheDocument();
  });

  it('leaves the canonical /admin redirect to fall through', () => {
    renderAt('/admin');
    expect(screen.getByTestId('canonical-admin-redirect')).toBeInTheDocument();
    expect(screen.queryByTestId('vnext-admin-misc')).not.toBeInTheDocument();
  });

  it('leaves other /admin/* paths to fall through (back-compat redirects)', () => {
    renderAt('/admin/team');
    expect(screen.getByTestId('canonical-admin-wildcard')).toBeInTheDocument();
    expect(screen.queryByTestId('vnext-admin-misc')).not.toBeInTheDocument();
  });

  it('leaves /capiro-admin to fall through', () => {
    renderAt('/capiro-admin');
    expect(screen.getByTestId('canonical-capiro-admin')).toBeInTheDocument();
    expect(screen.queryByTestId('vnext-admin-misc')).not.toBeInTheDocument();
  });

  it('does not intercept an unclaimed path', () => {
    renderAt('/nonexistent-path-xyz');
    expect(screen.getByTestId('canonical-unclaimed')).toBeInTheDocument();
    expect(screen.queryByTestId('vnext-admin-misc')).not.toBeInTheDocument();
  });
});
