import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.fn();
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => ({ get: apiGet }) }));
vi.mock('../../../../lib/use-api-scope.js', () => ({
  useApiScope: () => 'tenant-test:self:user-test',
}));
import { readableDate, StateCommitteeRoomRoute } from './StateCommitteeRoomRoute.js';

const detail = {
  body: {
    id: 'fl-lower-health',
    name: 'Health & Human Services Committee',
    state: 'FL',
    chamber: 'lower',
    legislativeSession: '2027',
    officialSourceKey: 'FL:H:HEALTH',
    sourceUrl: 'https://www.flhouse.gov/Sections/Committees/committeesdetail.aspx?CommitteeId=1',
    sourceEvidence: {
      directory: {
        sourceUrl:
          'https://www.flhouse.gov/Sections/Committees/committeesdetail.aspx?CommitteeId=1',
      },
    },
    legiscanCommitteeId: 18,
    lastSyncedAt: '2026-09-21T12:00:00.000Z',
  },
  members: [
    {
      id: 'ocd-person/abc',
      name: 'Alex Rivera',
      role: 'Chair',
      party: 'D',
      district: '42',
      active: true,
    },
  ],
  rosterStatus: 'source_memberships',
  upcomingEvents: {
    total: 2,
    rows: [
      {
        id: 'hearing-1',
        title: 'Health care appropriations hearing',
        date: '2026-10-01',
        startsAt: null,
        time: '10:00 AM',
        eventStatus: 'scheduled',
        eventType: 'meeting',
        location: 'Webster Hall',
        streamAvailability: 'live_only',
        coverageStatus: 'stream_ready',
        agenda: [{ title: 'HB 101', sourceUrl: 'https://www.flhouse.gov/agenda.pdf' }],
        documents: [{ title: 'Staff analysis', url: 'https://www.flhouse.gov/analysis.pdf' }],
      },
    ],
  },
  recentEvents: { total: 0, rows: [] },
  sourceCoverage: [
    {
      chamber: 'house',
      status: 'success',
      from: '2026-09-01',
      to: '2026-11-01',
      attemptedAt: '2026-09-21T12:00:00.000Z',
      items: 8,
      sourceHealth: 'healthy',
      lastCheckedAt: '2026-09-21T12:00:00.000Z',
      lastSuccessAt: '2026-09-21T12:00:00.000Z',
      lastErrorAt: null,
      lastError: null,
      sourceUrl: 'https://www.flhouse.gov/Sections/Committees/meetingnotices.aspx',
      adapterKey: 'florida-house-calendar',
    },
  ],
  referredBills: {
    total: 2,
    rows: [
      {
        id: 'FL-HB-101',
        identifier: 'HB 101',
        title: 'Health Services',
        status: 'referred',
        latestActionDate: '2026-09-20',
        latestActionText: 'Referred to committee',
        stateUrl: 'https://www.flhouse.gov/HB101',
        url: null,
        calendarEvents: [
          {
            id: 'bill-calendar-1',
            eventType: 'committee_hearing',
            date: '2026-10-03',
            time: '2:00 PM',
            location: 'Webster Hall',
            description: 'On committee agenda',
          },
        ],
      },
    ],
  },
  directoryProfile: {
    contacts: [
      {
        location: 'Webster Hall',
        mailingAddress: '402 South Monroe Street',
        phone: '850-555-0100',
        voip: null,
      },
    ],
    jurisdiction: 'Health policy and appropriations.',
    leadership: [{ name: 'Alex Rivera', role: 'Chair' }],
    staff: [
      {
        name: 'Taylor Morgan',
        role: 'Staff Director',
        email: 'taylor@example.gov',
        phone: '850-555-0101',
        sourcePage: 4,
      },
    ],
    sources: [{ document: 'House directory', sha256: 'abc', asOfDate: '2026-09-01', pages: [4] }],
  },
};

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
    </output>
  );
}
function renderRoom() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/legiwatch/committees/FL/fl-lower-health?client=client-7']}>
        <Routes>
          <Route
            path="/legiwatch/committees/FL/:stateCommitteeId"
            element={<StateCommitteeRoomRoute />}
          />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

beforeEach(() => {
  apiGet.mockReset();
  apiGet.mockResolvedValue({ data: detail });
});
afterEach(() => vi.clearAllMocks());

describe('StateCommitteeRoomRoute', () => {
  it('renders source-backed Florida committee facts and labels unsupported alerts', async () => {
    const { queryClient } = renderRoom();
    expect(
      await screen.findByRole('heading', { name: 'Health & Human Services Committee' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('status', { name: 'Florida committee alerts unavailable' }),
    ).toHaveTextContent('Alerts unavailable for Florida');
    expect(
      screen.queryByRole('button', { name: 'Florida committee alerts unavailable' }),
    ).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getAllByText(/SOURCE HEALTHY/i).length).toBeGreaterThan(0);
    expect(screen.getByText('Taylor Morgan')).toBeTruthy();
    expect(screen.getByText(/850-555-0101/)).toBeTruthy();
    expect(screen.getByText(/Directory page 4/)).toBeTruthy();
    expect(screen.getByText(/402 South Monroe Street/)).toBeTruthy();
    expect(screen.getByText(/House directory · as of Sep 1, 2026 · page 4/)).toBeTruthy();
    expect(screen.getByText('Staff analysis')).toBeTruthy();
    expect(screen.getByText('Health Services')).toBeTruthy();
    expect(screen.getByText(/LegiScan bill calendar/)).toHaveTextContent('Oct 3, 2026');
    expect(screen.getByText('Showing 1 of 2 proceedings in this one-year window.')).toBeTruthy();
    expect(screen.getByText('Showing 1 of 2 currently referred bills.')).toBeTruthy();
    expect(apiGet).toHaveBeenCalledWith(
      '/api/legiwatch/live-hearings/state-committees/fl-lower-health',
    );
    expect(
      queryClient.getQueryData([
        'lw-vnext',
        'state-committee-room',
        'tenant-test:self:user-test',
        'fl-lower-health',
      ]),
    ).toEqual(detail);
  });

  it('links members to state profiles and preserves the client lens', async () => {
    renderRoom();
    const member = await screen.findByRole('link', { name: /Alex Rivera/ });
    expect(member.getAttribute('href')).toBe(
      '/directory/state-legislators/ocd-person%2Fabc?client=client-7',
    );
  });

  it('does not label OpenStates-published provenance as official', async () => {
    apiGet.mockResolvedValueOnce({
      data: {
        ...detail,
        body: {
          ...detail.body,
          officialSourceKey: null,
          sourceUrl: null,
          sourceEvidence: {
            openstates: {
              committeeId: 'ocd-organization/openstates-health',
              links: [
                {
                  note: 'Committee detail',
                  url: 'https://openstates.org/fl/committees/openstates-health/',
                },
              ],
            },
          },
        },
      },
    });
    renderRoom();

    expect(await screen.findByRole('link', { name: 'Published source ↗' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Official source ↗' })).toBeNull();
    expect(screen.getByText('Published identity · official verification unavailable')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'OpenStates · Committee detail ↗' })).toBeTruthy();
  });

  it('opens the canonical hearing detail with the selected client', async () => {
    renderRoom();
    const proceeding = await screen.findByRole('button', {
      name: /Health care appropriations hearing/,
    });
    fireEvent.click(proceeding);
    expect(await screen.findByTestId('location')).toHaveTextContent(
      '/legiwatch/hearings/hearing-1?client=client-7',
    );
  });

  it('formats date-only values with UTC semantics', () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      expect(readableDate('2026-10-01')).toBe('Oct 1, 2026');
    } finally {
      process.env.TZ = previousTimezone;
    }
  });
});
