import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AddBillModal } from './LegislativeAddBill.js';

const getMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock }),
}));

const flagState = vi.hoisted(() => ({ current: { enabled: true, ready: true } as { enabled: boolean; ready: boolean } }));
vi.mock('../../../../lib/intel-feature-flags.js', () => ({
  useIntelFeature: () => flagState.current,
}));

function renderModal(onTrack: (billId: string) => Promise<unknown>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AddBillModal open clientId="client-1" boardBillIds={new Set()} onTrack={onTrack} onClose={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const SEARCH_URL = '/intel-api/clients/client-1/tracker/bill-search';

beforeEach(() => {
  getMock.mockReset();
  flagState.current = { enabled: true, ready: true };
});

describe('AddBillModal — search states', () => {
  it('names a failed search instead of falsely claiming "No bills match"', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.startsWith(SEARCH_URL)) return Promise.reject({ response: { status: 500 } });
      if (url.includes('alert-prefs')) return Promise.resolve({ data: { jurisdictions: ['US'] } });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    renderModal(vi.fn().mockResolvedValue({}));

    fireEvent.change(screen.getByLabelText('Search bills'), { target: { value: 'robotics' } });

    expect(
      await screen.findByText('Bill search is unavailable right now. Try again in a moment.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No bills match/)).not.toBeInTheDocument();
  });

  it('shows the real empty state only when the search succeeded with zero results', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.startsWith(SEARCH_URL)) return Promise.resolve({ data: [] });
      if (url.includes('alert-prefs')) return Promise.resolve({ data: { jurisdictions: ['US'] } });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    renderModal(vi.fn().mockResolvedValue({}));

    fireEvent.change(screen.getByLabelText('Search bills'), { target: { value: 'zzz-nothing' } });

    expect(await screen.findByText(/No bills match/)).toBeInTheDocument();
    expect(screen.queryByText(/unavailable/)).not.toBeInTheDocument();
  });
});

describe('AddBillModal — dynamic corpus metadata', () => {
  it('renders jurisdiction chips from corpus metadata and searches all of them by default', async () => {
    const calls: Array<{ url: string; params: unknown }> = [];
    getMock.mockImplementation((url: string, opts?: { params?: unknown }) => {
      if (url.startsWith(SEARCH_URL)) {
        calls.push({ url, params: opts?.params });
        return Promise.resolve({ data: [] });
      }
      if (url.includes('alert-prefs')) return Promise.resolve({ data: { jurisdictions: ['US'] } });
      if (url.endsWith('/legiwatch/bills/corpus-metadata'))
        return Promise.resolve({
          data: {
            jurisdictions: [
              { key: 'US', count: 113 },
              { key: 'FL', count: 4 },
              { key: 'GA', count: 2 },
              { key: 'MA', count: 1 },
            ],
            sessions: [],
          },
        });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    renderModal(vi.fn().mockResolvedValue({}));

    // Chips come from the actual corpus metadata, not a hardcoded list.
    const group = await screen.findByRole('group', { name: 'Jurisdictions' });
    for (const label of ['Congress', 'FL', 'GA', 'MA'])
      expect(within(group).getByRole('button', { name: label })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search bills'), { target: { value: 'marker' } });
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    // Default = every ingested jurisdiction (empty watchlist scope ignored).
    expect(calls[0]!.params).toMatchObject({ jurisdictions: ['US', 'FL', 'GA', 'MA'] });

    // Narrowing: deselecting every other chip leaves MA as the only search
    // jurisdiction (jurisdictions start as the full available list).
    for (const label of ['Congress', 'FL', 'GA'])
      fireEvent.click(within(group).getByRole('button', { name: label }));
    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            JSON.stringify((c.params as { jurisdictions?: string[] }).jurisdictions) ===
            JSON.stringify(['MA']),
        ),
      ).toBe(true),
    );
  });
});

describe('AddBillModal — track write', () => {
  const bill = {
    billId: '119-hr-5150',
    displayNum: 'H.R. 5150',
    title: 'Maritime Uncrewed Logistics Act',
    stage: 'introduced' as const,
    jurisdiction: 'US',
  };

  function mockSearch() {
    getMock.mockImplementation((url: string) => {
      if (url.startsWith(SEARCH_URL)) return Promise.resolve({ data: [bill] });
      if (url.includes('alert-prefs')) return Promise.resolve({ data: { jurisdictions: ['US'] } });
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
  }

  it('marks the row On board only after the write resolves', async () => {
    mockSearch();
    let resolveTrack: (v: unknown) => void = () => {};
    const onTrack = vi.fn(
      () => new Promise((resolve) => { resolveTrack = resolve; }),
    );
    renderModal(onTrack);

    fireEvent.change(screen.getByLabelText('Search bills'), { target: { value: 'maritime' } });
    const trackBtn = await screen.findByRole('button', { name: 'Track' });
    fireEvent.click(trackBtn);

    expect(onTrack).toHaveBeenCalledWith('119-hr-5150');
    expect(screen.queryByText('✓ On board')).not.toBeInTheDocument();

    resolveTrack({});
    expect(await screen.findByText('✓ On board')).toBeInTheDocument();
  });

  it('surfaces a failed track write on the row instead of silently snapping back', async () => {
    mockSearch();
    const onTrack = vi.fn().mockRejectedValue(new Error('duplicate track'));
    renderModal(onTrack);

    fireEvent.change(screen.getByLabelText('Search bills'), { target: { value: 'maritime' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Track' }));

    expect(
      await screen.findByText(/Couldn’t track H\.R\. 5150\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/duplicate track/)).toBeInTheDocument();
    // The row stays trackable — not falsely marked On board.
    expect(screen.queryByText('✓ On board')).not.toBeInTheDocument();
  });
});
