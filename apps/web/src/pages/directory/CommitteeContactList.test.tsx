import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, test, vi } from 'vitest';
import { CommitteeContactList } from './CommitteeContactList.js';
import type { DirectoryCommitteeMembership } from './directory-api.js';

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

function membership(over: Partial<DirectoryCommitteeMembership> & { id: string; type: 'member' | 'staff'; name: string }): DirectoryCommitteeMembership {
  return {
    committeeId: 'committee-100',
    person: {
      personType: over.type,
      id: over.id,
      sourceId: 1,
      fullName: over.name,
      title: '',
      photoUrl: null,
      photoSource: null,
      party: over.type === 'member' ? 'R' : null,
      state: over.type === 'member' ? 'AL' : null,
      district: null,
      isCurrent: true,
    },
    membershipType: over.type,
    position: over.position ?? (over.type === 'member' ? 'Member' : 'Staff'),
    party: null,
    rank: null,
    status: null,
    startedAt: null,
    endedAt: null,
    sourceUpdatedAt: null,
  } as DirectoryCommitteeMembership;
}

describe('CommitteeContactList', () => {
  beforeAll(setupAntdBrowserMocks);

  test('links each member and staff row to its canonical profile route', () => {
    const contacts = [
      membership({ id: 'member-500', type: 'member', name: 'Mike Rogers', position: 'Chair' }),
      membership({ id: 'staff-800', type: 'staff', name: 'Grace Hopper', position: 'Staff Director' }),
    ];
    render(
      <MemoryRouter>
        <CommitteeContactList contacts={contacts} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Mike Rogers' })).toHaveAttribute(
      'href',
      '/directory/members/member-500',
    );
    expect(screen.getByRole('link', { name: 'Grace Hopper' })).toHaveAttribute(
      'href',
      '/directory/staff/staff-800',
    );
    expect(screen.getByText('Chair')).toBeInTheDocument();
    expect(screen.getByText('Staff Director')).toBeInTheDocument();
  });

  test('shows an empty state when there are no contacts', () => {
    render(
      <MemoryRouter>
        <CommitteeContactList contacts={[]} />
      </MemoryRouter>,
    );
    expect(screen.getByText('No matching contacts')).toBeInTheDocument();
  });
});
