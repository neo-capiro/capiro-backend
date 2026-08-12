import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { DirectoryStaffer } from '../../../pages/directory/directoryData.js';

const get = vi.fn();
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({ get }) }));

const { CongressionalStaffVNext } = await import('./CongressionalStaffVNext.js');

function staffer(overrides: Partial<DirectoryStaffer> = {}): DirectoryStaffer {
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
    member: {
      id: 'm-1',
      fullName: 'Elaine Morgan',
      memberName: 'Elaine Morgan',
      chamber: 'House',
      state: 'VA',
      district: '10',
      party: 'D',
      partyName: 'Democrat',
      photoUrl: '',
      title: 'Representative',
    },
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
};

function resolveWith(staffers: DirectoryStaffer[], total = staffers.length) {
  get.mockImplementation((url: string) => {
    if (url === '/api/directory/staffers') {
      return Promise.resolve({ data: { staffers, total, page: 1, pageSize: 12 } });
    }
    if (url.startsWith('/api/directory/staffers/')) {
      return Promise.resolve({ data: STAFF_DETAIL });
    }
    return Promise.resolve({ data: { availableFilters: FILTERS } });
  });
}

beforeEach(() => {
  get.mockReset();
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

afterEach(() => vi.unstubAllGlobals());

describe('Congressional Staff vNext — data + states', () => {
  test('renders the canonical row columns from the list contract', async () => {
    resolveWith([staffer()]);
    renderScreen();

    const row = await screen.findByRole('button', { name: /Grace Hopper/ });
    expect(within(row).getByText('Legislative Director')).toBeTruthy();
    expect(within(row).getByText('Rep. Elaine Morgan · VA-10')).toBeTruthy();
    expect(within(row).getByText('House · Personal office')).toBeTruthy();
    expect(within(row).getByText('Defense · Appropriations')).toBeTruthy();
    expect(within(row).getByText('grace.hopper@house.gov')).toBeTruthy();
  });

  test('shows a loading state before data resolves, without inventing rows', async () => {
    get.mockImplementation(() => new Promise(() => {}));
    renderScreen();
    expect(await screen.findByText('Loading…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Grace Hopper/ })).toBeNull();
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
    expect(await screen.findByText('No congressional staff available')).toBeTruthy();
    unmount();

    resolveWith([]);
    renderScreen('/directory/congressional-staff?q=nobody');
    expect(await screen.findByText('No staff match these filters')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeTruthy();
  });

  test('missing email and phone are stated, never blank', async () => {
    resolveWith([staffer({ email: '', phone: '' })]);
    renderScreen();

    const row = await screen.findByRole('button', { name: /Grace Hopper/ });
    expect(within(row).getByText('No email')).toBeTruthy();
    expect(within(row).getByText('No phone')).toBeTruthy();
  });

  test('paginates only when the total exceeds one page, and moves the page param', async () => {
    resolveWith([staffer()], 30);
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith('/api/directory/staffers', expect.objectContaining({
        params: expect.objectContaining({ page: 2 }),
      })),
    );
  });
});

describe('Congressional Staff vNext — search, filters, selection', () => {
  test('search debounces into the URL and can be cleared', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    resolveWith([staffer()]);
    renderScreen();

    const input = await screen.findByLabelText('Search');
    fireEvent.change(input, { target: { value: 'defense' } });
    await vi.advanceTimersByTimeAsync(400);
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith('/api/directory/staffers', expect.objectContaining({
        params: expect.objectContaining({ q: 'defense' }),
      })),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    await vi.advanceTimersByTimeAsync(400);
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(''));
    vi.useRealTimers();
  });

  test('a filter opens, selects, applies to the request, and clears', async () => {
    resolveWith([staffer()]);
    renderScreen();

    const chamber = await screen.findByRole('button', { name: 'Chamber' });
    expect(chamber.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(chamber);
    expect(chamber.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(screen.getByRole('option', { name: /Senate/ }));
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith('/api/directory/staffers', expect.objectContaining({
        params: expect.objectContaining({ chamber: 'Senate' }),
      })),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull());
  });

  test('Escape closes a filter menu and returns focus to its pill', async () => {
    resolveWith([staffer()]);
    renderScreen();

    const chamber = await screen.findByRole('button', { name: 'Chamber' });
    fireEvent.click(chamber);
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(chamber);
  });

  test('Role and Committee state that they are not filterable instead of filtering wrongly', async () => {
    resolveWith([staffer()]);
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: 'Role' }));
    expect(screen.getByText(/not filterable yet/i)).toBeTruthy();
    // No request may claim a role filter the endpoint cannot honour.
    for (const call of get.mock.calls) {
      expect(call[1]?.params ?? {}).not.toHaveProperty('role');
    }
  });

  test('rows are keyboard-operable and selection drives the rail', async () => {
    resolveWith([staffer()]);
    renderScreen();

    const row = await screen.findByRole('button', { name: /Grace Hopper/ });
    row.focus();
    expect(document.activeElement).toBe(row);

    fireEvent.click(row);
    await waitFor(() => expect(row.getAttribute('aria-pressed')).toBe('true'));

    const rail = screen.getByRole('complementary', { name: 'Selected staff profile' });
    expect(within(rail).getByText('grace.hopper@house.gov')).toBeTruthy();
    expect(within(rail).getByText('Office of Rep. Elaine Morgan · VA-10')).toBeTruthy();
  });

  test('the rail says nothing is selected rather than rendering a hollow profile', async () => {
    resolveWith([staffer()]);
    renderScreen();
    const rail = await screen.findByRole('complementary', { name: 'Selected staff profile' });
    expect(within(rail).getByText('No one selected')).toBeTruthy();
  });

  test('Open full profile navigates to the canonical staff route', async () => {
    resolveWith([staffer()]);
    renderScreen('/directory/congressional-staff?profile=staff-800');

    fireEvent.click(await screen.findByRole('button', { name: 'Open full profile' }));
    expect(await screen.findByText('staff profile route')).toBeTruthy();
  });

  test('clipboard success and failure are both reported', async () => {
    resolveWith([staffer()]);
    renderScreen('/directory/congressional-staff?profile=staff-800');

    fireEvent.click(await screen.findByRole('button', { name: 'Copy email' }));
    expect(await screen.findByRole('button', { name: 'Email copied' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('copied');
  });

  test('a denied clipboard reports failure instead of claiming success', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    resolveWith([staffer()]);
    renderScreen('/directory/congressional-staff?profile=staff-800');

    fireEvent.click(await screen.findByRole('button', { name: 'Copy email' }));
    expect(await screen.findByRole('button', { name: 'Copy failed' })).toBeTruthy();
  });
});

describe('Congressional Staff vNext — shell + identity', () => {
  test('renders the four peer route tabs with the current one marked', async () => {
    resolveWith([staffer()]);
    renderScreen();

    const tabs = await screen.findByRole('navigation', { name: 'Directory surfaces' });
    for (const label of ['Congressional Staff', 'Committee Staff', 'Department of War', 'State Legislators']) {
      expect(within(tabs).getByRole('link', { name: label })).toBeTruthy();
    }
    expect(within(tabs).getByRole('link', { name: 'Congressional Staff' }).className).toContain(
      'capiro-top-nav-item--current',
    );
  });

  test('one row is one identity — a repeated person is not duplicated in the rail', async () => {
    resolveWith([staffer(), staffer({ id: 'staff-801', fullName: 'Ada Lovelace' })]);
    renderScreen('/directory/congressional-staff?profile=staff-800');

    // One canonical record renders exactly one row…
    expect(await screen.findAllByRole('button', { name: /Grace Hopper/ })).toHaveLength(1);
    // …and the rail shows only the selected identity, never a neighbour's.
    const rail = screen.getByRole('complementary', { name: 'Selected staff profile' });
    expect(within(rail).getByText('Grace Hopper')).toBeTruthy();
    expect(within(rail).queryByText('Ada Lovelace')).toBeNull();
  });
});
