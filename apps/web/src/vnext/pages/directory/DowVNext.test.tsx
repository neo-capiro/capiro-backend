import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AcquisitionPersonnelListItem } from '../../../pages/program-element/types.js';

const get = vi.fn();
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({ get }) }));

const { DowVNext } = await import('./DowVNext.js');

function person(overrides: Partial<AcquisitionPersonnelListItem> = {}): AcquisitionPersonnelListItem {
  return {
    id: 'ap-1',
    fullName: 'Ada Lovelace',
    service: 'ARMY',
    organization: 'PEO C3T',
    title: 'Program Executive Officer',
    role: 'PEO',
    pePrimary: '0605053A',
    peSecondary: [],
    emailDomain: 'army.mil',
    publicProfileUrl: 'https://example.mil/ada',
    headshotUrl: null,
    confidence: 0.97,
    status: 'active',
    firstSeenAt: '2026-01-04T00:00:00Z',
    lastSeenAt: '2026-08-01T00:00:00Z',
    sourceCount: 3,
    ...overrides,
  };
}

function listResponse(data: AcquisitionPersonnelListItem[], total = data.length) {
  return { data: { data, total, page: 1, limit: 12 } };
}

function renderAt(path = '/directory/department-of-war') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/directory/department-of-war" element={<DowVNext />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Department of War vNext', () => {
  beforeEach(() => {
    get.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  test('renders rows with PE-first sort requested and PE code displayed', async () => {
    get.mockImplementation((url: string) => {
      if (url === '/api/acquisition-personnel') return Promise.resolve(listResponse([person()]));
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    renderAt();
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeTruthy());
    // PE-first sort is a server request, not a client re-sort.
    const call = get.mock.calls.find(([url]) => url === '/api/acquisition-personnel');
    expect(call?.[1]?.params?.sort).toBe('pe_first');
    expect(screen.getAllByText(/PE 0605053A/).length).toBeGreaterThan(0);
  });

  test('never fabricates a PE code for an unaligned record', async () => {
    get.mockImplementation((url: string) => {
      if (url === '/api/acquisition-personnel')
        return Promise.resolve(
          listResponse([person({ id: 'ap-2', pePrimary: null, peSecondary: [], organization: 'PEO C3T' })]),
        );
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    renderAt();
    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeTruthy());
    // No PE code anywhere; the org-level alignment string is shown instead.
    expect(screen.queryByText(/PE 0605053A/)).toBeNull();
    expect(screen.getAllByText(/Program-office alignment/).length).toBeGreaterThan(0);
  });

  test('shows an error state with retry when the source fails', async () => {
    get.mockRejectedValue(new Error('boom'));
    renderAt();
    await waitFor(
      () => expect(screen.getByText(/Acquisition personnel could not be loaded/)).toBeTruthy(),
      { timeout: 8000 },
    );
  });

  test('empty source is distinct from a filtered-empty result', async () => {
    get.mockImplementation((url: string) => {
      if (url === '/api/acquisition-personnel') return Promise.resolve(listResponse([], 0));
      return Promise.reject(new Error(`unexpected ${url}`));
    });
    renderAt();
    await waitFor(() => expect(screen.getByText('No records in this source')).toBeTruthy());
  });
});
