import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  StateCommitteesVNext,
  StateCommitteeProfile,
  chamberLabel,
  type StateCommitteeDetail,
} from './StateCommitteesVNext.js';

const get = vi.fn();
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({ get }) }));
vi.mock('../../../lib/use-api-scope.js', () => ({ useApiScope: () => 'tenant:test-user' }));
// Regression harness: authenticated state committee reads are public-record
// access. Even a workspace whose legacy flag is false must render this route.
vi.mock('../../../lib/intel-feature-flags.js', () => ({
  STATE_CALENDAR_FEATURE: 'legiwatch_state_calendar_v1',
  useIntelFeatureEnabled: () => false,
}));

const DETAIL: StateCommitteeDetail = {
  body: {
    id: 'official-commerce',
    name: 'Commerce Committee',
    state: 'FL',
    chamber: 'lower',
    legislativeSession: '2026',
    officialSourceKey: 'FL:2026:fl:house:committee:3294',
    sourceUrl: 'https://www.flhouse.gov/Sections/Committees/committeesdetail.aspx?CommitteeId=3294',
    sourceEvidence: {
      directory: {
        sourceUrl:
          'https://www.flhouse.gov/Sections/Committees/committeesdetail.aspx?CommitteeId=3294',
        aliasIds: ['FL-lower-commerce'],
      },
      openstates: {
        committeeId: 'ocd-organization/fl-commerce',
        classification: 'committee',
        parentId: null,
        links: [{ url: 'https://openstates.org/fl/committees/FLC000101/', note: 'OpenStates' }],
        sources: [],
      },
    },
    legiscanCommitteeId: 501,
    lastSyncedAt: '2026-09-20T10:00:00Z',
  },
  rosterStatus: 'source_memberships',
  sourceCommitteeIds: ['official-commerce', 'FL-lower-commerce'],
  relatedLegacyBodies: [{ id: 'FL-lower-commerce', name: 'Commerce', chamber: 'lower' }],
  members: [
    {
      id: 'ocd-person/chair',
      name: 'James Buchanan',
      role: 'Chair · Member',
      roles: ['Chair', 'Member'],
      party: 'Republican',
      district: '74',
      email: 'james@example.gov',
      image: 'https://example.gov/chair.jpg',
      active: true,
      sourceCommitteeIds: ['official-commerce', 'FL-lower-commerce'],
      lastSyncedAt: '2026-09-19T00:00:00Z',
    },
    {
      id: 'ocd-person/member',
      name: 'Elaine Morgan',
      role: 'Member',
      roles: ['Member'],
      party: 'Democratic',
      district: '12',
      email: null,
      image: null,
      active: false,
      sourceCommitteeIds: ['FL-lower-commerce'],
      lastSyncedAt: '2026-09-18T00:00:00Z',
    },
  ],
  upcomingEvents: {
    total: 1,
    rows: [
      {
        id: 'state-fl-hearing-1',
        title: 'Commerce Committee Meeting',
        date: '2026-09-24',
        startsAt: '2026-09-24T14:00:00Z',
        time: '10:00 AM',
        eventStatus: 'scheduled',
        eventType: 'committee',
        location: 'Room 212, Knott Building',
        streamAvailability: 'live_only',
        coverageStatus: 'stream_ready',
        agenda: [{ key: 'SB50' }],
      },
    ],
  },
  recentEvents: { total: 0, rows: [] },
  referredBills: {
    total: 1,
    rows: [
      {
        id: 'fl-2026-hb123',
        identifier: 'HB 123',
        title: 'Consumer protection',
        status: 'in_committee',
        latestActionDate: '2026-09-18',
        latestActionText: 'Referred to Commerce Committee',
        stateUrl: 'https://www.flhouse.gov/Sections/Bills/billsdetail.aspx?BillId=123',
        url: null,
        syncedAt: '2026-09-20T00:00:00Z',
        calendarEvents: [
          {
            id: 'calendar-1',
            eventType: 'hearing',
            date: '2026-09-24',
            time: '10:00 AM',
            location: 'Room 212',
            description: 'On the committee agenda',
          },
        ],
      },
    ],
  },
  sourceCoverage: [
    {
      chamber: 'house',
      status: 'partial',
      from: '2026-09-01',
      to: '2026-09-30',
      attemptedAt: '2026-09-20T10:00:00Z',
      items: 18,
      sourceHealth: 'degraded',
      lastCheckedAt: '2026-09-20T10:00:00Z',
      lastSuccessAt: '2026-09-19T10:00:00Z',
      lastErrorAt: '2026-09-20T10:00:00Z',
      lastError: 'One published notice was temporarily unavailable',
      sourceUrl: 'https://www.flhouse.gov/Sections/HouseSchedule/houseschedule.aspx',
      adapterKey: 'florida-house',
    },
  ],
  directoryProfile: {
    jurisdiction: 'Considers commerce, tourism, banking, insurance, and regulated industries.',
    contacts: [
      {
        location: '214 House Office Building',
        mailingAddress: '402 South Monroe Street, Tallahassee, FL 32399-1300',
        phone: '(850) 717-4870',
        voip: null,
      },
    ],
    leadership: [{ name: 'Rep. Buchanan', role: 'Chair' }],
    staff: [
      {
        name: 'Kurt Hamon',
        role: 'Staff Director',
        email: null,
        phone: null,
        sourcePage: 47,
      },
    ],
    sources: [
      {
        document: 'HouseDirectory.pdf',
        sha256: 'a'.repeat(64),
        asOfDate: '2026-06-04',
        pages: [47],
      },
    ],
  },
};

const FLORIDA_DIRECTORY_RESOURCES = {
  jurisdiction: 'FL' as const,
  legislativeSession: '2026',
  sources: {
    house: { document: 'HouseDirectory.pdf', sha256: 'a'.repeat(64), asOfDate: '2026-06-04' },
    senate: { document: 'SDIR.pdf', sha256: 'b'.repeat(64), asOfDate: '2026-08-26' },
  },
  officeDirectoryPages: [
    {
      chamber: 'senate' as const,
      pageNumber: 2,
      lines: ['General Counsel: Tom Thomas', 'Administrative Assistant: Michelle Zaleski'],
      phones: ['(850) 487-5237'],
      emails: [],
      source: {
        document: 'SDIR.pdf',
        sha256: 'b'.repeat(64),
        asOfDate: '2026-08-26',
        textSha256: 'c'.repeat(64),
      },
    },
    {
      chamber: 'house' as const,
      pageNumber: 7,
      lines: ['The Leadership of the Florida House of Representatives'],
      phones: [],
      emails: [],
      source: {
        document: 'HouseDirectory.pdf',
        sha256: 'a'.repeat(64),
        asOfDate: '2026-06-04',
        textSha256: 'd'.repeat(64),
      },
    },
  ],
  meetingRooms: [
    {
      room: '110 Senate Building',
      description: 'Toni Jennings Committee Room, Entrance Level',
      source: { document: 'SDIR.pdf', sha256: 'b'.repeat(64), asOfDate: '2026-08-26' },
    },
  ],
};

function LocationProbe() {
  const location = useLocation();
  return <pre data-testid="location-state">{JSON.stringify(location.state)}</pre>;
}

function renderProfile(detail = DETAIL) {
  return render(
    <MemoryRouter initialEntries={['/directory/state-committees/official-commerce']}>
      <Routes>
        <Route
          path="/directory/state-committees/:id"
          element={<StateCommitteeProfile detail={detail} />}
        />
        <Route path="/legiwatch/hearings/:id" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

function renderDirectory() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/directory/state-committees']}>
        <Routes>
          <Route path="/directory/state-committees" element={<StateCommitteesVNext />} />
          <Route
            path="/directory/state-committees/:id"
            element={<StateCommitteesVNext id="official-commerce" />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('StateCommitteesVNext authenticated routing', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockImplementation((url: string) => {
      if (url === '/api/legiwatch/live-hearings/state-committees') {
        return Promise.resolve({ data: [DETAIL.body] });
      }
      if (url === '/api/legiwatch/live-hearings/state-committees/official-commerce') {
        return Promise.resolve({ data: DETAIL });
      }
      if (url === '/api/legiwatch/live-hearings/state-directory/florida') {
        return Promise.resolve({ data: FLORIDA_DIRECTORY_RESOURCES });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
  });

  test('shows the directory and navigates to a profile even when the legacy tenant flag is false', async () => {
    renderDirectory();

    const committee = await screen.findByRole('link', { name: /Commerce Committee/i });
    expect(screen.getByRole('link', { name: 'State Committees' })).toHaveAttribute(
      'href',
      '/directory/state-committees',
    );
    fireEvent.click(committee);

    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(
        '/api/legiwatch/live-hearings/state-committees/official-commerce',
      ),
    );
    expect(await screen.findByRole('heading', { name: 'Commerce Committee' })).toBeInTheDocument();
    expect(screen.queryByText(/not enabled for this workspace/i)).toBeNull();
  });

  test('loads reviewed chamber pages and Senate rooms only when the reference is opened', async () => {
    renderDirectory();
    await screen.findByRole('link', { name: /Commerce Committee/i });
    expect(get).not.toHaveBeenCalledWith('/api/legiwatch/live-hearings/state-directory/florida');

    fireEvent.click(
      screen.getByRole('button', { name: 'Browse chamber offices and meeting rooms' }),
    );

    expect(await screen.findByText('110 Senate Building')).toBeInTheDocument();
    expect(screen.getByText(/HouseDirectory\.pdf · as of 2026-06-04/)).toBeInTheDocument();
    expect(screen.getByText('2 of 2 source pages')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Tom Thomas' })).toBeNull();

    fireEvent.change(screen.getByLabelText('Search chamber directory excerpts'), {
      target: { value: 'General Counsel' },
    });
    expect(screen.getByText('1 of 2 source pages')).toBeInTheDocument();
    expect(screen.getByText('Senate directory · page 2')).toBeInTheDocument();
    expect(screen.queryByText('House directory · page 7')).toBeNull();
  });
});

describe('state committee directory labels', () => {
  test.each([
    ['lower', 'House'],
    ['house', 'House'],
    ['upper', 'Senate'],
    ['senate', 'Senate'],
    ['joint', 'Joint'],
    [null, 'Chamber unconfirmed'],
  ])('renders %s as %s', (raw, label) => {
    expect(chamberLabel(raw)).toBe(label);
  });
});

describe('StateCommitteeProfile', () => {
  test('uses the federal profile primitives while preserving richer state data', () => {
    const { container } = renderProfile();
    expect(container.querySelector('.capiro-dirpage')).not.toBeNull();
    expect(container.querySelector('.capiro-dirpage__hero')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Commerce Committee' })).toBeInTheDocument();
    expect(screen.getByText('2 members · 1 upcoming · 0 recent')).toBeInTheDocument();

    const roster = screen.getByTestId('state-committee-roster');
    expect(within(roster).getByRole('link', { name: 'James Buchanan' })).toHaveAttribute(
      'href',
      '/directory/state-legislators/ocd-person%2Fchair',
    );
    expect(within(roster).getByText('Chair · Member')).toBeInTheDocument();
    expect(within(roster).getByText('District 74')).toBeInTheDocument();
    expect(within(roster).getByRole('link', { name: 'Email' })).toHaveAttribute(
      'href',
      'mailto:james@example.gov',
    );

    expect(screen.getByText('OpenStates committee identity')).toBeInTheDocument();
    expect(screen.getByText('ocd-organization/fl-commerce · Committee')).toBeInTheDocument();
    expect(screen.getByText('LegiScan committee identity')).toBeInTheDocument();
    expect(screen.getByText('Committee 501')).toBeInTheDocument();
    expect(screen.getByText(/Latest source error:/)).toHaveTextContent(
      'One published notice was temporarily unavailable',
    );
    expect(screen.getByRole('link', { name: /HB 123/ })).toHaveAttribute(
      'href',
      '/bills/fl-2026-hb123',
    );
    expect(screen.getByText(/LegiScan bill calendar/)).toHaveTextContent(
      'Hearing · 2026-09-24 · 10:00 AM · Room 212',
    );
    expect(screen.getByText('Official directory details')).toBeInTheDocument();
    expect(screen.getByText(/Phone: \(850\) 717-4870/)).toBeInTheDocument();
    expect(screen.getByText(/Considers commerce/)).toBeInTheDocument();
    expect(screen.getByText('Professional staff (1)')).toBeInTheDocument();
    expect(screen.getByText('Kurt Hamon')).toBeInTheDocument();
    expect(screen.getByText(/HouseDirectory\.pdf · as of 2026-06-04/)).toBeInTheDocument();
  });

  test('filters the roster by leadership, current status, and search', () => {
    renderProfile();
    fireEvent.click(screen.getByRole('button', { name: 'Leadership' }));
    expect(screen.getByRole('link', { name: 'James Buchanan' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Elaine Morgan' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Members' }));
    fireEvent.click(screen.getByRole('button', { name: 'Current only' }));
    expect(screen.queryByRole('link', { name: 'Elaine Morgan' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.change(screen.getByLabelText('Filter by name or role'), {
      target: { value: 'democratic' },
    });
    expect(screen.getByRole('link', { name: 'Elaine Morgan' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'James Buchanan' })).toBeNull();
  });

  test('carries the state profile return target into hearing detail', () => {
    renderProfile();
    fireEvent.click(screen.getByRole('link', { name: 'Commerce Committee Meeting' }));
    expect(screen.getByTestId('location-state')).toHaveTextContent(
      '/directory/state-committees/official-commerce',
    );
  });
});
