import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberDetail } from '../../../../pages/directory/directory-api.js';
import { CommitteeRoomRoute } from './CommitteeRoomRoute.js';
import { VNextDirectoryRoutes } from '../../directory/VNextDirectoryRoutes.js';
// Warm the lazy member-profile route chunk once at import time. The click
// target renders through VNextDirectoryRoutes, which lazy-imports
// MemberProfileVNext on first mount; under the broad runner's default
// findBy window (1s) that first dynamic import could not resolve. Eagerly
// importing it here keeps the test's waits about DATA, not module loading,
// and preserves every assertion below untouched.
import '../../directory/MemberProfileVNext.js';

const apiGet = vi.fn<(url: string) => Promise<{ data: unknown }>>();
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => ({ get: apiGet }) }));
vi.mock('../../../../lib/me.js', () => ({ useMe: () => ({ isLoading: false, data: undefined }) }));
vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ isLoaded: true, orgId: 'org-test', userId: 'user-test' }),
}));

// Actual roster contract: `id` identifies a membership, `bioguideId` a person.
const MEMBERSHIP = {
  id: 'c0b2e59a-74ee-4b6b-8712-2e17e09ad41b', bioguideId: 'R000500',
  name: 'Mike Rogers', party: 'R', side: 'majority', rank: 1, role: 'Chair',
};
const ROOM = {
  systemCode: 'hsas00', name: 'Armed Services', chamber: 'House', isSubcommittee: false,
  parent: null, subcommittees: [], sourceHealth: 'unknown', sourceHealthInheritedFrom: null,
  members: [MEMBERSHIP], chair: MEMBERSHIP, rankingMember: null,
  upcomingEvents: [], recentEvents: [], updates: [],
};
const MEMBER: MemberDetail = {
  kind: 'member', id: 'member-500',
  source: { snapshotId: 'test-snapshot', memberId: 500, lastUpdatedAt: null },
  identity: {
    memberId: 500, bioguideId: 'R000500', icpsrId: null, lisMemberId: null,
    firstName: 'Mike', lastName: 'Rogers', preferredFirstName: null,
    preferredLastName: null, suffix: null, gender: null,
  },
  bioDetails: {
    dob: null, dateOfDeath: null, placeOfBirth: null, hometown: null, nativeOf: null,
    majMin: null, partyName: 'Republican', occupation: null, pronunciation: null,
    raceName: null, religionName: null,
  },
  photos: [], selectedPhotoUrl: null, photoSource: null, offices: [], officeAddresses: [],
  committees: [], leaderships: [], socialContacts: [], staffRoles: [], staffIssues: [],
  enrichments: { bioOverlay: false, pressOverlay: false },
};

let room = ROOM;
let queryClient: QueryClient;

beforeEach(() => {
  room = ROOM;
  apiGet.mockReset();
  apiGet.mockImplementation(async (url) => {
    if (url === '/api/legiwatch/live-hearings/committees/hsas00') return { data: room };
    if (url.endsWith('/hsas00/follow')) return { data: { following: false, clientIds: [] } };
    if (url.includes('/hsas00/intelligence-history')) return { data: { rows: [], total: 0 } };
    if (url === '/api/directory/members/R000500' || url === '/api/directory/members/member-500') {
      return { data: MEMBER };
    }
    if (url === '/api/directory/contacts/member-500/trips') return { data: { trips: [] } };
    throw new Error(`Unexpected API request: ${url}`);
  });
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
  window.history.replaceState({}, '', '/');
});

function renderAt(path: string) {
  window.history.replaceState({ idx: 0 }, '', path);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/legiwatch/committees/:systemCode" element={<CommitteeRoomRoute />} />
          <Route path="/directory/members/:memberId" element={<VNextDirectoryRoutes />} />
          <Route path="/directory/people/:memberId" element={<VNextDirectoryRoutes />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>,
  );
}

describe('LW-06 committee member navigation', () => {
  it.each(['leadership', 'roster'])('%s opens the real member profile, then restores the scoped room on Back', async (entry) => {
    const origin = '/legiwatch/committees/hsas00?clientId=client-test&tab=members';
    renderAt(origin);
    const buttons = await screen.findAllByRole('button', { name: /Mike Rogers/ });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[entry === 'leadership' ? 0 : 1]!);
    await screen.findByTestId('member-profile');
    expect(window.location.pathname).toBe('/directory/members/R000500');
    expect(screen.getByText('Bioguide R000500')).toBeInTheDocument();
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/api/directory/contacts/member-500/trips'));
    expect(apiGet.mock.calls.some(([url]) => url.includes(MEMBERSHIP.id) || url.includes('/contacts/R000500'))).toBe(false);
    fireEvent.click(screen.getByTestId('profile-back-link'));
    await waitFor(() => expect(`${window.location.pathname}${window.location.search}`).toBe(origin));
    expect(await screen.findAllByRole('button', { name: /Mike Rogers/ })).toHaveLength(2);
  });

  it.each(['member-500', 'R000500'])('keeps a valid legacy member alias usable: %s', async (id) => {
    renderAt(`/directory/people/${id}`);
    await screen.findByTestId('member-profile');
    expect(apiGet).toHaveBeenCalledWith(`/api/directory/members/${id}`);
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/api/directory/contacts/member-500/trips'));
  });

  it('does not offer a membership UUID or staff ID as a member-profile destination', async () => {
    room = { ...ROOM, chair: { ...MEMBERSHIP, bioguideId: '' }, members: [{ ...MEMBERSHIP, bioguideId: '', id: 'staff-500' }] };
    renderAt('/legiwatch/committees/hsas00?tab=members');
    const buttons = await screen.findAllByRole('button', { name: /Mike Rogers/ });
    for (const button of buttons) {
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', 'A member profile identity is unavailable for this roster entry.');
    }
    expect(screen.getAllByText('Profile unavailable')).toHaveLength(2);
    expect(apiGet.mock.calls.some(([url]) => url.startsWith('/api/directory/'))).toBe(false);
  });
});
