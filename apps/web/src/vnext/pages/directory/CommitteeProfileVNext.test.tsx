import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  CommitteeContactsResponse,
  DirectoryCommitteeMembership,
} from '../../../pages/directory/directory-api.js';

/**
 * Parity suite for the vNext committee dictionary page: mirrors the canonical
 * `CommitteeContactList.test.tsx` (roster links + empty state) and locks the
 * page-level contract of `CommitteeDirectoryPage` — the personType/current/q
 * filters live in the URL (shareable) and are forwarded to the same
 * `getCommitteeContacts` call.
 */

vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({}) }));

const getCommitteeContactsMock = vi.fn();
vi.mock('../../../pages/directory/directory-api.js', async () => {
  const real = await vi.importActual<typeof import('../../../pages/directory/directory-api.js')>(
    '../../../pages/directory/directory-api.js',
  );
  return {
    ...real,
    getCommitteeContacts: (...args: unknown[]) => getCommitteeContactsMock(...args),
  };
});

const { CommitteeProfileVNext, CommitteeContactListVNext } = await import('./CommitteeProfileVNext.js');

function membership(over: { id: string; type: 'member' | 'staff'; name: string; position?: string }): DirectoryCommitteeMembership {
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
  };
}

const RESPONSE: CommitteeContactsResponse = {
  committee: {
    id: 'committee-100',
    officeId: 100,
    name: 'House Armed Services Committee',
    chamber: 'House',
    kind: 'committee',
    committeeCode: 'HSAS',
    parentOfficeId: null,
    staffCount: 60,
    phone: '202-225-4151',
    officeLocation: '2216 Rayburn HOB',
    parentCommittee: null,
    subcommittees: [{ id: 'committee-101', officeId: 101, name: 'Subcommittee on Seapower', kind: 'subcommittee' }],
    contacts: [],
    memberCount: 57,
    currentStaffCount: 58,
  },
  contacts: [
    membership({ id: 'member-500', type: 'member', name: 'Mike Rogers', position: 'Chair' }),
    membership({ id: 'staff-800', type: 'staff', name: 'Grace Hopper', position: 'Staff Director' }),
  ],
  total: 2,
  page: 1,
  pageSize: 500,
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{`${location.pathname}${location.search}`}</div>;
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/directory/committees/committee-100']}>
        <CommitteeProfileVNext committeeId="committee-100" />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('CommitteeContactListVNext', () => {
  test('links each member and staff row to its canonical profile route', () => {
    render(
      <MemoryRouter>
        <CommitteeContactListVNext
          contacts={[
            membership({ id: 'member-500', type: 'member', name: 'Mike Rogers', position: 'Chair' }),
            membership({ id: 'staff-800', type: 'staff', name: 'Grace Hopper', position: 'Staff Director' }),
          ]}
        />
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
        <CommitteeContactListVNext contacts={[]} />
      </MemoryRouter>,
    );
    expect(screen.getByText('No matching contacts')).toBeInTheDocument();
  });
});

describe('CommitteeProfileVNext', () => {
  beforeEach(() => {
    getCommitteeContactsMock.mockReset();
    getCommitteeContactsMock.mockResolvedValue(RESPONSE);
  });

  test('renders committee header, subcommittee link, and roster from the contacts endpoint', async () => {
    renderPage();
    expect(
      await screen.findByRole('heading', { name: 'House Armed Services Committee' }),
    ).toBeInTheDocument();
    // Default (unfiltered) call: no personType/current/q, pageSize 500.
    expect(getCommitteeContactsMock).toHaveBeenCalledWith(expect.anything(), 'committee-100', {
      personType: undefined,
      current: undefined,
      q: undefined,
      pageSize: 500,
    });
    expect(screen.getByText('57 members · 58 current staff')).toBeInTheDocument();
    expect(screen.getByText('2216 Rayburn HOB · Phone: 202-225-4151')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Subcommittee on Seapower' })).toHaveAttribute(
      'href',
      '/directory/committees/committee-101',
    );
    expect(screen.getByRole('link', { name: 'Mike Rogers' })).toHaveAttribute(
      'href',
      '/directory/members/member-500',
    );
  });

  test('personType filter persists in the URL and refetches with the same param canonical sent', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'House Armed Services Committee' });

    fireEvent.click(screen.getByRole('button', { name: 'Members' }));
    await waitFor(() => {
      expect(screen.getByTestId('location-probe').textContent).toContain('personType=member');
    });
    await waitFor(() => {
      expect(getCommitteeContactsMock).toHaveBeenCalledWith(expect.anything(), 'committee-100', {
        personType: 'member',
        current: undefined,
        q: undefined,
        pageSize: 500,
      });
    });
  });

  test('search commits on Enter into the shareable q param', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'House Armed Services Committee' });

    const input = screen.getByLabelText('Filter by name or role');
    fireEvent.change(input, { target: { value: 'Rogers' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByTestId('location-probe').textContent).toContain('q=Rogers');
    });
    await waitFor(() => {
      expect(getCommitteeContactsMock).toHaveBeenCalledWith(expect.anything(), 'committee-100', {
        personType: undefined,
        current: undefined,
        q: 'Rogers',
        pageSize: 500,
      });
    });
  });

  test('shows the canonical error copy when the committee cannot be loaded', async () => {
    getCommitteeContactsMock.mockRejectedValue(new Error('404'));
    renderPage();
    // The page keeps canonical's retry: 1, so the failure only settles after
    // one retry cycle — give the wait room for that.
    expect(await screen.findByText('Committee unavailable', undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(
      screen.getByText('This committee could not be found in the current directory snapshot.'),
    ).toBeInTheDocument();
  });
});
