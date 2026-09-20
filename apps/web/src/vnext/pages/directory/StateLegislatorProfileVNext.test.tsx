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
    <MemoryRouter
      initialEntries={[
        '/directory/state-legislators/ocd-person%2Fabc-123?client=client-a&folder=folder-a',
      ]}
    >
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
    expect(screen.getByRole('link', { name: 'Open Bill 360 for S 2001' })).toHaveAttribute(
      'href',
      '/bills/bill-1?client=client-a&folder=folder-a',
    );
    expect(screen.getByText('An act relating to courts')).toBeInTheDocument();
    // Missing email keeps canonical's explicit placeholder on this surface.
    expect(screen.getAllByText('Not provided by source').length).toBeGreaterThan(0);
  });

  test('renders reviewed Florida directory facts without replacing canonical OpenStates fields', () => {
    renderView(
      legislator({
        state: 'FL',
        email: 'canonical@flsenate.gov',
        image: 'https://openstates.example/senator.jpg',
        committees: [
          { id: 'com-1', name: 'Canonical Judiciary', chamber: 'upper', role: 'Member' },
        ],
        directoryProfile: {
          source: {
            document: 'SDIR.pdf',
            sha256: 'f'.repeat(64),
            asOfDate: '2026-08-26',
            pages: [17],
          },
          email: 'directory@flsenate.gov',
          portraitUrl: '/florida-directory/portraits/senator.jpg',
          leadershipTitle: 'Minority Leader',
          spouse: 'Jeffrey',
          offices: [
            {
              kind: 'district',
              label: 'District office',
              addressLines: ['3475 Sheridan Street', 'Suite 211', 'Hollywood, FL 33021'],
              phone: '(954) 893-5045',
              voip: '43700',
              fax: null,
            },
            {
              kind: 'tallahassee',
              label: null,
              addressLines: ['304 Senate Building', '404 South Monroe Street'],
              phone: '(850) 487-5037',
              voip: '5037',
              fax: '(850) 555-0100',
            },
          ],
          staff: [
            { name: 'Joanne Alvarez', role: 'Legislative Aide', sourcePage: 17 },
            { name: 'Margarita Gerson', role: 'Legislative Aide', sourcePage: 17 },
          ],
          committeeAssignments: [{ name: 'Directory-only committee', role: 'Vice Chair' }],
        },
      }),
    );

    expect(screen.getByText('Official directory details')).toBeInTheDocument();
    expect(screen.getByText('Minority Leader')).toBeInTheDocument();
    expect(screen.getByText('Jeffrey')).toBeInTheDocument();
    expect(screen.getByText('District office')).toBeInTheDocument();
    expect(screen.getByText('Tallahassee office')).toBeInTheDocument();
    expect(screen.getByText(/3475 Sheridan Street/)).toHaveTextContent(
      '3475 Sheridan Street, Suite 211, Hollywood, FL 33021',
    );
    expect(screen.getByText(/\(954\) 893-5045/)).toHaveTextContent('(954) 893-5045 · VOIP 43700');
    expect(screen.getByText(/\(850\) 487-5037/)).toHaveTextContent(
      '(850) 487-5037 · VOIP 5037 · Fax (850) 555-0100',
    );
    expect(screen.getByText('Legislative staff (2)')).toBeInTheDocument();
    expect(screen.getByText('Joanne Alvarez')).toBeInTheDocument();
    expect(screen.getAllByText('Legislative Aide · Directory page 17')).toHaveLength(2);
    expect(screen.getByText('SDIR.pdf · as of 2026-08-26 · page 17')).toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'canonical@flsenate.gov' })).toHaveAttribute(
      'href',
      'mailto:canonical@flsenate.gov',
    );
    expect(screen.queryByText('directory@flsenate.gov')).toBeNull();
    expect(screen.getByText('Canonical Judiciary')).toBeInTheDocument();
    expect(screen.queryByText('Directory-only committee')).toBeNull();
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
