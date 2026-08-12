import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { StateLegislatorRow } from '../../../pages/directory/StateLegislatorDirectory.js';

const get = vi.fn();
vi.mock('../../../lib/use-api.js', () => ({ useApi: () => ({ get }) }));

const { StateLegislatorsVNext } = await import('./StateLegislatorsVNext.js');

function leg(overrides: Partial<StateLegislatorRow> = {}): StateLegislatorRow {
  return {
    id: 'ocd-person/1111',
    name: 'Maria Chen',
    state: 'VA',
    chamber: 'House',
    district: '10',
    party: 'D',
    email: 'maria@house.gov',
    image: null,
    url: null,
    committeeCount: 4,
    billCount: 18,
    enactedCount: 2,
    ...overrides,
  };
}

function listResponse(rows: StateLegislatorRow[], total = rows.length) {
  return { data: { rows, total } };
}

const FACETS = { data: { states: ['VA'], chambers: ['House'], parties: ['D'] } };

function renderAt(path = '/directory/state-legislators') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/directory/state-legislators" element={<StateLegislatorsVNext />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function mockHappy(rows: StateLegislatorRow[]) {
  get.mockImplementation((...args: unknown[]) => {
    const url = args[0] as string;
    if (url === '/api/explorer/state-legislator-facets') return Promise.resolve(FACETS);
    if (url === '/api/explorer/state-legislators') return Promise.resolve(listResponse(rows));
    if (url === undefined) return Promise.resolve({ data: {} });
    return Promise.reject(new Error(`unexpected ${url}`));
  });
}

describe('State Legislators vNext', () => {
  beforeEach(() => get.mockReset());

  test('renders real counts as numbers', async () => {
    mockHappy([leg()]);
    renderAt();
    await waitFor(() => expect(screen.getByText('Maria Chen')).toBeTruthy());
    expect(screen.getByText('18')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
  });

  test('a never-crosswalked count renders "Not available", never 0', async () => {
    mockHappy([leg({ id: 'ocd-person/2222', billCount: null, enactedCount: null })]);
    renderAt();
    await waitFor(() => expect(screen.getByText('Maria Chen')).toBeTruthy());
    // Two unknown cells (bills + enacted), committees still a real number.
    expect(screen.getAllByText('Not available').length).toBe(2);
    // The fabricated zero must NOT appear for those cells.
    expect(screen.queryByText('0')).toBeNull();
  });

  test('a genuine zero renders as a muted 0, distinct from unknown', async () => {
    mockHappy([leg({ id: 'ocd-person/3333', enactedCount: 0 })]);
    renderAt();
    await waitFor(() => expect(screen.getByText('Maria Chen')).toBeTruthy());
    expect(screen.getByText('0')).toBeTruthy();
    // bills (18) and committees (4) are numbers; only enacted is a real zero.
    expect(screen.queryByText('Not available')).toBeNull();
  });

  test('renders "No email" in the warning ramp when the source has no address', async () => {
    mockHappy([leg({ id: 'ocd-person/4444', email: null })]);
    renderAt();
    await waitFor(() => expect(screen.getByText('Maria Chen')).toBeTruthy());
    expect(screen.getByText('No email')).toBeTruthy();
  });

  test('empty source is distinct from a filtered-empty result', async () => {
    mockHappy([]);
    renderAt();
    await waitFor(() => expect(screen.getByText('No records in this source')).toBeTruthy());
  });
});
