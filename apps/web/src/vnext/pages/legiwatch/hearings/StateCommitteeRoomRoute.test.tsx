import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.fn();
const apiPut = vi.fn();
const apiDelete = vi.fn();
let apiScope = 'tenant-test:self:user-test';
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGet, put: apiPut, delete: apiDelete }),
}));
vi.mock('../../../../lib/use-api-scope.js', () => ({
  useApiScope: () => apiScope,
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
  updates: {
    returned: 1,
    total: 2,
    truncated: true,
    asOf: '2026-09-21T13:00:00.000Z',
    rows: [
      {
        id: 'update-1',
        committeeSystemCode: 'state:FL:legacy-health',
        attributedFromAlias: 'state:FL:legacy-health',
        hearingId: null,
        updateType: 'document_published',
        title: 'Staff analysis published',
        summary: 'The committee published a new staff analysis.',
        sourceUrl: 'https://www.flhouse.gov/analysis.pdf',
        publishedAt: '2026-09-21T12:30:00.000Z',
        firstSeenAt: '2026-09-21T12:31:00.000Z',
        lastSeenAt: '2026-09-21T12:31:00.000Z',
        contentHash: 'hash-1',
        previousValue: null,
        newValue: null,
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
function renderRoom(
  initialEntry = '/legiwatch/committees/FL/fl-lower-health?client=client-7',
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const room = () => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/legiwatch/committees/FL/:stateCommitteeId"
            element={
              <>
                <StateCommitteeRoomRoute />
                <LocationProbe />
              </>
            }
          />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const result = render(room());
  return { ...result, queryClient, rerenderRoom: () => result.rerender(room()) };
}

beforeEach(() => {
  apiScope = 'tenant-test:self:user-test';
  apiGet.mockReset();
  apiPut.mockReset();
  apiDelete.mockReset();
  apiGet.mockImplementation((url: string) => {
    if (url === '/api/clients')
      return Promise.resolve({
        data: [
          {
            id: `client-${apiScope}`,
            name: `Client ${apiScope}`,
            status: 'active',
          },
        ],
      });
    if (url.includes('/committees/')) {
      return Promise.resolve({
        data: {
          committeeSystemCode: 'state:FL:fl-lower-health',
          following: false,
          clientIds: [],
          clients: [],
          notifyOnNewHearing: true,
          notifyOnScheduleChange: true,
          notifyOnTranscriptReady: false,
          notifyOnHighPriorityMatch: true,
          notifyOnPublication: true,
        },
      });
    }
    return Promise.resolve({ data: detail });
  });
  apiPut.mockResolvedValue({ data: { following: true } });
  apiDelete.mockResolvedValue({ data: { following: false } });
});
afterEach(() => vi.clearAllMocks());

describe('StateCommitteeRoomRoute', () => {
  it('renders source-backed Florida committee facts, updates, and Follow controls', async () => {
    const { queryClient } = renderRoom();
    expect(
      await screen.findByRole('heading', { name: 'Health & Human Services Committee' }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Follow committee' })).toHaveLength(2),
    );
    expect(screen.queryByText('Alerts unavailable for Florida')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.getByRole('heading', { name: 'What has been published' })).toBeTruthy();
    expect(screen.getByText('1 OF 2 CHANGES')).toBeTruthy();
    expect(screen.getByText('Showing the 1 most recent of 2 recorded changes.')).toBeTruthy();
    expect(screen.getByText('ATTRIBUTED FROM state:FL:legacy-health')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Staff analysis published' })).toHaveAttribute(
      'href',
      'https://www.flhouse.gov/analysis.pdf',
    );
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
    expect(screen.getByText('Showing 1–1 of 2 bills')).toBeTruthy();
    expect(apiGet).toHaveBeenCalledWith(
      '/api/legiwatch/live-hearings/state-committees/fl-lower-health',
      { params: { referralPage: 1 } },
    );
    expect(
      queryClient.getQueryData([
        'lw-vnext',
        'state-committee-room',
        'tenant-test:self:user-test',
        'fl-lower-health',
        1,
      ]),
    ).toEqual(detail);
  });

  it('opens referral pages from the server and preserves the committee and client scope', async () => {
    const fallback = apiGet.getMockImplementation()!;
    apiGet.mockImplementation((url: string, config?: { params?: { referralPage?: number } }) => {
      if (url.includes('/state-committees/')) {
        const page = config?.params?.referralPage ?? 1;
        return Promise.resolve({ data: { ...detail, referredBills: { total: 26, page, pageSize: 25, rows: page === 1 ? Array.from({ length: 25 }, (_, i) => ({ ...detail.referredBills.rows[0], id: `bill-${i}`, title: `Bill ${i}` })) : [{ ...detail.referredBills.rows[0], id: 'bill-last', title: 'Last referred bill' }] } } });
      }
      return fallback(url);
    });
    renderRoom('/legiwatch/committees/FL/fl-lower-health?section=records&client=client-7');
    expect(await screen.findByText('Showing 1–25 of 26 bills')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Previous bills' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next bills' }));
    expect(await screen.findByText('Last referred bill')).toBeTruthy();
    expect(screen.getByText('Showing 26–26 of 26 bills')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next bills' })).toBeDisabled();
    expect(screen.getByTestId('location')).toHaveTextContent('client=client-7');
    expect(screen.getByTestId('location')).toHaveTextContent('referralPage=2');
    fireEvent.click(screen.getByRole('button', { name: 'Previous bills' }));
    expect(await screen.findByText('Bill 0')).toBeTruthy();
  });

  it('opens legacy update deep links, preserves the client lens, and normalizes section navigation', async () => {
    renderRoom(
      '/legiwatch/committees/FL/fl-lower-health?tab=updates&client=client-7',
    );

    expect(await screen.findByRole('heading', { name: 'What has been published' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Proceedings' })).toBeNull();
    expect(screen.getByTestId('location')).toHaveTextContent(
      '/legiwatch/committees/FL/fl-lower-health?tab=updates&client=client-7',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Overview' }));
    await waitFor(() =>
      expect(screen.getByTestId('location')).toHaveTextContent(
        '/legiwatch/committees/FL/fl-lower-health?client=client-7',
      ),
    );
  });

  it('uses the canonical namespaced Florida key for Follow settings', async () => {
    renderRoom();
    const followButton = (await screen.findAllByRole('button', { name: 'Follow committee' }))[0]!;
    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(
        '/api/legiwatch/live-hearings/committees/state%3AFL%3Afl-lower-health/follow',
      ),
    );

    fireEvent.click(followButton);
    expect(await screen.findByText('Follow this committee')).toBeTruthy();
    expect(screen.getByText('Committee publications')).toBeTruthy();
    expect(screen.getAllByText('Health & Human Services Committee').length).toBeGreaterThan(1);
  });

  it('refetches the Follow dialog client list when the tenant API scope changes', async () => {
    const { queryClient, rerenderRoom } = renderRoom();
    const followButton = (await screen.findAllByRole('button', { name: 'Follow committee' }))[0]!;
    await waitFor(() => expect(followButton).not.toBeDisabled());
    fireEvent.click(followButton);
    expect(await screen.findByText('Follow this committee')).toBeTruthy();
    await waitFor(() =>
      expect(queryClient.getQueryData(['clients', 'tenant-test:self:user-test'])).toEqual([
        expect.objectContaining({ id: 'client-tenant-test:self:user-test' }),
      ]),
    );

    apiScope = 'tenant-other:self:user-other';
    rerenderRoom();

    await waitFor(() =>
      expect(queryClient.getQueryData(['clients', 'tenant-other:self:user-other'])).toEqual([
        expect.objectContaining({ id: 'client-tenant-other:self:user-other' }),
      ]),
    );
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
