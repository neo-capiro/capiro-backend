import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AddRelationshipModal } from './AddRelationshipModal.js';

/**
 * The vNext government-target picker that replaced a dead "Add relationship"
 * button (it navigated to `?tab=targets`, which routes back to the view already
 * on screen).
 *
 * What matters here is that all THREE directories a `ClientTarget` can come from
 * are searched and normalized to one row shape, that one directory failing never
 * blanks the others, and that adding hits the real targets endpoint.
 */

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock, post: postMock }),
}));

const CONGRESS_ROW = {
  id: 'C000123',
  fullName: 'Sen. John Cornyn',
  party: 'R',
  state: 'TX',
  district: null,
  chamber: 'Senate',
  committees: ['Judiciary'],
};

const STAFF_ROW = {
  personType: 'staff',
  id: 'staff-4412',
  sourceId: 4412,
  fullName: 'Dana Whitfield',
  // Committee staff surface through this same directory — their committee role
  // is the useful "where", which is what normalizeStaff maps into `committee`.
  title: 'Staff Director, House Armed Services Committee',
  photoUrl: null,
  photoSource: null,
  party: null,
  state: 'VA',
  district: null,
  isCurrent: true,
};

const STATE_ROW = {
  id: 'ocd-person/abc',
  name: 'Rep. Alicia Boren',
  party: 'Democratic',
  state: 'CA',
  district: '12',
  chamber: 'lower',
};

function renderPicker() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AddRelationshipModal open clientId="client-1" onClose={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Type into the search box and let the 250ms debounce settle. */
async function search(term: string) {
  fireEvent.change(screen.getByLabelText(/^Search the directory/), { target: { value: term } });
  await waitFor(() => expect(getMock).toHaveBeenCalled(), { timeout: 2000 });
}

function mockDirectories(
  overrides: { congress?: unknown; staff?: unknown; state?: unknown } = {},
) {
  getMock.mockImplementation((url: string) => {
    if (url === '/api/directory/contacts') {
      return overrides.congress instanceof Error
        ? Promise.reject(overrides.congress)
        : Promise.resolve({ data: overrides.congress ?? { contacts: [CONGRESS_ROW] } });
    }
    if (url === '/api/directory/people') {
      return overrides.staff instanceof Error
        ? Promise.reject(overrides.staff)
        : Promise.resolve({ data: overrides.staff ?? { people: [STAFF_ROW] } });
    }
    if (url === '/api/explorer/state-legislators') {
      return overrides.state instanceof Error
        ? Promise.reject(overrides.state)
        : Promise.resolve({ data: overrides.state ?? { rows: [STATE_ROW], total: 1 } });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
});

describe('AddRelationshipModal', () => {
  it('does not search until something is typed', () => {
    mockDirectories();
    renderPicker();

    expect(screen.getByText('Type a name to search the directory.')).toBeInTheDocument();
    expect(getMock).not.toHaveBeenCalled();
  });

  it('searches members, staff, and state legislators together', async () => {
    mockDirectories();
    renderPicker();
    await search('whit');

    // All three directories are represented in one normalized list.
    expect(await screen.findByText('Sen. John Cornyn')).toBeInTheDocument();
    expect(await screen.findByText('Dana Whitfield')).toBeInTheDocument();
    expect(await screen.findByText('Rep. Alicia Boren')).toBeInTheDocument();

    const urls = getMock.mock.calls.map((call) => call[0]);
    expect(urls).toContain('/api/directory/contacts');
    expect(urls).toContain('/api/directory/people');
    expect(urls).toContain('/api/explorer/state-legislators');
  });

  it('labels each result with the directory it came from', async () => {
    mockDirectories();
    renderPicker();
    await search('whit');

    const staffRow = (await screen.findByText('Dana Whitfield')).closest('li')!;
    // The people search returns personal-office AND committee staff under one
    // `staff` directory with no distinguishing field — the honest badge is the
    // general "Congressional staff", not a "Committee Staff" that mislabels
    // every personal-office result.
    expect(staffRow).toHaveTextContent('Congressional staff');
    expect(staffRow).not.toHaveTextContent('Committee Staff');
    // A committee staffer's committee role travels through as their "where".
    expect(staffRow).toHaveTextContent('House Armed Services Committee');

    const memberRow = screen.getByText('Sen. John Cornyn').closest('li')!;
    expect(memberRow).toHaveTextContent('Member');
    expect(memberRow).toHaveTextContent('Senate');
  });

  it('scopes the staff filter with the honest Congressional staff label', async () => {
    mockDirectories();
    renderPicker();
    await search('whit');
    await screen.findByText('Dana Whitfield');

    // The scope chip is the same honest label, and it still narrows to staff.
    fireEvent.click(screen.getByRole('button', { name: 'Congressional staff' }));
    await waitFor(() => expect(screen.queryByText('Sen. John Cornyn')).not.toBeInTheDocument());
    expect(screen.getByText('Dana Whitfield')).toBeInTheDocument();
  });

  it('narrows to one directory when a scope is picked', async () => {
    mockDirectories();
    renderPicker();
    await search('whit');
    await screen.findByText('Dana Whitfield');

    fireEvent.click(screen.getByRole('button', { name: 'Members' }));

    await waitFor(() => expect(screen.queryByText('Dana Whitfield')).not.toBeInTheDocument());
    expect(screen.getByText('Sen. John Cornyn')).toBeInTheDocument();
  });

  it('still shows the other directories when one fails, and says results are incomplete', async () => {
    mockDirectories({ state: new Error('OpenStates down') });
    renderPicker();
    await search('whit');

    expect(await screen.findByText('Sen. John Cornyn')).toBeInTheDocument();
    expect(screen.getByText('Dana Whitfield')).toBeInTheDocument();
    // `retry: 1` means the failing directory needs a second attempt before the
    // query reports isError, so give the warning a longer window than default.
    await waitFor(
      () => expect(screen.getByRole('dialog')).toHaveTextContent(/state legislators directory could not be reached/),
      { timeout: 4000 },
    );
  });

  it('adds a target through the real endpoint with the right source directory', async () => {
    mockDirectories();
    postMock.mockResolvedValue({
      data: { id: 'ct-1', clientId: 'client-1', memberId: 'staff-4412', sourceDirectory: 'staff' },
    });
    renderPicker();
    await search('whit');

    const staffRow = (await screen.findByText('Dana Whitfield')).closest('li')!;
    fireEvent.click(within(staffRow).getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock).toHaveBeenCalledWith('/api/clients/client-1/targets', {
      memberId: 'staff-4412',
      source: 'manual',
      // Not defaulted to 'congress' — the row's own directory drives the write,
      // which is what makes profile click-through resolve later.
      sourceDirectory: 'staff',
    });
  });

  it('marks an added person as added instead of offering Add twice', async () => {
    mockDirectories();
    postMock.mockResolvedValue({
      data: { id: 'ct-1', clientId: 'client-1', memberId: 'staff-4412', sourceDirectory: 'staff' },
    });
    renderPicker();
    await search('whit');

    const staffRow = (await screen.findByText('Dana Whitfield')).closest('li')!;
    fireEvent.click(within(staffRow).getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(within((screen.getByText('Dana Whitfield').closest('li'))!).getByText('Added')).toBeInTheDocument(),
    );
  });
});
