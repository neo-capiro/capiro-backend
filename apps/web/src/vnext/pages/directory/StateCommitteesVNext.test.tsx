import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, test } from 'vitest';
import {
  StateCommitteeProfile,
  chamberLabel,
  type StateCommitteeDetail,
} from './StateCommitteesVNext.js';

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
