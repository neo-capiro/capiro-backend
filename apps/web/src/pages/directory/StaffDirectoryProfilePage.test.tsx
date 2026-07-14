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
  bioDetails: { dob: null, partyName: null, occupation: 'Counsel' },
  photoUrl: null,
  photoSource: null,
  emails: [{ type: 'Email', value: 'grace.hopper@hasc.house.gov', updatedAt: null }],
  socialContacts: [],
  positions: [
    { officeId: 100, officeName: 'House Armed Services Committee', memberId: null, title: 'Staff Director', positionType: 'ch', isCurrent: true, startDate: null, endDate: null, updatedAt: null },
  ],
  memberAssociations: [{ id: 'member-500', memberId: 500, fullName: 'Mike Rogers' }],
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
    // member association links to the canonical member profile route
    const memberLink = screen.getByRole('link', { name: 'Mike Rogers' });
    expect(memberLink).toHaveAttribute('href', '/directory/members/member-500');
    // committee association links to the committee dictionary route
    const committeeLink = screen.getByRole('link', { name: 'committee-100' });
    expect(committeeLink).toHaveAttribute('href', '/directory/committees/committee-100');
    // no photo/social from the entitlement -> honest "Not provided by source"
    expect(screen.getAllByText(/Not provided by source/).length).toBeGreaterThan(0);
  });
});
