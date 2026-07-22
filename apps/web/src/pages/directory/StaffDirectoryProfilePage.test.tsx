import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { StaffProfileView } from './StaffProfileView.js';
import type { StaffDetail } from './directory-api.js';

function setupAntdBrowserMocks() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
}

const STAFF: StaffDetail = {
  kind: 'staff',
  id: 'staff-800',
  source: { snapshotId: 's', staffId: 800, lastUpdatedAt: null },
  identity: { staffId: 800, firstName: 'Grace', lastName: 'Hopper', preferredFirstName: null, preferredLastName: null, suffix: null, gender: 'F' },
  bioDetails: {
    dob: null,
    dateOfDeath: null,
    hometown: 'New York, NY',
    placeOfBirth: null,
    nativeOf: null,
    majMin: 'Majority',
    partyName: null,
    occupation: 'Counsel',
    pronunciation: null,
    raceName: null,
    religionName: null,
  },
  photoUrl: null,
  photoSource: null,
  emails: [{ type: 'Email', value: 'grace.hopper@hasc.house.gov', updatedAt: null }],
  socialContacts: [],
  officeAddresses: [
    {
      addressId: 77,
      officeId: 950,
      officeName: 'Rep. Rogers Office',
      label: 'Washington DC Office',
      address1: '2469 Rayburn HOB',
      address2: null,
      city: 'Washington',
      state: 'DC',
      zip: '20515',
      zipExt: null,
      phone: '202-225-3261',
      fax: '202-226-8485',
      isMain: true,
      publicNotes: null,
      updatedAt: null,
    },
  ],
  positions: [
    { officeId: 100, officeName: 'House Armed Services Committee', memberId: null, title: 'Staff Director', positionType: 'ch', isCurrent: true, isOnLeave: false, startDate: null, endDate: null, updatedAt: null, member: null },
  ],
  memberAssociations: [{ id: 'member-500', memberId: 500, fullName: 'Mike Rogers', party: 'R', state: 'AL', district: '3' }],
  issues: [{ issueName: 'Armed forces and national security', memberId: 500, memberName: 'Mike Rogers', updatedAt: null }],
  roles: [{ roleName: 'Legislative Director', memberId: 500, memberName: 'Mike Rogers', updatedAt: null }],
  committeeAssociations: [
    {
      committeeId: 'committee-100',
      person: { personType: 'staff', id: 'staff-800', sourceId: 800, fullName: 'Grace Hopper', title: 'Staff Director', photoUrl: null, photoSource: null, party: null, state: null, district: null, isCurrent: true },
      membershipType: 'staff',
      position: 'Staff Director',
      party: null,
      rank: null,
      status: 'current',
      startedAt: null,
      endedAt: null,
      sourceUpdatedAt: null,
    },
  ],
  availability: { photo: 'not_provided', socialContacts: 'not_provided' },
};

describe('StaffProfileView', () => {
  beforeAll(setupAntdBrowserMocks);

  test('renders positions, member + committee association links, and availability', () => {
    render(
      <MemoryRouter>
        <StaffProfileView staff={STAFF} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
    expect(screen.getByText('grace.hopper@hasc.house.gov')).toBeInTheDocument();
    // Enriched fields render: issue area, functional role, and office phone.
    expect(screen.getByText('Armed forces and national security')).toBeInTheDocument();
    expect(screen.getByText('Legislative Director')).toBeInTheDocument();
    expect(screen.getByText(/202-225-3261/)).toBeInTheDocument();
    // "Mike Rogers" now appears as the member association AND as the issue/role
    // owner links — every one points at the canonical member profile route.
    const memberLinks = screen.getAllByRole('link', { name: 'Mike Rogers' });
    expect(memberLinks.length).toBeGreaterThan(0);
    for (const link of memberLinks) {
      expect(link).toHaveAttribute('href', '/directory/members/member-500');
    }
    // committee association links to the committee dictionary route
    const committeeLink = screen.getByRole('link', { name: 'committee-100' });
    expect(committeeLink).toHaveAttribute('href', '/directory/committees/committee-100');
    // no photo/social from the entitlement -> honest "Not provided by source"
    expect(screen.getAllByText(/Not provided by source/).length).toBeGreaterThan(0);
  });
});
