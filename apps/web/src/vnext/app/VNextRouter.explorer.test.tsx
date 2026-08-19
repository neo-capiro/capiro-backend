/**
 * Data Explorer claim (Phase 2 old-UI purge): VNextRouter intercepts /explorer
 * with the native vNext page for every tenant, so the canonical (antd)
 * DataExplorerPage is unreachable on os.capiro.ai. The claim is exact-path —
 * query strings (?source=, ?bill= deep links) ride along untouched, and
 * unclaimed paths still fall through to the canonical <Outlet/>.
 *
 * Mirrors VNextRouter.engagement-gate.test.tsx: every other vNext branch is
 * stubbed so the test stays hermetic; the canonical fallback is wired the way
 * App.tsx actually composes it (a layout <Route element={<VNextRouter/>}>
 * with the canonical page as a sibling child route).
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
// The page under claim — stubbed: this suite tests the ROUTING contract only;
// the page's own behavior is covered in pages/explorer/DataExplorerVNext.test.tsx.
vi.mock('../pages/explorer/DataExplorerVNext.js', () => ({
  DataExplorerVNext: () => <div data-testid="vnext-explorer">vnext explorer</div>,
}));

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<VNextRouter />}>
            <Route
              path="/explorer"
              element={<div data-testid="canonical-explorer">canonical explorer</div>}
            />
            <Route
              path="/unclaimed-page"
              element={<div data-testid="canonical-other">canonical other</div>}
            />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('VNextRouter — Data Explorer claimed at /explorer', () => {
  it('renders the vNext explorer instead of the canonical page', async () => {
    renderAt('/explorer');
    expect(await screen.findByTestId('vnext-explorer')).toBeInTheDocument();
    expect(screen.queryByTestId('canonical-explorer')).not.toBeInTheDocument();
  });

  it('claims /explorer with a ?source= deep link (Dashboard "Needs Attention" → comment-deadlines)', async () => {
    renderAt('/explorer?source=comment-deadlines');
    expect(await screen.findByTestId('vnext-explorer')).toBeInTheDocument();
    expect(screen.queryByTestId('canonical-explorer')).not.toBeInTheDocument();
  });

  it('claims /explorer with a ?bill= deep link (alert-email /intelligence/bills/:bill redirects)', async () => {
    renderAt('/explorer?bill=hr123-119');
    expect(await screen.findByTestId('vnext-explorer')).toBeInTheDocument();
    expect(screen.queryByTestId('canonical-explorer')).not.toBeInTheDocument();
  });

  it('leaves unclaimed paths to the canonical <Outlet/>', () => {
    renderAt('/unclaimed-page');
    expect(screen.getByTestId('canonical-other')).toBeInTheDocument();
    expect(screen.queryByTestId('vnext-explorer')).not.toBeInTheDocument();
  });
});
