import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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
    if (typeof url === 'string' && url.startsWith('/api/explorer/state-legislators/')) {
      const row = rows.find((r) => url.endsWith(encodeURIComponent(r.id)));
      return Promise.resolve({
        data: row
          ? { ...row, active: true, legiscanPeopleId: null, syncedAt: '2026-08-10', committees: [], sponsoredBills: null, sponsoredBillsTotal: 0 }
          : {},
      });
    }
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

  test('a never-crosswalked count renders an honest unavailable cell, never 0', async () => {
    mockHappy([leg({ id: 'ocd-person/2222', billCount: null, enactedCount: null })]);
    const { container } = renderAt();
    await waitFor(() => expect(screen.getByText('Maria Chen')).toBeTruthy());
    // Two unknown cells (bills + enacted), committees still a real number.
    // The glyph is a muted "—" (never a fabricated 0); the explanation is a
    // demoted note inside the label, not the words stuffed into the number
    // slot (that's what wrapped to two lines in production).
    expect(container.querySelectorAll('.capiro-directory-stat--unknown').length).toBe(2);
    expect(container.querySelectorAll('.capiro-directory-stat__unknown-note').length).toBe(2);
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

  test('chamber code from the API ("upper"/"lower") renders as Senate/House, not the raw code', async () => {
    mockHappy([
      leg({ id: 'ocd-person/5555', name: 'Jordan Alvarez', chamber: 'upper' }),
      leg({ id: 'ocd-person/6666', name: 'Elliot Kim', chamber: 'lower' }),
    ]);
    renderAt();
    await waitFor(() => expect(screen.getByText('Jordan Alvarez')).toBeTruthy());
    expect(screen.getByText(/VA · Senate · District 10/)).toBeTruthy();
    expect(screen.getByText(/VA · House · District 10/)).toBeTruthy();
    expect(screen.queryByText(/upper/)).toBeNull();
    expect(screen.queryByText(/lower/i)).toBeNull();
  });

  test('a real photo renders on the card; no photo falls back to initials', async () => {
    mockHappy([
      leg({ id: 'ocd-person/7777', name: 'Has Photo', image: 'https://example.invalid/photo.jpg' }),
      leg({ id: 'ocd-person/8888', name: 'No Photo', image: null }),
    ]);
    const { container } = renderAt();
    await waitFor(() => expect(screen.getByText('Has Photo')).toBeTruthy());
    const images = container.querySelectorAll('.capiro-identity-mark__image');
    expect(images.length).toBe(1);
    expect((images[0] as HTMLImageElement).src).toBe('https://example.invalid/photo.jpg');
  });

  test('selecting a card opens the selection rail with the real row data', async () => {
    mockHappy([leg({ email: 'maria@house.gov' })]);
    const { container } = renderAt();
    await waitFor(() => expect(screen.getByText('Maria Chen')).toBeTruthy());
    expect(screen.getByText('No one selected')).toBeTruthy();
    fireEvent.click(screen.getByText('Maria Chen'));
    await waitFor(() => expect(screen.getByText('Selected legislator')).toBeTruthy());
    // The card footer shows the same email, so scope this query to the rail.
    const rail = container.querySelector('.capiro-directory-rail') as HTMLElement;
    expect(rail.textContent).toContain('maria@house.gov');
    expect(screen.getByText('Open full profile')).toBeTruthy();
  });
});
