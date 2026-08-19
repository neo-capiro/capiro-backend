/**
 * Bill 360 vNext routing contract: VNextRouter claims the deep-linkable
 * dossier route `/bills/:billId` — exactly the shape the canonical route tree
 * matches — and nothing else under /bills. The canonical Bill360Page is
 * unreachable on the vNext surface through any claimed URL shape, while paths
 * canonical would 404 (bare /bills, extra segments) and the legacy
 * `/intelligence/bills/:bill` redirect route still fall through to the
 * canonical tree via VNextRouter's own <Outlet/>.
 *
 * Every OTHER vNext branch is irrelevant here and is stubbed out so the test
 * stays hermetic and exercises only isVNextBillPath (real, imported from
 * bill-route-state.ts). The canonical fallback is reproduced the same way
 * App.tsx actually wires it — a layout `<Route element={<VNextRouter/>}>`
 * around sibling child routes — mirroring VNextRouter.engagement-gate.test.tsx.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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
vi.mock('../pages/client-crm/VNextClientCrmRoute.js', () => ({
  VNextClientCrmRoute: () => <div data-testid="client-crm-stub" />,
}));
vi.mock('../pages/engagement/VNextEngagementRoutes.js', () => ({
  isVNextEngagementPath: () => false,
  VNextEngagementRoutes: () => <div data-testid="engagement-stub" />,
}));
// isVNextBillPath is the REAL predicate (kept live via importActual on
// bill-route-state.ts) — only VNextBillRoutes itself is stubbed, since its
// real body lazy-loads the whole dossier module, which has nothing to do with
// the routing contract under test here.
vi.mock('../pages/bills/VNextBillRoutes.js', async () => {
  const real = await vi.importActual<typeof import('../pages/bills/bill-route-state.js')>(
    '../pages/bills/bill-route-state.js',
  );
  return {
    isVNextBillPath: real.isVNextBillPath,
    VNextBillRoutes: () => <div data-testid="vnext-bill360">vnext bill 360</div>,
  };
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        {/* Mirrors App.tsx's real composition: a layout route with no path
            renders VNextRouter, and the canonical pages are sibling child
            routes that VNextRouter's own <Outlet/> resolves to whenever no
            vNext branch claims the path. */}
        <Route element={<VNextRouter />}>
          <Route
            path="/bills/:billId"
            element={<div data-testid="canonical-bill">canonical bill 360</div>}
          />
          <Route
            path="/intelligence/bills/:bill"
            element={<div data-testid="canonical-bill-redirect">canonical redirect</div>}
          />
          <Route path="*" element={<div data-testid="canonical-404">not found</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('VNextRouter — Bill 360 claims /bills/:billId', () => {
  it('renders the vNext dossier for a bare bill URL — the canonical page is unreachable', () => {
    renderAt('/bills/119-hr-8800');
    expect(screen.getByTestId('vnext-bill360')).toBeInTheDocument();
    expect(screen.queryByTestId('canonical-bill')).not.toBeInTheDocument();
  });

  it('renders the vNext dossier with a client context query string', () => {
    renderAt('/bills/119-hr-8800?client=11111111-1111-1111-1111-111111111111');
    expect(screen.getByTestId('vnext-bill360')).toBeInTheDocument();
    expect(screen.queryByTestId('canonical-bill')).not.toBeInTheDocument();
  });

  it('claims a trailing-slash variant, matching what the canonical route also matches', () => {
    renderAt('/bills/119-hr-8800/');
    expect(screen.getByTestId('vnext-bill360')).toBeInTheDocument();
    expect(screen.queryByTestId('canonical-bill')).not.toBeInTheDocument();
  });

  it('does NOT claim the bare /bills index — canonical 404 behavior is preserved', () => {
    renderAt('/bills');
    expect(screen.queryByTestId('vnext-bill360')).not.toBeInTheDocument();
    expect(screen.getByTestId('canonical-404')).toBeInTheDocument();
  });

  it('does NOT claim extra segments under a bill id — canonical 404 behavior is preserved', () => {
    renderAt('/bills/119-hr-8800/extra');
    expect(screen.queryByTestId('vnext-bill360')).not.toBeInTheDocument();
    expect(screen.getByTestId('canonical-404')).toBeInTheDocument();
  });

  it('does NOT claim /intelligence/bills/:bill — the legacy redirect route stays canonical', () => {
    renderAt('/intelligence/bills/119-hr-8800');
    expect(screen.queryByTestId('vnext-bill360')).not.toBeInTheDocument();
    expect(screen.getByTestId('canonical-bill-redirect')).toBeInTheDocument();
  });
});
