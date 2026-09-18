import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LegiWatchSearchOverlay } from './LegiWatchSearchOverlay.js';

const mocks = vi.hoisted(() => ({ enabled: true, get: vi.fn(), post: vi.fn() }));
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => mocks }));
vi.mock('../../../../lib/use-api-scope.js', () => ({ useApiScope: () => 'tenant-a:actor-a' }));
vi.mock('../../../../lib/intel-feature-flags.js', () => ({
  useIntelFeatureEnabled: () => mocks.enabled,
}));
vi.mock('../lib/wave1-api.js', () => ({
  useArchiveSearch: () => ({ data: { rows: [] }, isFetching: false, isError: false }),
}));

beforeEach(() => {
  mocks.enabled = true;
  mocks.get.mockReset().mockResolvedValue({ data: { rows: [] } });
  mocks.get.mockImplementation(async (url: string) => url.endsWith('/bills/search') ? { data: { rows: [{ id: 'bill-a', number: 'HB 1207', title: 'Health Care', jurisdiction: 'FL', sessionKey: '2026' }], total: 1, nextCursor: null } } : { data: { rows: [] } });
  mocks.post.mockReset().mockResolvedValue({
    data: {
      items: [
        {
          id: 'text-a',
          billId: 'bill-a',
          billIdentifier: 'HB 1207',
          billTitle: 'Health Care',
          excerpt: { quote: 'patient access' },
        },
      ],
      coverage: { complete: false },
    },
  });
});
afterEach(cleanup);

function mount() {
  const close = vi.fn();
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter
        initialEntries={[
          '/legiwatch?tab=bills&client=client-a&folder=folder-a&jurisdiction=FL&session=2026',
        ]}
      >
        <LegiWatchSearchOverlay onClose={close} onOpenHearing={vi.fn()} onOpenCommittee={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search LegiWatch' }), {
    target: { value: 'patient access' },
  });
  return close;
}

test('searches bill information across the available corpus and opens the exact bill', async () => {
  const close = mount();
  const hit = await screen.findByRole('link', { name: /HB 1207/ });
  expect(mocks.get).toHaveBeenCalledWith(
    '/intel-api/legiwatch/bills/search',
    expect.objectContaining({
      params: expect.objectContaining({ q: 'patient access', limit: 6 }),
    }),
  );
  const route = new URL(hit.getAttribute('href')!, 'https://example.invalid');
  expect(route.pathname).toBe('/bills/bill-a');
  expect(route.search).toBe('');
  expect(screen.getByText('Scope: all available jurisdictions and sessions')).toBeTruthy();
  fireEvent.click(hit);
  expect(close).toHaveBeenCalledOnce();
});

test('disabled document research still permits bill information search', async () => {
  mocks.enabled = false;
  mount();
  expect(await screen.findByRole('link', { name: /HB 1207/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Bill-document text' })).toBeDisabled();
  expect(mocks.get).toHaveBeenCalledWith('/intel-api/legiwatch/bills/search', expect.anything());
  expect(mocks.post).not.toHaveBeenCalled();
  expect(screen.getByRole('link', { name: 'Open all bill information results' })).toBeTruthy();
});

test('a bill search failure reports incomplete results and can be retried', async () => {
  let failed = false;
  mocks.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/bills/search')) {
      if (!failed) {
        failed = true;
        throw new Error('bill corpus temporarily unavailable');
      }
      return { data: { rows: [{ id: 'bill-a', number: 'HB 1207', title: 'Health Care' }], total: 1, nextCursor: null } };
    }
    return { data: { rows: [] } };
  });
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Bill search could not load',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Retry search' }));
  expect(await screen.findByRole('link', { name: /HB 1207/ })).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
});

test('an empty scanned page can continue to later matching bill documents without claiming a complete negative', async () => {
  mocks.post.mockResolvedValueOnce({
    data: { items: [], cursor: 'scan-next', coverage: { complete: true } },
  });
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Bill-document text' }));
  expect(
    await screen.findByText('No matches in the sources and bill documents scanned so far.'),
  ).toBeTruthy();
  expect(screen.queryByText(/No retained matches/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Search more bill documents' }));
  expect(await screen.findByRole('link', { name: /HB 1207/ })).toBeTruthy();
  expect(mocks.post).toHaveBeenLastCalledWith(
    '/intel-api/legiwatch/research/search',
    expect.objectContaining({
      query: 'patient access',
      cursor: 'scan-next',
      clientId: 'client-a',
      folderId: 'folder-a',
      versionPolicy: 'current_extractions',
    }),
  );
  expect(screen.queryByRole('button', { name: 'Search more bill documents' })).toBeNull();
  expect(screen.queryByText(/No matches in the sources/)).toBeNull();
  const allResults = new URL(
    screen.getByRole('link', { name: 'Open all bill-document results' }).getAttribute('href')!,
    'https://example.invalid',
  );
  expect(allResults.searchParams.get('versionPolicy')).toBe('current_extractions');
});

test('does not default an unspecified bill scope to Florida', async () => {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/legiwatch?tab=bills']}>
        <LegiWatchSearchOverlay onClose={vi.fn()} onOpenHearing={vi.fn()} onOpenCommittee={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search LegiWatch' }), {
    target: { value: 'federal bill' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Bill-document text' }));
  expect(await screen.findByRole('status')).toHaveTextContent(
    'Effective scope: no jurisdiction · no session',
  );
  expect(await screen.findByText('Choose a jurisdiction and session for bill-document text search.')).toBeTruthy();
  await waitFor(() => expect(mocks.post).not.toHaveBeenCalled());
});


test('empty document scope controls are reachable before any results exist', async () => {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/legiwatch?tab=bills']}>
        <LegiWatchSearchOverlay onClose={vi.fn()} onOpenHearing={vi.fn()} onOpenCommittee={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Bill-document text' }));
  expect(screen.getByRole('textbox', { name: 'Bill text jurisdiction' })).toBeTruthy();
  expect(screen.getByRole('textbox', { name: 'Bill text session' })).toBeTruthy();
  expect(screen.getByText('Effective scope: no jurisdiction · no session')).toBeTruthy();
});

test('information corpus hit links to the exact bill route', async () => {
  mount();
  const hit = await screen.findByRole('link', { name: /HB 1207/ });
  expect(hit).toHaveAttribute('href', '/bills/bill-a');
});

test('searches all retained bill document kinds when selected', async () => {
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Bill-document text' }));
  expect(await screen.findByRole('link', { name: /HB 1207/ })).toBeTruthy();
  expect(mocks.post).toHaveBeenCalledWith(
    '/intel-api/legiwatch/research/search',
    expect.objectContaining({ kind: 'all', jurisdiction: 'FL', sessionKey: '2026' }),
  );
});

test('all bill information results keep the query in the folder tracker corpus view', async () => {
  const original = mocks.get.getMockImplementation();
  mocks.get.mockImplementation(async (url: string, config?: unknown) =>
    url.endsWith('/feature-flags')
      ? { data: { legiwatch_folder_tracker_v1: true } }
      : original?.(url, config));
  mount();
  const link = await screen.findByRole('link', { name: 'Open all bill information results' });
  await waitFor(() => {
    const url = new URL(link.getAttribute('href')!, 'https://example.invalid');
    expect(url.searchParams.get('folderSearch')).toBe('1');
    expect(url.searchParams.get('folderQ')).toBe('patient access');
  });
});

test('Escape closes the search overlay and restores focus to its trigger', () => {
  function SearchHarness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" aria-label="Search LegiWatch" onClick={(event) => {
          event.currentTarget.focus();
          setOpen(true);
        }}>
          Search LegiWatch
        </button>
        {open ? (
          <LegiWatchSearchOverlay
            onClose={() => setOpen(false)}
            onOpenHearing={vi.fn()}
            onOpenCommittee={vi.fn()}
          />
        ) : null}
      </>
    );
  }

  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <SearchHarness />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  const trigger = screen.getByRole('button', { name: 'Search LegiWatch' });
  trigger.focus();
  fireEvent.click(trigger);
  expect(screen.getByRole('dialog', { name: 'Search LegiWatch' })).toBeTruthy();

  fireEvent.keyDown(document, { key: 'Escape' });

  expect(screen.queryByRole('dialog', { name: 'Search LegiWatch' })).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
