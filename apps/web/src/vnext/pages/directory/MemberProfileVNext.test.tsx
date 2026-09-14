import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, test, vi } from 'vitest';
import type { MemberDetail } from '../../../pages/directory/directory-api.js';

/**
 * Parity suite for the vNext member profile page: mirrors the canonical
 * `MemberDirectoryProfilePage.test.tsx` (MemberProfileView) fixture-for-fixture
 * and assertion-for-assertion, so the two surfaces are held to the same data
 * behaviour — present fields render, empty fields vanish (no "Not provided by
 * source" placeholders), committee/social links point at canonical routes.
 */

// The view renders ContactTripsSectionVNext, which fetches its own data via
// useApi() — mock it so this stays a pure render test (canonical pattern).
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: vi.fn().mockResolvedValue({ data: { contactId: '', trips: [] } }) }),
}));

const { MemberProfileViewVNext } = await import('./MemberProfileVNext.js');

const MEMBER: MemberDetail = {
  kind: 'member',
  id: 'member-500',
  source: { snapshotId: 's', memberId: 500, lastUpdatedAt: '2026-07-01T00:00:00Z' },
  identity: {
    memberId: 500,
    bioguideId: 'R000500',
    icpsrId: null,
    lisMemberId: null,
    firstName: 'Mike',
    lastName: 'Rogers',
    preferredFirstName: 'Mike',
    preferredLastName: null,
    suffix: null,
    gender: 'M',
  },
  bioDetails: {
    dob: null,
    dateOfDeath: null,
    placeOfBirth: null,
    hometown: 'Saks, AL',
    nativeOf: null,
    majMin: null,
    partyName: 'Republican',
    occupation: null,
    pronunciation: null,
    raceName: null,
    religionName: null,
  },
  photos: [{ id: 9, url: 'https://x.invalid/r.jpg', status: 'public', isPrimary: false, isDirectory: true, updatedAt: null }],
  selectedPhotoUrl: 'https://x.invalid/r.jpg',
  photoSource: 'legistorm',
  offices: [{ officeId: 950, name: 'Rep. Rogers Office', officeTypeId: 'HM', state: 'AL', district: '3', party: 'R', senateClass: null, outgoingStatus: null, status: 'In office', startDate: null, endDate: null, updatedAt: null }],
  officeAddresses: [],
  committees: [
    {
      committeeId: 'committee-100',
      committeeName: 'House Armed Services Committee',
      person: { personType: 'member', id: 'member-500', sourceId: 500, fullName: 'Mike Rogers', title: 'Chair', photoUrl: null, photoSource: null, party: 'R', state: 'AL', district: '3', isCurrent: true },
      membershipType: 'member',
      position: 'Chair',
      party: 'R',
      rank: 1,
      status: null,
      startedAt: null,
      endedAt: null,
      sourceUpdatedAt: null,
    },
  ],
  leaderships: [{ position: 'Chairman', startDate: null, endDate: null, updatedAt: null }],
  socialContacts: [{ type: 'Website', value: 'https://rogers.house.gov', updatedAt: null }],
  staffRoles: [],
  staffIssues: [],
  enrichments: { bioOverlay: false, pressOverlay: false },
};

describe('MemberProfileViewVNext', () => {
  test('renders present fields, committee link, leadership; hides empty fields', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <MemberProfileViewVNext member={MEMBER} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByRole('heading', { name: 'Mike Rogers' })).toBeInTheDocument();
    const committeeLink = screen.getByRole('link', { name: 'House Armed Services Committee' });
    expect(committeeLink).toHaveAttribute('href', '/directory/committees/committee-100');
    expect(screen.getByText('Chairman')).toBeInTheDocument();
    // Present bio field renders...
    expect(screen.getByText('Saks, AL')).toBeInTheDocument();
    // ...while null fields (dob/occupation/etc.) are hidden entirely, not labeled.
    expect(screen.queryByText('Not provided by source')).toBeNull();
    expect(screen.queryByText('Date of birth')).toBeNull();
    // party + photo provenance pills and the bioguide line
    expect(screen.getByText('Republican')).toBeInTheDocument();
    expect(screen.getByText('Source photo')).toBeInTheDocument();
    expect(screen.getByText('Bioguide R000500')).toBeInTheDocument();
    // social link present
    expect(screen.getByRole('link', { name: 'https://rogers.house.gov' })).toBeInTheDocument();
    // the selected photo is flagged in the gallery
    expect(screen.getByText('Selected')).toBeInTheDocument();
  });
});
