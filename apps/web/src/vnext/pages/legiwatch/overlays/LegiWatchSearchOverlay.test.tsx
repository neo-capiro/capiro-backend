import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

test('searches retained bill evidence in the selected scope and opens the same Bill 360 context', async () => {
  const close = mount();
  const hit = await screen.findByRole('link', { name: /HB 1207/ });
  expect(mocks.post).toHaveBeenCalledWith(
    '/intel-api/legiwatch/research/search',
    expect.objectContaining({
      query: 'patient access',
      clientId: 'client-a',
      folderId: 'folder-a',
      jurisdiction: 'FL',
      sessionKey: '2026',
    }),
  );
  const route = new URL(hit.getAttribute('href')!, 'https://example.invalid');
  expect(route.searchParams.get('researchBill')).toBe('bill-a');
  expect(route.searchParams.get('client')).toBe('client-a');
  expect(route.searchParams.get('folder')).toBe('folder-a');
  expect(route.searchParams.get('researchQuery')).toBe('patient access');
  expect(route.searchParams.get('versionPolicy')).toBe('current_extractions');
  expect(screen.getByText(/source coverage is incomplete/)).toBeTruthy();
  fireEvent.click(hit);
  expect(close).toHaveBeenCalledOnce();
});

test('disabled research makes no bill query and describes the available search coverage', async () => {
  mocks.enabled = false;
  mount();
  expect(await screen.findByText(/Bill research is not enabled/)).toBeTruthy();
  await screen.findByText(/No retained matches/);
  expect(mocks.post).not.toHaveBeenCalled();
  expect(screen.queryByRole('link', { name: 'Open all bill research results' })).toBeNull();
});

test('a bill search failure reports incomplete results and can be retried', async () => {
  mocks.post.mockRejectedValueOnce(new Error('scope temporarily unavailable'));
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Bill research could not load for the selected scope',
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
    screen.getByRole('link', { name: 'Open all bill research results' }).getAttribute('href')!,
    'https://example.invalid',
  );
  expect(allResults.searchParams.get('versionPolicy')).toBe('current_extractions');
});
