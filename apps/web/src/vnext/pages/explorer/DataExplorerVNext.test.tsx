/**
 * Data Explorer vNext — behavior contract with the canonical DataExplorerPage.
 *
 * Locks the load-bearing behavior, on real distinguishing fixture values
 * (never fixture-string echoes — the vacuous-pass trap):
 *   · default tab is News Feed; bare /explorer self-normalizes to
 *     ?source=articles via replace
 *   · ?source=<key> deep links select that tab and fire that source's
 *     endpoint with its canonical params (comment-deadlines pins
 *     openCommentOnly + sort=comment-close)
 *   · ?bill=<id> implies the bills tab AND opens the bill detail drawer,
 *     fetching /api/explorer/congress-bills/<id> under the shared
 *     ['explorer-bill-detail', id] query key
 *   · switching tabs rewrites ?source= and queries the new source with
 *     pageSize 25 under its canonical query key
 *   · row click opens the drill-in drawer titled "<Source label> · <summary>"
 *     and fires the detail endpoint
 *   · zero rows render the canonical empty copy (tables vs news feed)
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataExplorerVNext } from './DataExplorerVNext.js';

const apiGet = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGet }),
}));

const LDA_ROWS = [
  {
    id: 'lda-77',
    filingUuid: 'uuid-77',
    filingType: 'Q2',
    filingYear: 2026,
    filingPeriod: 'Q2',
    income: 1_500_000,
    expenses: null,
    dtPosted: '2026-05-01',
    registrantName: 'Cassidy & Associates',
    clientName: 'Vantage Orbital Systems',
    clientState: 'VA',
    issueCodes: ['DEF', 'BUD'],
  },
];

const ARTICLE_ROWS = [
  {
    id: 'art-9',
    source: 'Politico',
    title: 'Approps markup slips to September',
    url: 'https://www.politico.com/example',
    author: 'R. Chen',
    publishedAt: '2026-08-17T12:00:00Z',
    summary: 'The subcommittee schedule moved again.',
    topics: ['Appropriations'],
    agencies: ['DoD'],
  },
];

const BILL_DETAIL = {
  bill: {
    id: 'hr123-119',
    congress: 119,
    billType: 'HR',
    billNumber: '123',
    title: 'Orbital Debris Mitigation Act',
    introducedDate: '2026-02-11',
    sponsorName: 'A. Lawmaker',
    sponsorState: 'CO',
    sponsorParty: 'D',
    latestActionText: 'Referred to committee.',
    latestActionDate: '2026-03-01',
    policyArea: 'Science',
    cosponsorsCount: 12,
    originChamber: 'House',
    url: null,
    updateDate: null,
    subjects: ['Space debris'],
    actions: [],
  },
};

function respond(url: string, config?: { params?: Record<string, unknown> }) {
  void config;
  if (url === '/api/explorer/intel-articles') return { rows: ARTICLE_ROWS, total: 1 };
  if (url === '/api/explorer/lda-filings') return { rows: LDA_ROWS, total: 1 };
  if (url.startsWith('/api/explorer/lda-filings/'))
    return { filing: { ...LDA_ROWS[0], clientId: null, registrantId: null }, registrantRecent: [], clientRecent: [], issueCodes: [{ code: 'DEF', name: 'Defense' }] };
  if (url.startsWith('/api/explorer/congress-bills/')) return BILL_DETAIL;
  if (url === '/api/explorer/congress-bills') return { rows: [], total: 0 };
  if (url === '/api/explorer/federal-register') return { rows: [], total: 0 };
  // Facet endpoints and anything else: empty shapes (facet arrays are all
  // optional-chained in the sources).
  if (url.includes('facet')) return {};
  return { rows: [], total: 0 };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderAt(url: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[url]}>
        <DataExplorerVNext />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
}

beforeEach(() => {
  apiGet.mockReset();
  apiGet.mockImplementation(async (url: string, config?: { params?: Record<string, unknown> }) => ({
    data: respond(url, config),
  }));
});

describe('DataExplorerVNext — URL state', () => {
  it('defaults to News Feed and normalizes bare /explorer to ?source=articles via replace', async () => {
    renderAt('/explorer');
    expect(await screen.findByText('Approps markup slips to September')).toBeInTheDocument();
    expect(screen.getByTestId('location').textContent).toBe('/explorer?source=articles');
    // The articles source queried its canonical endpoint with page-size 25.
    expect(apiGet).toHaveBeenCalledWith('/api/explorer/intel-articles', {
      params: {
        q: undefined,
        sources: undefined,
        topics: undefined,
        agencies: undefined,
        page: 1,
        pageSize: 25,
      },
    });
  });

  it('honors a ?source= deep link and pins comment-deadlines to open-comment + comment-close sort', async () => {
    renderAt('/explorer?source=comment-deadlines');
    // Canonical empty copy for a zero-row table source.
    expect(await screen.findByText('No rows match these filters.')).toBeInTheDocument();
    expect(
      screen.getByText('Open comment periods on federal rules, closing soonest.'),
    ).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/api/explorer/federal-register', {
      params: {
        q: undefined,
        agencies: undefined,
        openCommentOnly: true,
        sort: 'comment-close',
        page: 1,
        pageSize: 25,
      },
    });
  });

  it('falls back to News Feed for an unknown ?source=', async () => {
    renderAt('/explorer?source=not-a-source');
    expect(await screen.findByText('Approps markup slips to September')).toBeInTheDocument();
    expect(screen.getByTestId('location').textContent).toBe('/explorer?source=articles');
  });

  it('?bill= implies the bills tab and opens the bill detail drawer from the shared hook', async () => {
    renderAt('/explorer?bill=hr123-119');
    const drawer = await screen.findByRole('dialog', { name: 'Congress Bills · hr123-119' });
    expect(drawer).toBeInTheDocument();
    // Detail body renders the REAL bill payload, not the fixture id echo.
    expect(await screen.findByText('Orbital Debris Mitigation Act')).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith('/api/explorer/congress-bills/hr123-119');
    // The bills tab is the selected one.
    expect(screen.getByRole('tab', { name: 'Congress Bills' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('switching tabs rewrites ?source= and queries the new source under its canonical key', async () => {
    const { queryClient } = renderAt('/explorer');
    await screen.findByText('Approps markup slips to September');

    fireEvent.click(screen.getByRole('tab', { name: 'LDA Filings' }));

    expect(await screen.findByText('Cassidy & Associates')).toBeInTheDocument();
    expect(screen.getByTestId('location').textContent).toBe('/explorer?source=lda');
    expect(apiGet).toHaveBeenCalledWith(
      '/api/explorer/lda-filings',
      expect.objectContaining({ params: expect.objectContaining({ page: 1, pageSize: 25 }) }),
    );
    // Canonical query key, shared with app.capiro.ai's page.
    expect(
      queryClient
        .getQueryCache()
        .findAll()
        .some((query) => query.queryKey[0] === 'explorer-lda-filings'),
    ).toBe(true);
  });
});

describe('DataExplorerVNext — results and drill-in', () => {
  it('renders real row values (formatted money, registrant, client) and the meta line', async () => {
    renderAt('/explorer?source=lda');
    expect(await screen.findByText('Cassidy & Associates')).toBeInTheDocument();
    expect(screen.getByText('Vantage Orbital Systems')).toBeInTheDocument();
    expect(screen.getByText('$1.5M')).toBeInTheDocument();
    // "1 record · showing 1–1"
    expect(screen.getByText(/record · showing/)).toBeInTheDocument();
  });

  it('row click opens the drill-in drawer titled "<Source label> · <summary>" and fetches the detail', async () => {
    renderAt('/explorer?source=lda');
    fireEvent.click(await screen.findByText('Vantage Orbital Systems'));

    const drawer = await screen.findByRole('dialog', {
      name: 'LDA Filings · Vantage Orbital Systems',
    });
    expect(drawer).toBeInTheDocument();
    await waitFor(() => {
      expect(apiGet).toHaveBeenCalledWith('/api/explorer/lda-filings/lda-77');
    });
    // Detail body shows the real filing UUID from the payload.
    expect(await screen.findByText('uuid-77')).toBeInTheDocument();
  });

  it('renders the canonical empty copy for a zero-row news feed', async () => {
    apiGet.mockImplementation(async (url: string) => ({
      data: url.includes('facet') ? {} : { rows: [], total: 0 },
    }));
    renderAt('/explorer?source=articles');
    expect(await screen.findByText('No articles match these filters.')).toBeInTheDocument();
  });
});
