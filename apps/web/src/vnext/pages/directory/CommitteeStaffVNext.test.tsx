import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type {
  DirectoryCommittee,
  DirectoryCommitteeStaffer,
} from '../../../pages/directory/directoryData.js';

const get = vi.fn();
const navigate = vi.fn();
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({ get }) }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});

const { CommitteeStaffVNext } = await import('./CommitteeStaffVNext.js');

const COMMITTEE: DirectoryCommittee = {
  id: 'committee-1',
  officeId: 1,
  name: 'House Armed Services',
  chamber: 'House',
  kind: 'committee',
  committeeCode: 'HASC',
  parentOfficeId: null,
  staffCount: 2,
  chair: { id: 'm-1', name: 'Chair Person' },
  rankingMember: { id: 'm-2', name: 'Ranking Member' },
  viceChairs: [],
  phone: '',
  officeLocation: '',
};

function staffer(overrides: Partial<DirectoryCommitteeStaffer> = {}): DirectoryCommitteeStaffer {
  return {
    id: 'staff-1',
    fullName: 'Sam Diaz',
    title: 'Professional Staff',
    email: 'sam@house.gov',
    phone: '',
    officeLocation: '',
    isCurrent: true,
    committee: { id: 'committee-1', name: 'House Armed Services', chamber: 'House', kind: 'committee' },
    ...overrides,
  };
}

function renderAt(path = '/directory/committee-staff?view=roster') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/directory/committee-staff" element={<CommitteeStaffVNext />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const STAFF_DETAIL = {
  kind: 'staff' as const,
  id: 'staff-1',
  source: { snapshotId: 'snap-1', staffId: 1, lastUpdatedAt: null },
  identity: {
    staffId: 1,
    firstName: 'Sam',
    lastName: 'Diaz',
    preferredFirstName: null,
    preferredLastName: null,
    suffix: null,
    gender: null,
  },
  bioDetails: {
    dob: null,
    dateOfDeath: null,
    hometown: null,
    placeOfBirth: null,
    nativeOf: null,
    majMin: null,
    partyName: null,
    occupation: null,
    pronunciation: null,
    raceName: null,
    religionName: null,
  },
  photoUrl: null,
  photoSource: null,
  emails: [],
  socialContacts: [],
  officeAddresses: [],
  positions: [],
  memberAssociations: [],
  committeeAssociations: [],
  issues: [],
  roles: [],
  availability: { photo: 'not_provided' as const, socialContacts: 'not_provided' as const },
};

function mockHappy(staff: DirectoryCommitteeStaffer[], subcommittees: { id: string; officeId: number; name: string; kind: string }[] = []) {
  get.mockImplementation((...args: unknown[]) => {
    const url = args[0] as string;
    if (url === '/api/directory/committees')
      return Promise.resolve({ data: { committees: [COMMITTEE], total: 1, page: 1, pageSize: 200 } });
    if (typeof url === 'string' && url.includes('/staffers/'))
      return Promise.resolve({ data: STAFF_DETAIL });
    if (typeof url === 'string' && url.includes('/staff'))
      return Promise.resolve({ data: { committee: COMMITTEE, staff, total: staff.length, page: 1, pageSize: 500 } });
    if (typeof url === 'string' && /\/api\/directory\/committees\/[^/]+$/.test(url))
      return Promise.resolve({
        data: {
          ...COMMITTEE,
          parentCommittee: null,
          subcommittees,
          contacts: [],
          memberCount: 0,
          currentStaffCount: staff.length,
        },
      });
    if (url === undefined) return Promise.resolve({ data: {} });
    return Promise.reject(new Error(`unexpected ${url}`));
  });
}

describe('Committee Staff vNext', () => {
  beforeEach(() => {
    get.mockReset();
    navigate.mockReset();
  });

  test('roster renders rows over the canonical committee-staff dataset', async () => {
    mockHappy([staffer()]);
    renderAt();
    await waitFor(() => expect(screen.getByText('Sam Diaz')).toBeTruthy());
    expect(screen.getAllByText(/House Armed Services/).length).toBeGreaterThan(0);
  });

  test('clicking a staffer opens their profile in a modal, without navigating away', async () => {
    mockHappy([staffer()]);
    renderAt();
    await waitFor(() => expect(screen.getByText('Sam Diaz')).toBeTruthy());
    fireEvent.click(screen.getByText('Sam Diaz'));
    // The modal fetches by the same canonical staff id and shows the real
    // detail payload (Staff ID from STAFF_DETAIL.identity.staffId = 1) —
    // never a route change, so the diagram/roster stays mounted underneath.
    await waitFor(() => expect(screen.getByText('Staff ID')).toBeTruthy());
    expect(navigate).not.toHaveBeenCalled();
  });

  test('"Open full profile" from the rail opens the same modal as clicking the row', async () => {
    mockHappy([staffer()]);
    renderAt();
    await waitFor(() => expect(screen.getByText('Sam Diaz')).toBeTruthy());
    fireEvent.click(screen.getByText('Sam Diaz'));
    await waitFor(() => expect(screen.getByText('Open full profile')).toBeTruthy());
    fireEvent.click(screen.getByText('Open full profile'));
    await waitFor(() => expect(screen.getByText('Staff ID')).toBeTruthy());
    expect(navigate).not.toHaveBeenCalled();
  });

  test('roster badges a former committee staffer distinctly from a current one', async () => {
    mockHappy([
      staffer(),
      staffer({ id: 'staff-2', fullName: 'Jamie Lang', email: 'jamie.lang@house.gov', isCurrent: false }),
    ]);
    renderAt();
    const currentRow = (await screen.findByText('sam@house.gov')).closest('button')!;
    expect(within(currentRow).queryByText('Former')).toBeNull();
    const formerRow = screen.getByText('jamie.lang@house.gov').closest('button')!;
    expect(within(formerRow).getByText('Former')).toBeTruthy();
  });

  test('the rail flags a former committee staffer, scoped to this committee', async () => {
    mockHappy([
      staffer({ id: 'staff-2', fullName: 'Jamie Lang', email: 'jamie.lang@house.gov', isCurrent: false }),
    ]);
    renderAt();
    const row = (await screen.findByText('jamie.lang@house.gov')).closest('button')!;
    fireEvent.click(row);
    const rail = screen.getByRole('complementary', { name: 'Selected staff profile' });
    expect(within(rail).getByText('Former on this committee')).toBeTruthy();
  });

  test('the hierarchy canvas dims and badges a former team member — no distinction existed before', async () => {
    mockHappy([staffer({ id: 'staff-2', fullName: 'Jamie Lang', isCurrent: false })]);
    renderAt('/directory/committee-staff');
    const node = await screen.findByTestId('rf__node-staff-staff-2');
    expect(within(node).getByText('Jamie Lang')).toBeTruthy();
    expect(within(node).getByText('Former')).toBeTruthy();
    expect(node.className).toContain('capiro-directory-node--former');
  });

  test('clicking committee leadership navigates to the member profile (no staffer-depth modal for members yet)', async () => {
    mockHappy([staffer()]);
    renderAt('/directory/committee-staff');
    await waitFor(() => expect(screen.getByText('Chair Person')).toBeTruthy());
    fireEvent.click(screen.getByText('Chair Person'));
    expect(navigate).toHaveBeenCalledWith('/directory/members/m-1');
  });

  test('hierarchy view annotates non-source-backed affordances instead of faking them', async () => {
    mockHappy([staffer()]);
    renderAt('/directory/committee-staff');
    // Dashed working-relationship and muted vacancy legend entries are disabled.
    await waitFor(() => expect(screen.getAllByText(/not source-backed/i).length).toBe(2));
    // Leadership is source-backed and renders.
    await waitFor(() => expect(screen.getByText('Chair Person')).toBeTruthy());
  });

  test('hierarchy view renders a pannable XYFlow organization chart with source-backed nodes', async () => {
    mockHappy([staffer()]);
    renderAt('/directory/committee-staff');
    const chart = await screen.findByTestId('committee-org-chart');
    expect(chart).toHaveAttribute('aria-label', 'Committee organization chart');
    expect(within(chart).getByText('House Armed Services')).toBeTruthy();
    expect(within(chart).getByText('Chair Person')).toBeTruthy();
    expect(within(chart).getByText('Committee staff pool')).toBeTruthy();
    expect(within(chart).getByRole('button', { name: 'Zoom In' })).toBeTruthy();
  });

  test('hierarchy view renders a real subcommittee-unit tier from getCommitteeDetail', async () => {
    mockHappy([staffer()], [
      { id: 'committee-101', officeId: 101, name: 'Subcommittee on Seapower', kind: 'subcommittee' },
      { id: 'committee-102', officeId: 102, name: 'Subcommittee on Readiness', kind: 'subcommittee' },
    ]);
    renderAt('/directory/committee-staff');
    await waitFor(() => expect(screen.getByText('Subcommittee on Seapower')).toBeTruthy());
    expect(screen.getByText('Subcommittee on Readiness')).toBeTruthy();
    expect(screen.getAllByText('Subcommittee').length).toBe(2);
    // Real structure only — no fabricated per-unit roster; committee-level
    // staff still renders as one flat, unattributed group underneath.
    expect(screen.getByText('Sam Diaz')).toBeTruthy();
  });

  test('hierarchy view renders no unit tier when the committee has no subcommittees', async () => {
    mockHappy([staffer()], []);
    renderAt('/directory/committee-staff');
    await waitFor(() => expect(screen.getByText('Chair Person')).toBeTruthy());
    expect(screen.queryByText('Subcommittee')).toBeNull();
  });

  test('hierarchy view has no persistent selection rail — the canvas uses the full width', async () => {
    mockHappy([staffer()]);
    renderAt('/directory/committee-staff');
    await waitFor(() => expect(screen.getByText('Chair Person')).toBeTruthy());
    expect(screen.queryByText('Selected staff profile')).toBeNull();
    fireEvent.click(screen.getByText('Sam Diaz'));
    await waitFor(() => expect(screen.getByText('Staff ID')).toBeTruthy());
    // Still no rail once someone is selected — only the modal shows the profile.
    expect(screen.queryByText('Selected staff profile')).toBeNull();
  });

  test('subcommittee names drop the redundant parent-committee prefix the source repeats on every unit', async () => {
    mockHappy([staffer()], [
      { id: 'committee-101', officeId: 101, name: 'House Armed Services Subcommittee on Seapower', kind: 'subcommittee' },
    ]);
    renderAt('/directory/committee-staff');
    await waitFor(() => expect(screen.getByText('Subcommittee on Seapower')).toBeTruthy());
    expect(screen.queryByText('House Armed Services Subcommittee on Seapower')).toBeNull();
  });
});
