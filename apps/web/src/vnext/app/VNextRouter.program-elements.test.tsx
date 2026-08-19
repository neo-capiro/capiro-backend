/**
 * Program Elements Phase 3 routing contract: VNextRouter claims the workspace
 * root, BOTH static segments (mark-up-monitor + contacts — newly claimed by
 * the native rebuild) and the :peCode line profiles, while the reserved
 * `reconciliation` segment and unrelated paths still fall through to the
 * canonical `<Outlet/>`.
 *
 * Every other vNext branch is stubbed so the test stays hermetic; the real
 * isVNextProgramElementsPath is kept live via importActual on pe-routes.ts
 * (only the module component itself is stubbed — its body pulls useMe/useApi
 * and the whole workspace, which is irrelevant to the routing contract).
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
vi.mock('../pages/engagement/VNextEngagementRoutes.js', () => ({
  isVNextEngagementPath: () => false,
  VNextEngagementRoutes: () => <div data-testid="engagement-stub" />,
}));
vi.mock('../pages/funding-opportunities/VNextFundingOpportunitiesRoutes.js', () => ({
  isVNextFundingOpportunitiesPath: () => false,
  VNextFundingOpportunitiesRoutes: () => <div data-testid="fo-stub" />,
}));
vi.mock('../pages/bills/VNextBillRoutes.js', () => ({
  isVNextBillPath: () => false,
  VNextBillRoutes: () => <div data-testid="bills-stub" />,
}));
// The REAL route predicate (importActual on the pure pe-routes module) — only
// the module component is stubbed.
vi.mock('../pages/program-elements/VNextProgramElementsRoutes.js', async () => {
  const real = await vi.importActual<typeof import('../pages/program-elements/pe-routes.js')>(
    '../pages/program-elements/pe-routes.js',
  );
  return {
    isVNextProgramElementsPath: real.isVNextProgramElementsPath,
    VNextProgramElementsRoutes: () => <div data-testid="vnext-pe">vnext program elements</div>,
  };
});

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<VNextRouter />}>
            <Route
              path="/program-elements/*"
              element={<div data-testid="canonical-pe">canonical program elements</div>}
            />
            <Route path="*" element={<div data-testid="canonical-other">canonical other</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('VNextRouter — Program Elements Phase 3 claims', () => {
  it('claims the workspace root', () => {
    renderAt('/program-elements');
    expect(screen.getByTestId('vnext-pe')).toBeInTheDocument();
    expect(screen.queryByTestId('canonical-pe')).not.toBeInTheDocument();
  });

  it('claims BOTH static segments — mark-up monitor and contacts are native now', () => {
    for (const path of ['/program-elements/mark-up-monitor', '/program-elements/contacts']) {
      const { unmount } = renderAt(path);
      expect(screen.getByTestId('vnext-pe')).toBeInTheDocument();
      expect(screen.queryByTestId('canonical-pe')).not.toBeInTheDocument();
      unmount();
    }
  });

  it('claims :peCode line profiles', () => {
    renderAt('/program-elements/0604201A');
    expect(screen.getByTestId('vnext-pe')).toBeInTheDocument();
    expect(screen.queryByTestId('canonical-pe')).not.toBeInTheDocument();
  });

  it('does NOT claim the reserved reconciliation segment — canonical renders', () => {
    renderAt('/program-elements/reconciliation');
    expect(screen.getByTestId('canonical-pe')).toBeInTheDocument();
    expect(screen.queryByTestId('vnext-pe')).not.toBeInTheDocument();
  });

  it('does NOT claim unrelated paths', () => {
    renderAt('/nonexistent-path-xyz');
    expect(screen.getByTestId('canonical-other')).toBeInTheDocument();
    expect(screen.queryByTestId('vnext-pe')).not.toBeInTheDocument();
  });
});
