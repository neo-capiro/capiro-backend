import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { DirectoryEntry, DirectoryStaffMember } from '../../../pages/directory/directoryData.js';

const get = vi.fn();
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({ get }) }));

const { CongressionalStaffVNext } = await import('./CongressionalStaffVNext.js');

function staff(overrides: Partial<DirectoryStaffMember> = {}): DirectoryStaffMember {
  return {
    id: 'staff-800',
    fullName: 'Grace Hopper',
    title: 'Legislative Director',
    // Distinct from `title` on purpose: Coverage renders roles, not the title.
    roles: ['Military Legislative Assistant'],
    issueAreas: ['Defense', 'Appropriations'],
    email: 'grace.hopper@house.gov',
    phone: '202-555-0142',
    officeLocation: 'Personal office',
    ...overrides,
  };
}

function member(overrides: Partial<DirectoryEntry> = {}): DirectoryEntry {
  return {
    id: 'member-1',
    memberId: 1,
    bioguideId: 'M000001',
    fullName: 'Rep. Elaine Morgan',
    memberName: 'Elaine Morgan',
    honorific: 'Rep.',
    photoUrl: 'https://directory.example/photos/morgan.jpg',
    title: 'Member of Congress',
    office: 'Elaine Morgan office (VA-10)',
    chamber: 'House',
    state: 'VA',
    district: '10',
    party: 'D',
    partyName: 'Democrat',
    gender: 'F',
    region: 'South',
    isFreshman: false,
    servingSince: '2015',
    focusAreas: ['Defense'],
    committees: ['House Armed Services'],
    committeeLeadership: [],
    topIssues: [],
    leadershipPositions: [],
    caucuses: [],
    educationInstitutions: [],
    senateClass: null,
    outgoingStatus: null,
    officeLocation: 'Cannon House Office Building',
    phone: '202-225-0110',
    fax: '',
    email: 'elaine.morgan@house.gov',
    contactFormUrl: '',
    officialLinks: [],
    addresses: [],
    staff: [staff()],
    bio: {
      dob: '',
      hometown: '',
      birthplace: '',
      occupation: '',
      race: '',
      religion: '',
      pronunciation: '',
      narrative: '',
      education: '',
      military: '',
      relatives: '',
    },
    lastTouchpoint: '',
    owner: '',
    relationshipTier: 'Watch',
    notes: '',
    recentInteractions: [],
    ...overrides,
  };
}

const FILTERS = {
  chambers: ['House', 'Senate'],
  parties: [],
  genders: [],
  leadership: [],
  committees: ['House Armed Services'],
  issues: ['Defense', 'Health'],
  roles: ['Legislative Director', 'Military Legislative Assistant'],
  caucuses: [],
  states: ['VA', 'WA'],
  districts: [],
  educationInstitutions: [],
};

/** Routes both list and profile so navigation assertions are real. */
function renderScreen(initialUrl = '/directory/congressional-staff') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialUrl]}>
        <div className="capiro-vnext-root">
          <Routes>
            <Route path="/directory/congressional-staff" element={<CongressionalStaffVNext />} />
            <Route path="/directory/staff/:staffId" element={<p>staff profile route</p>} />
            <Route path="/directory/members/:memberId" element={<p>member profile route</p>} />
          </Routes>
        </div>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Minimal staff-detail payload: only the fields the rail actually reads. */
const STAFF_DETAIL = {
  source: { snapshotId: 'legistorm-2026-08', staffId: 800, lastUpdatedAt: null },
  committeeAssociations: [{ committeeId: 'hasc', position: 'House Armed Services' }],
  photoUrl: 'https://directory.example/photos/hopper.jpg',
};

/**
 * The list query and the filter-values query hit the same URL and read
 * different halves of the payload, so one body serves both.
 */
function resolveWith(contacts: DirectoryEntry[], total = contacts.length, staffTotal = 15652) {
  get.mockImplementation((url: string) => {
    if (url === '/api/directory/contacts') {
      return Promise.resolve({
        data: {
          sourceId: 'legistorm-2026-08',
          contacts,
          total,
          page: 1,
          pageSize: 12,
          totals: { all: total, house: total, senate: 0, governors: 0, staff: staffTotal },
          availableStates: FILTERS.states,
          availableFilters: FILTERS,
        },
      });
    }
    return Promise.resolve({ data: STAFF_DETAIL });
  });
}

/** The most recent request the list query made. */
function latestContactsParams(): Record<string, unknown> | undefined {
  const calls = get.mock.calls.filter(
    ([url, config]) => url === '/api/directory/contacts' && config?.params?.sort === 'name-asc',
  );
  return calls[calls.length - 1]?.[1]?.params;
}

async function expandFirstOffice() {
  fireEvent.click(await screen.findByRole('button', { name: /Expand staff for Rep\. Elaine Morgan/ }));
}

beforeEach(() => {
  get.mockReset();
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

afterEach(() => vi.unstubAllGlobals());

describe('Congressional Staff vNext — offices and their rosters', () => {
  test('members are rows in their own right, not just a column on a staffer', async () => {
    resolveWith([member()]);
    renderScreen();

    const row = await screen.findByRole('button', { name: /^Rep\. Elaine Morgan/ });
    expect(within(row).getByText('Member of Congress')).toBeTruthy();
    expect(within(row).getByText('Elaine Morgan office (VA-10)')).toBeTruthy();
    expect(within(row).getByText('House · VA-10 · Democrat')).toBeTruthy();
    expect(within(row).getByText('House Armed Services')).toBeTruthy();
    expect(within(row).getByText('elaine.morgan@house.gov')).toBeTruthy();
  });

  test('the list is read from contacts, which is the only endpoint carrying members', async () => {
    resolveWith([member()]);
    renderScreen();

    await screen.findByRole('button', { name: /^Rep\. Elaine Morgan/ });
    // A–Z is pinned explicitly; the endpoint otherwise defaults to "recent".
    expect(latestContactsParams()?.sort).toBe('name-asc');
    // The staffer index has no member rows in it, so it can no longer be the source.
    expect(get.mock.calls.some(([url]) => url === '/api/directory/staffers')).toBe(false);
  });

  test('a member photo is rendered, and a staffer falls back to initials', async () => {
    resolveWith([member()]);
    const { container } = renderScreen();

    const photo = await waitFor(() => {
      const img = container.querySelector('.capiro-identity-mark__image');
      if (!img) throw new Error('no photo yet');
      return img as HTMLImageElement;
    });
    expect(photo.getAttribute('src')).toBe('https://directory.example/photos/morgan.jpg');

    await expandFirstOffice();
    const stafferRow = await screen.findByRole('button', { name: /Grace Hopper/ });
    // Staff photos are null on the list contract and are never member-substituted.
    expect(stafferRow.querySelector('.capiro-identity-mark__image')).toBeNull();
    expect(within(stafferRow).getByText('GH')).toBeTruthy();
  });

  test('a member with no photo shows initials rather than a broken image', async () => {
    resolveWith([member({ photoUrl: '' })]);
    const { container } = renderScreen();

    await screen.findByRole('button', { name: /^Rep\. Elaine Morgan/ });
    expect(container.querySelector('.capiro-identity-mark__image')).toBeNull();
    expect(screen.getByText('EM')).toBeTruthy();
  });

  test('the roster is collapsed until the caret is used, then reveals the staff', async () => {
    resolveWith([member()]);
    renderScreen();

    const caret = await screen.findByRole('button', { name: /Expand staff for Rep\. Elaine Morgan/ });
    expect(caret.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: /Grace Hopper/ })).toBeNull();

    fireEvent.click(caret);
    expect(caret.getAttribute('aria-expanded')).toBe('true');

    const stafferRow = await screen.findByRole('button', { name: /Grace Hopper/ });
    expect(within(stafferRow).getByText('Legislative Director')).toBeTruthy();
    expect(within(stafferRow).getByText('Staff to Rep. Elaine Morgan · VA-10')).toBeTruthy();
    expect(within(stafferRow).getByText('Defense · Appropriations')).toBeTruthy();
    expect(within(stafferRow).getByText('grace.hopper@house.gov')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Collapse staff for Rep\. Elaine Morgan/ }));
    expect(screen.queryByRole('button', { name: /Grace Hopper/ })).toBeNull();
  });

  test('an office with no synced staff says so instead of rendering an empty block', async () => {
    resolveWith([member({ staff: [] })]);
    renderScreen();

    const row = await screen.findByRole('button', { name: /^Rep\. Elaine Morgan/ });
    expect(within(row).getByText('No staff synced')).toBeTruthy();

    await expandFirstOffice();
    expect(screen.getByText('No staffer contacts synced for this office.')).toBeTruthy();
  });

  test('expand all opens every office on the page and then collapses them', async () => {
    resolveWith([member(), member({ id: 'member-2', fullName: 'Sen. Theodore Vance', staff: [] })]);
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: 'Expand all' }));
    expect(await screen.findByRole('button', { name: /Grace Hopper/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(screen.queryByRole('button', { name: /Grace Hopper/ })).toBeNull();
  });

  test('missing email and phone are stated, never blank', async () => {
    resolveWith([member({ email: '', phone: '' })]);
    renderScreen();

    const row = await screen.findByRole('button', { name: /^Rep\. Elaine Morgan/ });
    expect(within(row).getByText('No email')).toBeTruthy();
    expect(within(row).getByText('No phone')).toBeTruthy();
  });

  test('shows a loading state before data resolves, without inventing rows', async () => {
    get.mockImplementation(() => new Promise(() => {}));
    renderScreen();
    expect(await screen.findByText('Loading…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Rep\. Elaine Morgan/ })).toBeNull();
  });

  test('surfaces an error with a working retry', async () => {
    get.mockRejectedValue(new Error('boom'));
    renderScreen();

    // The list query retries once, so allow for the retry delay.
    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toBeTruthy();
    const before = get.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(before));
  });

  test('empty directory and no-results-after-filtering read differently', async () => {
    resolveWith([]);
    const { unmount } = renderScreen();
    expect(await screen.findByText('No congressional offices available')).toBeTruthy();
    unmount();

    resolveWith([]);
    renderScreen('/directory/congressional-staff?q=nobody');
    expect(await screen.findByText('No offices match these filters')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeTruthy();
  });

  /**
   * `totals.staff` is computed once when the directory is cached, so it does not
   * move when a filter is applied. Printing it beside a filtered office count
   * would claim 15652 staff matched. Offices are the paged unit and get the
   * count; the staff figure is labelled as the directory total.
   */
  test('the office count is filtered while the staff figure is labelled directory-wide', async () => {
    resolveWith([member()], 541, 15652);
    renderScreen();

    expect(await screen.findByText('541 offices')).toBeTruthy();
    expect(screen.getByText('15652 staff in directory')).toBeTruthy();
    // The two must stay separate lines; fused they read as "15652 matched".
    expect(screen.queryByText(/541 offices · 15652 staff/)).toBeNull();
  });

  test('paginates offices only when the total exceeds one page', async () => {
    resolveWith([member()], 30);
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    await waitFor(() => expect(latestContactsParams()?.page).toBe(2));
  });
});

describe('Congressional Staff vNext — search, filters, selection', () => {
  test('search debounces into the URL and can be cleared', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    resolveWith([member()]);
    renderScreen();

    const input = await screen.findByLabelText('Search');
    fireEvent.change(input, { target: { value: 'defense' } });
    await vi.advanceTimersByTimeAsync(400);
    await waitFor(() => expect(latestContactsParams()?.q).toBe('defense'));

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    await vi.advanceTimersByTimeAsync(400);
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(''));
    vi.useRealTimers();
  });

  test('a filter opens, selects, applies to the request, and clears', async () => {
    resolveWith([member()]);
    renderScreen();

    const chamber = await screen.findByRole('button', { name: 'Chamber' });
    expect(chamber.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(chamber);
    expect(chamber.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(screen.getByRole('option', { name: /Senate/ }));
    await waitFor(() => expect(latestContactsParams()?.chamber).toBe('Senate'));

    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull());
  });

  test('Escape closes a filter menu and returns focus to its pill', async () => {
    resolveWith([member()]);
    renderScreen();

    const chamber = await screen.findByRole('button', { name: 'Chamber' });
    fireEvent.click(chamber);
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(chamber);
  });

  /**
   * Role and issue are staffer attributes with no member equivalent, so the
   * contacts endpoint answers them from the office's roster. The screen must
   * send them there rather than quietly dropping the pills when the list became
   * member-first.
   */
  test('Role and Issue Area reach the contacts endpoint as staff-derived filters', async () => {
    resolveWith([member()]);
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: 'Role' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Legislative Director' }));
    await waitFor(() => expect(latestContactsParams()?.role).toEqual(['Legislative Director']));

    fireEvent.click(screen.getByRole('button', { name: 'Issue Area' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Defense' }));
    await waitFor(() => expect(latestContactsParams()?.issue).toEqual(['Defense']));
  });

  test('an applied Committee filter reaches the endpoint and resets paging', async () => {
    resolveWith([member()], 40);
    renderScreen('/directory/congressional-staff?page=3');

    fireEvent.click(await screen.findByRole('button', { name: 'Committee' }));
    fireEvent.click(await screen.findByRole('option', { name: 'House Armed Services' }));

    await waitFor(() => {
      expect(latestContactsParams()?.committee).toEqual(['House Armed Services']);
      // Filtering must return to page 1; page 3 of the old result set is meaningless.
      expect(latestContactsParams()?.page).toBe(1);
    });
  });

  /**
   * The office matched because *one* staffer did. Showing the whole roster under
   * it would contradict the filter that produced the row, so the roster is
   * narrowed by the same predicate and the hidden remainder is stated.
   */
  test('an active Role filter narrows the roster and says how much it hides', async () => {
    resolveWith([
      member({
        staff: [
          staff(),
          staff({ id: 'staff-801', fullName: 'Ada Lovelace', roles: ['Scheduler'], issueAreas: [] }),
        ],
      }),
    ]);
    renderScreen('/directory/congressional-staff?role=Military%20Legislative%20Assistant');

    const row = await screen.findByRole('button', { name: /^Rep\. Elaine Morgan/ });
    expect(within(row).getByText('1 of 2 staff match')).toBeTruthy();

    await expandFirstOffice();
    expect(screen.getByRole('button', { name: /Grace Hopper/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Ada Lovelace/ })).toBeNull();
  });

  test('selecting a member drives the rail from the office row, with no second request', async () => {
    resolveWith([member()]);
    renderScreen();

    const row = await screen.findByRole('button', { name: /^Rep\. Elaine Morgan/ });
    fireEvent.click(row);
    await waitFor(() => expect(row.getAttribute('aria-pressed')).toBe('true'));

    const rail = screen.getByRole('complementary', { name: 'Selected directory profile' });
    expect(within(rail).getByText('Selected member profile')).toBeTruthy();
    expect(within(rail).getByText('elaine.morgan@house.gov')).toBeTruthy();
    // Committees are on the member's own list row, so no staff-detail fetch.
    expect(within(rail).getByText('House Armed Services')).toBeTruthy();
    expect(within(rail).getByText('1 on the roster')).toBeTruthy();
    expect(get.mock.calls.some(([url]) => String(url).startsWith('/api/directory/staffers/'))).toBe(
      false,
    );
  });

  test('selecting a staffer keeps the staff rail, including its detail-only fields', async () => {
    resolveWith([member()]);
    renderScreen();

    await expandFirstOffice();
    fireEvent.click(await screen.findByRole('button', { name: /Grace Hopper/ }));

    const rail = screen.getByRole('complementary', { name: 'Selected directory profile' });
    expect(within(rail).getByText('Selected staff profile')).toBeTruthy();
    expect(within(rail).getByText('grace.hopper@house.gov')).toBeTruthy();
    expect(within(rail).getByText('Office of Rep. Elaine Morgan')).toBeTruthy();
    // Committee comes from the staff detail contract, not the list row.
    await waitFor(() => expect(within(rail).getByText('House Armed Services')).toBeTruthy());
  });

  /**
   * Staff headshots exist, just not on the list contract — they are on the
   * detail payload the rail already fetches. The rail can therefore show one
   * where a row cannot, and it must be the staffer's own, never their member's.
   */
  test('the rail shows the staffer’s own photo from the detail payload', async () => {
    resolveWith([member()]);
    const { container } = renderScreen('/directory/congressional-staff?profile=staff-800');

    const photo = await waitFor(() => {
      const img = container.querySelector('.capiro-directory-rail .capiro-identity-mark__image');
      if (!img) throw new Error('no rail photo yet');
      return img as HTMLImageElement;
    });
    expect(photo.getAttribute('src')).toBe('https://directory.example/photos/hopper.jpg');
    // Not the member's headshot standing in for a missing one.
    expect(photo.getAttribute('src')).not.toBe('https://directory.example/photos/morgan.jpg');
  });

  test('a staffer with no photo on file falls back to initials in the rail', async () => {
    get.mockImplementation((url: string) => {
      if (url === '/api/directory/contacts') {
        return Promise.resolve({
          data: {
            sourceId: 'legistorm-2026-08',
            contacts: [member()],
            total: 1,
            page: 1,
            pageSize: 12,
            totals: { all: 1, house: 1, senate: 0, governors: 0, staff: 1 },
            availableStates: FILTERS.states,
            availableFilters: FILTERS,
          },
        });
      }
      return Promise.resolve({ data: { ...STAFF_DETAIL, photoUrl: null } });
    });
    const { container } = renderScreen('/directory/congressional-staff?profile=staff-800');

    const rail = await screen.findByRole('complementary', { name: 'Selected directory profile' });
    await waitFor(() => expect(within(rail).getByText('grace.hopper@house.gov')).toBeTruthy());
    expect(container.querySelector('.capiro-directory-rail .capiro-identity-mark__image')).toBeNull();
    expect(within(rail).getByText('GH')).toBeTruthy();
  });

  test('the rail says nothing is selected rather than rendering a hollow profile', async () => {
    resolveWith([member()]);
    renderScreen();
    const rail = await screen.findByRole('complementary', { name: 'Selected directory profile' });
    expect(within(rail).getByText('No one selected')).toBeTruthy();
  });

  test('Open full profile resolves to the route for the kind of identity selected', async () => {
    resolveWith([member()]);
    const { unmount } = renderScreen('/directory/congressional-staff?profile=member-1');
    fireEvent.click(await screen.findByRole('button', { name: 'Open full profile' }));
    expect(await screen.findByText('member profile route')).toBeTruthy();
    unmount();

    resolveWith([member()]);
    renderScreen('/directory/congressional-staff?profile=staff-800');
    fireEvent.click(await screen.findByRole('button', { name: 'Open full profile' }));
    expect(await screen.findByText('staff profile route')).toBeTruthy();
  });

  test('a staffer selected from the URL resolves even while their office is collapsed', async () => {
    resolveWith([member()]);
    renderScreen('/directory/congressional-staff?profile=staff-800');

    const rail = await screen.findByRole('complementary', { name: 'Selected directory profile' });
    await waitFor(() => expect(within(rail).getByText('grace.hopper@house.gov')).toBeTruthy());
    // …without the collapsed roster row being exposed to assistive tech.
    expect(screen.queryByRole('button', { name: /Grace Hopper/ })).toBeNull();
  });

  test('clipboard success and failure are both reported', async () => {
    resolveWith([member()]);
    renderScreen('/directory/congressional-staff?profile=member-1');

    fireEvent.click(await screen.findByRole('button', { name: 'Copy email' }));
    expect(await screen.findByRole('button', { name: 'Email copied' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('copied');
  });

  test('a denied clipboard reports failure instead of claiming success', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    resolveWith([member()]);
    renderScreen('/directory/congressional-staff?profile=member-1');

    fireEvent.click(await screen.findByRole('button', { name: 'Copy email' }));
    expect(await screen.findByRole('button', { name: 'Copy failed' })).toBeTruthy();
  });
});

describe('Congressional Staff vNext — shell + identity', () => {
  test('renders the four peer route tabs with the current one marked', async () => {
    resolveWith([member()]);
    renderScreen();

    const tabs = await screen.findByRole('navigation', { name: 'Directory surfaces' });
    for (const label of ['Congressional Staff', 'Committee Staff', 'Department of War', 'State Legislators']) {
      expect(within(tabs).getByRole('link', { name: label })).toBeTruthy();
    }
    expect(within(tabs).getByRole('link', { name: 'Congressional Staff' }).className).toContain(
      'capiro-top-nav-item--current',
    );
  });

  test('column header and rail match the node, not an earlier misreading of it', async () => {
    resolveWith([member()]);
    renderScreen();

    // `937:2745` is named "Column / ROLE & COVERAGE". An earlier handoff recorded
    // this header as blank and shipped "COVERAGE"; the node says otherwise. The
    // column now covers members too, whose committees are the coverage.
    expect(await screen.findByText('Committee & Coverage')).toBeTruthy();
    expect(screen.queryByText('Coverage')).toBeNull();
  });

  test('one row is one identity — a repeated person is not duplicated in the rail', async () => {
    resolveWith([
      member(),
      member({ id: 'member-2', fullName: 'Sen. Theodore Vance', memberName: 'Theodore Vance', staff: [] }),
    ]);
    renderScreen('/directory/congressional-staff?profile=member-1');

    // One canonical record renders exactly one row…
    expect(await screen.findAllByRole('button', { name: /^Rep\. Elaine Morgan/ })).toHaveLength(1);
    // …and the rail shows only the selected identity, never a neighbour's.
    const rail = screen.getByRole('complementary', { name: 'Selected directory profile' });
    expect(within(rail).getByText('Rep. Elaine Morgan')).toBeTruthy();
    expect(within(rail).queryByText('Sen. Theodore Vance')).toBeNull();
  });
});
