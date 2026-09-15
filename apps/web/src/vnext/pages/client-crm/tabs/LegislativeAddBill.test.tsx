import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
