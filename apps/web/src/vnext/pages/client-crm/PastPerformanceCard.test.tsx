import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PastPerformanceCard } from './PastPerformanceCard.js';
import type { Client } from '../../../pages/clients/clientTypes.js';

/**
 * Past performance, previously Capabilities §7.3, now mounted on Intelligence /
 * Federal Footprint. These are the row-12 wire-audit assertions carried over
 * verbatim against the extracted component, so the move cannot quietly turn a
 * real submission-history read back into the CAP_PERF fixture.
 */

const getMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock }),
}));

const client: Client = {
  id: 'client-1',
  name: 'Overland AI',
  website: 'overland.ai',
  description: null,
  productDescription: null,
  primaryContactName: null,
  primaryContactEmail: null,
  primaryContactPhone: null,
  logoS3Key: null,
  logoContentType: null,
  logoUploadedAt: null,
  intakeData: null,
  status: 'active',
  createdAt: '2026-01-15T00:00:00.000Z',
  updatedAt: '2026-01-15T00:00:00.000Z',
};

const CAPABILITY = { id: 'cap-1', name: 'Autonomy stack', type: 'platform', tags: [], peNumbers: [] };

/** Routes capabilities vs. per-capability submission history. */
function mockCapabilityApi(history: unknown[]) {
  getMock.mockImplementation((url: string) => {
    // The client-wide read is the primary path (one request, primes the
    // per-capability caches); the per-capability stub covers the fallback.
    if (url.endsWith('/submission-history')) return Promise.resolve({ data: history });
    if (url.endsWith('/history')) return Promise.resolve({ data: history });
    if (url.endsWith('/capabilities')) return Promise.resolve({ data: [CAPABILITY] });
    return Promise.resolve({ data: [] });
  });
}

function renderPastPerformance() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <PastPerformanceCard client={client} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
});

describe('PastPerformanceCard (was Capabilities §7.3, row 12)', () => {
  it('renders the real submission history instead of the CAP_PERF fixture', async () => {
    mockCapabilityApi([
      {
        id: 'sub-1',
        clientId: 'client-1',
        capabilityId: 'cap-1',
        fiscalYear: 'FY28',
        // Absent from portfolio-fixtures.ts, so this cannot pass against CAP_PERF.
        title: 'Ground autonomy retrofit line',
        meta: 'Submitted to SASC professional staff',
        outcome: 'Included +$4M',
        outcomeType: 'success',
        notes: null,
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-01T00:00:00.000Z',
      },
    ]);
    renderPastPerformance();

    expect(await screen.findByText('Ground autonomy retrofit line')).toBeInTheDocument();
    expect(screen.getByText('Included +$4M')).toBeInTheDocument();
    // Real count, not the design's hardcoded "View all 14".
    expect(screen.getByText('1 record')).toBeInTheDocument();
    expect(screen.queryByText('View all 14')).not.toBeInTheDocument();
    // The CAP_PERF fixture must not leak through as if real.
    expect(screen.queryByText('ULTRA autonomy integration')).not.toBeInTheDocument();
    expect(screen.queryByText('GPS-denied navigation study')).not.toBeInTheDocument();
  });

  it('expands View all using the live submission count and can collapse again', async () => {
    mockCapabilityApi(
      ['One', 'Two', 'Three', 'Four'].map((title, index) => ({
        id: `sub-${index + 1}`,
        clientId: 'client-1',
        capabilityId: 'cap-1',
        fiscalYear: `FY${27 + index}`,
        title: `Submission ${title}`,
        meta: null,
        outcome: null,
        outcomeType: 'pending',
        notes: null,
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-01T00:00:00.000Z',
      })),
    );
    renderPastPerformance();

    const viewAll = await screen.findByRole('button', { name: 'View all 4' });
    // Collapsed = the three most RECENT fiscal years (FY30–FY28) — that is
    // what the "Show recent" toggle label promises. FY27 waits behind View all.
    expect(screen.getByText('Submission Four')).toBeInTheDocument();
    expect(screen.getByText('Submission Two')).toBeInTheDocument();
    expect(screen.queryByText('Submission One')).not.toBeInTheDocument();

    fireEvent.click(viewAll);
    expect(await screen.findByText('Submission One')).toBeInTheDocument();
    const collapse = screen.getByRole('button', { name: 'Show recent' });

    fireEvent.click(collapse);
    await waitFor(() => expect(screen.queryByText('Submission One')).not.toBeInTheDocument());
  });

  it('shows a real empty state when the client has no submissions', async () => {
    mockCapabilityApi([]);
    renderPastPerformance();

    expect(
      await screen.findByText("No submissions recorded against this client's capabilities yet."),
    ).toBeInTheDocument();
  });

  /**
   * This card used to be the one exception on this page: every other card
   * (Lobbying activity, Federal awards, Political giving) shows an honest
   * "could not be loaded" message with a Retry action on a confirmed error;
   * this one silently rendered the CAP_PERF design fixture instead, with no
   * way to tell it apart from real data and no way to retry.
   */
  it('shows an honest "could not be loaded" message with Retry, not the CAP_PERF fixture, when a read fails', async () => {
    getMock.mockImplementation((url: string) => {
      if (url.endsWith('/capabilities')) return Promise.reject(new Error('capabilities service unavailable'));
      return Promise.resolve({ data: [] });
    });
    renderPastPerformance();

    expect(await screen.findByText('Past performance could not be loaded.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // The CAP_PERF fixture must never survive a confirmed error.
    expect(screen.queryByText('ULTRA autonomy integration')).not.toBeInTheDocument();
    expect(screen.queryByText('GPS-denied navigation study')).not.toBeInTheDocument();
    // Nor the "N records" chip / View all — we don't know a real count.
    // Anchored to the chip's exact "N record(s)" shape: a bare /record/
    // also matches the card's own always-present description ("Submissions
    // recorded against this client's capabilities…"), which is not a count
    // and must still render on an error.
    expect(screen.queryByText(/^\d+ records?$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^View all \d+$/)).not.toBeInTheDocument();
  });

  it('re-fetches capabilities and submission history when Retry is clicked', async () => {
    let capabilitiesCalls = 0;
    getMock.mockImplementation((url: string) => {
      if (url.endsWith('/capabilities')) {
        capabilitiesCalls += 1;
        return Promise.reject(new Error('capabilities service unavailable'));
      }
      return Promise.resolve({ data: [] });
    });
    renderPastPerformance();

    await screen.findByText('Past performance could not be loaded.');
    const callsBeforeRetry = capabilitiesCalls;

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(capabilitiesCalls).toBeGreaterThan(callsBeforeRetry));
  });
});
