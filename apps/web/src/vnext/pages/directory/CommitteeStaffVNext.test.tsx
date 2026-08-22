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

type Unit = { id: string; officeId: number; name: string; kind: string };

/**
 * `staffByCommittee` keys a roster to the committee OFFICE it belongs to —
 * mirroring the real endpoint, where a subcommittee is its own committee id
 * with its own roster. Anything not listed answers with an empty roster, the
 * same as a real unit that has nobody on record.
 */
function mockHappy(
  staff: DirectoryCommitteeStaffer[],
  subcommittees: Unit[] = [],
  staffByCommittee: Record<string, DirectoryCommitteeStaffer[]> = {},
) {
  const rosters: Record<string, DirectoryCommitteeStaffer[]> = {
    'committee-1': staff,
    ...staffByCommittee,
  };
  get.mockImplementation((...args: unknown[]) => {
    const url = args[0] as string;
    if (url === '/api/directory/committees')
      return Promise.resolve({ data: { committees: [COMMITTEE], total: 1, page: 1, pageSize: 200 } });
    if (typeof url === 'string' && url.includes('/staffers/'))
      return Promise.resolve({ data: STAFF_DETAIL });
    const staffMatch = typeof url === 'string' ? /\/api\/directory\/committees\/([^/]+)\/staff$/.exec(url) : null;
    if (staffMatch) {
      const id = decodeURIComponent(staffMatch[1] ?? '');
      const roster = rosters[id] ?? [];
      const unit = subcommittees.find((entry) => entry.id === id);
      return Promise.resolve({
        data: {
          committee: unit ? { ...COMMITTEE, ...unit, staffCount: roster.length } : COMMITTEE,
          staff: roster,
          total: roster.length,
          page: 1,
          pageSize: 500,
        },
      });
    }
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

const SEAPOWER: Unit = {
  id: 'committee-101',
  officeId: 101,
  name: 'Subcommittee on Seapower',
  kind: 'subcommittee',
};
const READINESS: Unit = {
  id: 'committee-102',
  officeId: 102,
  name: 'Subcommittee on Readiness',
  kind: 'subcommittee',
};

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
    // Node ids are namespaced by unit: one identity can hold a position on the
    // full committee AND a subcommittee, which is two placements, one person.
    const node = await screen.findByTestId('rf__node-staff-committee-1-staff-2');
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

  test('hierarchy view annotates the one affordance that is still not source-backed', async () => {
    mockHappy([staffer()]);
    renderAt('/directory/committee-staff');
    // Unit placement IS source-backed now (per-office rosters), so the only
    // remaining disclaimer is person-to-person reporting lines.
    await waitFor(() => expect(screen.getAllByText(/not source-backed/i).length).toBe(1));
    expect(screen.getByText(/Person-to-person reporting lines/)).toBeTruthy();
    // Leadership is source-backed and renders.
    expect(screen.getByText('Chair Person')).toBeTruthy();
  });

  test('hierarchy view renders a pannable XYFlow organization chart with source-backed nodes', async () => {
    mockHappy([staffer()]);
    renderAt('/directory/committee-staff');
    const chart = await screen.findByTestId('committee-org-chart');
    expect(chart).toHaveAttribute('aria-label', 'Committee organization chart');
    expect(within(chart).getByText('Chair Person')).toBeTruthy();
    expect(within(chart).getByText('Grouped by committee office')).toBeTruthy();
    expect(within(chart).getByRole('button', { name: 'Zoom In' })).toBeTruthy();
  });

  test('hierarchy view renders a real subcommittee-unit tier from getCommitteeDetail', async () => {
    mockHappy([staffer()], [SEAPOWER, READINESS]);
    renderAt('/directory/committee-staff');
    await waitFor(() => expect(screen.getByText('Subcommittee on Seapower')).toBeTruthy());
    expect(screen.getByText('Subcommittee on Readiness')).toBeTruthy();
    expect(screen.getAllByText('Subcommittee').length).toBe(2);
    expect(screen.getByText('Sam Diaz')).toBeTruthy();
  });

  test('hierarchy view renders no subcommittee tier when the committee has none', async () => {
    mockHappy([staffer()], []);
    renderAt('/directory/committee-staff');
    await waitFor(() => expect(screen.getByText('Chair Person')).toBeTruthy());
    expect(screen.queryByText('Subcommittee')).toBeNull();
    // The parent committee is still its own group column, labelled as such.
    expect(screen.getAllByText('Full committee').length).toBeGreaterThan(0);
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

  // ── Grouping by committee (the point of this change) ───────────────────────

  test('hierarchy places each staffer under the subcommittee office the source records them against', async () => {
    mockHappy([staffer()], [SEAPOWER, READINESS], {
      'committee-101': [
        staffer({
          id: 'staff-10',
          fullName: 'Rae Okafor',
          title: 'Seapower Counsel',
          committee: { id: 'committee-101', name: 'Subcommittee on Seapower', chamber: 'House', kind: 'subcommittee' },
        }),
      ],
      'committee-102': [
        staffer({
          id: 'staff-11',
          fullName: 'Dana Pike',
          title: 'Readiness Analyst',
          committee: { id: 'committee-102', name: 'Subcommittee on Readiness', chamber: 'House', kind: 'subcommittee' },
        }),
      ],
    });
    renderAt('/directory/committee-staff');

    // Each person is a node in their OWN unit's namespace — the flat,
    // unattributed "staff pool" is gone.
    const seapower = await screen.findByTestId('rf__node-staff-committee-101-staff-10');
    expect(within(seapower).getByText('Rae Okafor')).toBeTruthy();
    expect(within(seapower).getByText('Subcommittee on Seapower')).toBeTruthy();

    const readiness = await screen.findByTestId('rf__node-staff-committee-102-staff-11');
    expect(within(readiness).getByText('Dana Pike')).toBeTruthy();

    // And the parent committee keeps its own roster, not everyone else's.
    const parent = await screen.findByTestId('rf__node-staff-committee-1-staff-1');
    expect(within(parent).getByText('Sam Diaz')).toBeTruthy();
  });

  test('a chart card carries the contact info you would otherwise open the profile for', async () => {
    mockHappy([
      staffer({
        title: 'Staff Director',
        email: 'sam.diaz@mail.house.gov',
        phone: '202-225-4151',
        officeLocation: '2216 Rayburn HOB, Washington, DC',
      }),
    ]);
    renderAt('/directory/committee-staff');
    const card = await screen.findByTestId('rf__node-staff-committee-1-staff-1');
    expect(within(card).getByText('Staff Director')).toBeTruthy();
    expect(within(card).getByText('sam.diaz@mail.house.gov')).toBeTruthy();
    expect(within(card).getByText('202-225-4151')).toBeTruthy();
    expect(within(card).getByText('2216 Rayburn HOB, Washington, DC')).toBeTruthy();
  });

  test('a unit card shows its own real headcount, not the parent committee total', async () => {
    mockHappy([staffer(), staffer({ id: 'staff-2', fullName: 'Jamie Lang' })], [SEAPOWER], {
      'committee-101': [
        staffer({ id: 'staff-10', fullName: 'Rae Okafor' }),
        staffer({ id: 'staff-11', fullName: 'Dana Pike', isCurrent: false }),
      ],
    });
    renderAt('/directory/committee-staff');
    const unit = await screen.findByTestId('rf__node-unit-committee-101');
    await waitFor(() => expect(within(unit).getByText('1 current · 1 former')).toBeTruthy());
    const parent = await screen.findByTestId('rf__node-unit-committee-1');
    expect(within(parent).getByText('2 current')).toBeTruthy();
  });

  test('clicking a subcommittee staffer card opens that person’s profile', async () => {
    mockHappy([staffer()], [SEAPOWER], {
      'committee-101': [staffer({ id: 'staff-10', fullName: 'Rae Okafor' })],
    });
    renderAt('/directory/committee-staff');
    const card = await screen.findByTestId('rf__node-staff-committee-101-staff-10');
    fireEvent.click(within(card).getByText('Rae Okafor'));
    await waitFor(() => expect(screen.getByText('Staff ID')).toBeTruthy());
    expect(navigate).not.toHaveBeenCalled();
  });

  test('a long unit roster collapses behind a "show more" card instead of flooding the canvas', async () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      staffer({ id: `staff-${index + 20}`, fullName: `Person ${index + 20}` }),
    );
    mockHappy(many);
    renderAt('/directory/committee-staff');
    await waitFor(() => expect(screen.getByText('Person 20')).toBeTruthy());
    // 6 shown, 3 behind the expander.
    expect(screen.queryByText('Person 28')).toBeNull();
    fireEvent.click(screen.getByText('Show 3 more'));
    await waitFor(() => expect(screen.getByText('Person 28')).toBeTruthy());
    fireEvent.click(screen.getByText('Show fewer'));
    await waitFor(() => expect(screen.queryByText('Person 28')).toBeNull());
  });

  test('roster view sections rows under the same unit headings the chart uses', async () => {
    mockHappy([staffer()], [SEAPOWER], {
      'committee-101': [staffer({ id: 'staff-10', fullName: 'Rae Okafor', email: 'rae@house.gov' })],
    });
    renderAt();
    await waitFor(() => expect(screen.getByText('Rae Okafor')).toBeTruthy());
    const groups = document.querySelectorAll('.capiro-directory-rostergroup');
    expect(groups.length).toBe(2);
    const parentGroup = groups[0] as HTMLElement;
    expect(
      within(parentGroup).getByText('House Armed Services', {
        selector: '.capiro-directory-rostergroup__name',
      }),
    ).toBeTruthy();
    expect(within(parentGroup).getByText('Sam Diaz')).toBeTruthy();
    expect(within(parentGroup).queryByText('Rae Okafor')).toBeNull();
    const unitGroup = groups[1] as HTMLElement;
    expect(
      within(unitGroup).getByText('Subcommittee on Seapower', {
        selector: '.capiro-directory-rostergroup__name',
      }),
    ).toBeTruthy();
    expect(within(unitGroup).getByText('Rae Okafor')).toBeTruthy();
  });

  test('a subcommittee with nobody on record says so instead of vanishing', async () => {
    mockHappy([staffer()], [SEAPOWER], { 'committee-101': [] });
    renderAt();
    // The heading renders from the detail query, which lands BEFORE that unit's
    // own roster query — so the empty message is what must be awaited, not the
    // heading (the group renders a skeleton until its roster settles).
    await waitFor(() => expect(screen.getByText('No staff on record for this unit.')).toBeTruthy());
    expect(screen.getByText('Subcommittee on Seapower')).toBeTruthy();
  });

  test('searching a name narrows the groups to the units that hold that person', async () => {
    mockHappy([staffer()], [SEAPOWER], {
      'committee-101': [staffer({ id: 'staff-10', fullName: 'Rae Okafor', email: 'rae@house.gov' })],
    });
    renderAt('/directory/committee-staff?view=roster&q=Okafor');
    await waitFor(() => expect(screen.getByText('Rae Okafor')).toBeTruthy());
    expect(screen.queryByText('Sam Diaz')).toBeNull();
  });
});
