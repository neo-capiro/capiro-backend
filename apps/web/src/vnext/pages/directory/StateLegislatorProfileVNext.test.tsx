import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi } from 'vitest';
import type { StateLegislatorDetail } from '../../../pages/directory/StateLegislatorDirectory.js';

/**
 * vNext state-legislator profile: the load-bearing rule (from the canonical
 * StateLegislatorProfileView) is the null-vs-empty distinction on
 * sponsoredBills — `null` means "never crosswalked to LegiScan" and must never
 * be collapsed into "sponsors nothing". Contact fields keep canonical's
 * explicit "Not provided by source" placeholders.
 */

vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({}) }));

const { StateLegislatorProfileViewVNext } = await import('./StateLegislatorProfileVNext.js');

function legislator(overrides: Partial<StateLegislatorDetail> = {}): StateLegislatorDetail {
  return {
    id: 'ocd-person/abc-123',
    name: 'Elaine Morgan',
    state: 'RI',
    chamber: 'upper',
    district: '34',
    party: 'Republican',
    email: null,
    image: null,
    url: 'https://example.invalid/morgan',
    active: true,
    legiscanPeopleId: 22841,
    syncedAt: '2026-08-01T00:00:00Z',
    committees: [{ id: 'com-1', name: 'Senate Judiciary', chamber: 'upper', role: 'Member' }],
    sponsoredBills: [
      {
        billId: 'bill-1',
        identifier: 'S 2001',
        title: 'An act relating to courts',
        chamber: 'upper',
        status: '1',
        statusAt: null,
        sponsorType: 'primary',
      },
    ],
    sponsoredBillsTotal: 1,
    ...overrides,
  };
}

function renderView(leg: StateLegislatorDetail) {
  return render(
    <MemoryRouter>
      <StateLegislatorProfileViewVNext legislator={leg} />
    </MemoryRouter>,
  );
}

describe('StateLegislatorProfileViewVNext', () => {
  test('renders identity, chamber label, committees, and sponsored bills', () => {
    renderView(legislator());
    expect(screen.getByRole('heading', { name: 'Elaine Morgan' })).toBeInTheDocument();
    // upper => "Senate (upper)" in the district line and the Contact grid.
    expect(screen.getAllByText(/Senate \(upper\)/).length).toBeGreaterThan(0);
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Senate Judiciary')).toBeInTheDocument();
    expect(screen.getByText('Sponsored bills (1)')).toBeInTheDocument();
    expect(screen.getByText('S 2001')).toBeInTheDocument();
    expect(screen.getByText('An act relating to courts')).toBeInTheDocument();
    // Missing email keeps canonical's explicit placeholder on this surface.
    expect(screen.getAllByText('Not provided by source').length).toBeGreaterThan(0);
  });

  test('null sponsoredBills = never crosswalked: says data unavailable, never "no bills", no count', () => {
    renderView(legislator({ sponsoredBills: null, sponsoredBillsTotal: 0 }));
    expect(
      screen.getByText('Bill sponsorship data not available for this legislator'),
    ).toBeInTheDocument();
    expect(screen.queryByText('No sponsored bills on record')).toBeNull();
    // The count is suppressed for the never-crosswalked case (title has no "(0)").
    expect(screen.getByText('Sponsored bills')).toBeInTheDocument();
  });

  test('empty sponsoredBills = crosswalked but none on record', () => {
    renderView(legislator({ sponsoredBills: [], sponsoredBillsTotal: 0 }));
    expect(screen.getByText('No sponsored bills on record')).toBeInTheDocument();
    expect(
      screen.queryByText('Bill sponsorship data not available for this legislator'),
    ).toBeNull();
    expect(screen.getByText('Sponsored bills (0)')).toBeInTheDocument();
  });
});
