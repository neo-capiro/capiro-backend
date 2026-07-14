import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { MemberProfileView } from './MemberProfileView.js';
import type { MemberDetail } from './directory-api.js';

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
    placeOfBirth: null,
    hometown: 'Saks, AL',
    partyName: 'Republican',
    occupation: null,
    pronunciation: null,
    raceName: null,
    religionName: null,
  },
  photos: [{ id: 9, url: 'https://x.invalid/r.jpg', status: 'public', isPrimary: false, isDirectory: true, updatedAt: null }],
  selectedPhotoUrl: 'https://x.invalid/r.jpg',
  photoSource: 'legistorm',
  offices: [{ officeId: 950, name: 'Rep. Rogers Office', officeTypeId: 'HM', state: 'AL', district: '3', party: 'R', status: 'In office', startDate: null, endDate: null, updatedAt: null }],
  committees: [
    {
      committeeId: 'committee-100',
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

describe('MemberProfileView', () => {
  beforeAll(setupAntdBrowserMocks);

  test('renders identity, committee link, leadership, and null-as-Not-provided', () => {
    render(
      <MemoryRouter>
        <MemberProfileView member={MEMBER} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Mike Rogers')).toBeInTheDocument();
    const committeeLink = screen.getByRole('link', { name: 'committee-100' });
    expect(committeeLink).toHaveAttribute('href', '/directory/committees/committee-100');
    expect(screen.getByText('Chairman')).toBeInTheDocument();
    // dob/occupation/etc. are null -> the contract says "Not provided by source".
    expect(screen.getAllByText('Not provided by source').length).toBeGreaterThan(0);
    // social link present
    expect(screen.getByRole('link', { name: 'https://rogers.house.gov' })).toBeInTheDocument();
  });
});
