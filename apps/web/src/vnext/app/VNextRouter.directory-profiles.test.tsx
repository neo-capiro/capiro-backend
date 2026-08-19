/**
 * Directory profile claim contract (Phase 2 old-UI purge): VNextRouter must
 * intercept the five deep-linkable profile routes with the native vNext pages
 * — the canonical antd pages (MemberDirectoryProfilePage & co.) are
 * unreachable on os.capiro.ai — and must hand each page the params it would
 * have read from useParams, decoded from the raw pathname.
 *
 * The directory dispatch under test is REAL (isVNextDirectoryPath +
 * VNextDirectoryRoutes + matchDirectoryProfilePath); only the five profile
 * page bodies are stubbed to echo their props, since their data behaviour has
 * its own suites. Every other vNext module branch is stubbed out so the test
 * stays hermetic, and the canonical fallback is reproduced the same way
 * App.tsx wires it — a layout `<Route element={<VNextRouter/>}>` around
 * sibling canonical child routes resolved through VNextRouter's own
 * `<Outlet/>`.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { VNextRouter } from './VNextRouter.js';

vi.mock('../pages/dashboard/DashboardVNext.js', () => ({
  DashboardVNext: () => <div data-testid="dashboard-stub" />,
}));
vi.mock('../pages/strategies/VNextStrategiesRoutes.js', () => ({
  VNextStrategiesRoutes: () => <div data-testid="strategies-stub" />,
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

// The five profile pages echo the props VNextDirectoryRoutes parsed for them.
vi.mock('../pages/directory/MemberProfileVNext.js', () => ({
  MemberProfileVNext: ({ memberId }: { memberId: string }) => (
    <div data-testid="vnext-member-profile">{memberId}</div>
  ),
}));
vi.mock('../pages/directory/StaffProfileVNext.js', () => ({
  StaffProfileVNext: ({ staffId }: { staffId: string }) => (
    <div data-testid="vnext-staff-profile">{staffId}</div>
  ),
}));
vi.mock('../pages/directory/CommitteeProfileVNext.js', () => ({
  CommitteeProfileVNext: ({ committeeId }: { committeeId: string }) => (
    <div data-testid="vnext-committee-profile">{committeeId}</div>
  ),
}));
vi.mock('../pages/directory/StateLegislatorProfileVNext.js', () => ({
  StateLegislatorProfileVNext: ({ id }: { id: string }) => (
    <div data-testid="vnext-stateleg-profile">{id}</div>
  ),
}));
vi.mock('../pages/directory/DistrictProfileVNext.js', () => ({
  DistrictProfileVNext: ({ state, districtNo }: { state: string; districtNo: string }) => (
    <div data-testid="vnext-district-profile">{`${state}/${districtNo}`}</div>
  ),
}));

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<VNextRouter />}>
            {/* Canonical siblings, as in App.tsx — must be unreachable now. */}
            <Route
              path="/directory/members/:memberId"
              element={<div data-testid="canonical-member-profile" />}
            />
            <Route
              path="/directory/staff/:staffId"
              element={<div data-testid="canonical-staff-profile" />}
            />
            <Route
              path="/directory/committees/:committeeId"
              element={<div data-testid="canonical-committee-profile" />}
            />
            <Route
              path="/directory/state-legislators/:id"
              element={<div data-testid="canonical-stateleg-profile" />}
            />
            <Route
              path="/directory/districts/:state/:districtNo"
              element={<div data-testid="canonical-district-profile" />}
            />
            <Route path="/help" element={<div data-testid="canonical-help" />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('VNextRouter — directory profile routes claimed (Phase 2)', () => {
  it('claims /directory/members/:memberId with the parsed id', async () => {
    renderAt('/directory/members/member-500');
    expect(await screen.findByTestId('vnext-member-profile')).toHaveTextContent('member-500');
    expect(screen.queryByTestId('canonical-member-profile')).not.toBeInTheDocument();
  });

  it('claims /directory/staff/:staffId with the parsed id', async () => {
    renderAt('/directory/staff/staff-800');
    expect(await screen.findByTestId('vnext-staff-profile')).toHaveTextContent('staff-800');
    expect(screen.queryByTestId('canonical-staff-profile')).not.toBeInTheDocument();
  });

  it('claims /directory/committees/:committeeId with the parsed id', async () => {
    renderAt('/directory/committees/committee-100');
    expect(await screen.findByTestId('vnext-committee-profile')).toHaveTextContent('committee-100');
    expect(screen.queryByTestId('canonical-committee-profile')).not.toBeInTheDocument();
  });

  it('claims /directory/state-legislators/:id and decodes the ocd-person id', async () => {
    renderAt('/directory/state-legislators/ocd-person%2Fabc-123');
    expect(await screen.findByTestId('vnext-stateleg-profile')).toHaveTextContent(
      'ocd-person/abc-123',
    );
    expect(screen.queryByTestId('canonical-stateleg-profile')).not.toBeInTheDocument();
  });

  it('claims /directory/districts/:state/:districtNo with both params', async () => {
    renderAt('/directory/districts/WY/00');
    expect(await screen.findByTestId('vnext-district-profile')).toHaveTextContent('WY/00');
    expect(screen.queryByTestId('canonical-district-profile')).not.toBeInTheDocument();
  });

  it('still falls through to canonical for unclaimed paths', () => {
    renderAt('/help');
    expect(screen.getByTestId('canonical-help')).toBeInTheDocument();
  });
});
