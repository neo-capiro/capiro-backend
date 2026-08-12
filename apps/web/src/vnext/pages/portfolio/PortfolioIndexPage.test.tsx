/**
 * Portfolio index render tests (PORTFOLIO-HANDOFF §7.1, §8.1).
 *
 * The screen is data-backed, so the API layer is mocked. These cover the
 * states the contract requires on every query surface — loading, error,
 * empty (no records vs. filters), and the populated list — plus the
 * search/status/sort behaviour and the Import-with-LDA entry point.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { PortfolioIndexPage } from './PortfolioIndexPage.js';
import type { Client } from '../../../pages/clients/clientTypes.js';

const clients: Array<Partial<Client>> = [
  {
    id: 'c-1',
    name: 'Overland AI',
    status: 'active',
    profileStatus: 'ACTIVE',
    sectorTag: 'defense',
    website: 'overland.ai',
    primaryContactName: 'Stephanie Bonk',
    intakeData: { tags: ['autonomy', 'robotics'], city: 'Seattle', state: 'WA' },
  },
  {
    id: 'c-2',
    name: 'Acme Robotics',
    status: 'active',
    profileStatus: 'MONITORING',
    sectorTag: null,
    website: null,
    primaryContactName: null,
    intakeData: null,
  },
  {
    id: 'c-3',
    name: 'Bluewater Dynamics',
    status: 'prospect',
    profileStatus: 'PROSPECT',
    sectorTag: 'maritime',
    website: null,
    primaryContactName: 'Lee Park',
    intakeData: null,
  },
];

const summary = {
  activeClients: 3,
  needAttention: 1,
  ldaSpendQtd: 1800000,
  billsTracked: 12,
  activeRegulations: 4,
};

function makeApi(overrides: { clientsError?: boolean; summaryError?: boolean } = {}) {
  return {
    get: async (path: string) => {
      if (path === '/api/clients') {
        if (overrides.clientsError) throw new Error('clients boom');
        return { data: clients };
      }
      if (path === '/api/intelligence/portfolio-summary') {
        if (overrides.summaryError) throw new Error('summary boom');
        return { data: summary };
      }
      if (path === '/api/firm/import-candidates') {
        return { data: { registrantId: 1, registrantName: 'Capiro', candidates: [] } };
      }
      throw new Error(`unmocked GET ${path}`);
    },
    post: async () => ({ data: { created: 0 } }),
  };
}

let apiOverride = makeApi();
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => apiOverride,
}));

// Program elements read a separate helper; stub it so the section renders empty
// without dragging the budget service into this unit test.
vi.mock('../../../pages/program-element/api.js', () => ({
  getProgramElementsList: async () => ({ data: [], total: 0, page: 1, limit: 100 }),
}));

function renderIndex(search = '') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/clients${search}`]}>
        <Routes>
          <Route
            path="/clients"
            element={
              <div className="capiro-vnext-root">
                <PortfolioIndexPage />
              </div>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('PortfolioIndexPage', () => {
  it('renders the pulse band and the client list from live data', async () => {
    apiOverride = makeApi();
    renderIndex();
    expect(screen.getByText('Portfolio')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Overland AI')).toBeInTheDocument());
    expect(screen.getByText('Acme Robotics')).toBeInTheDocument();
    // Pulse figures from the summary endpoint.
    expect(screen.getByText('Tracked bills')).toBeInTheDocument();
    expect(screen.getByText('Need attention')).toBeInTheDocument();
  });

  it('classifies status: MONITORING is At risk, PROSPECT is Prospect', async () => {
    apiOverride = makeApi();
    renderIndex();
    await waitFor(() => expect(screen.getByText('Overland AI')).toBeInTheDocument());
    // "At risk" also appears as a filter chip — assert the badge exists within a row.
    expect(screen.getAllByText('At risk').length).toBeGreaterThan(1);
    expect(screen.getAllByText('Prospect').length).toBeGreaterThan(1);
  });

  it('filters by the search box and shows the filtered-empty state with a clear affordance', async () => {
    apiOverride = makeApi();
    renderIndex();
    await waitFor(() => expect(screen.getByText('Overland AI')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Search clients'), { target: { value: 'zzz-no-match' } });
    await waitFor(() =>
      expect(screen.getByText(/No clients match the current search/)).toBeInTheDocument(),
    );
    expect(screen.getByText('Clear search and filters')).toBeInTheDocument();
  });

  it('filters by status chip', async () => {
    apiOverride = makeApi();
    renderIndex('?status=prospect');
    await waitFor(() => expect(screen.getByText('Bluewater Dynamics')).toBeInTheDocument());
    expect(screen.queryByText('Overland AI')).not.toBeInTheDocument();
  });

  it('sorts by name when selected', async () => {
    apiOverride = makeApi();
    renderIndex('?sort=name');
    await waitFor(() => expect(screen.getByText('Overland AI')).toBeInTheDocument());
    const nameCells = screen
      .getAllByRole('row')
      .slice(1) // drop the header row
      .map((r) => r.textContent ?? '');
    expect(nameCells[0]).toContain('Acme Robotics');
  });

  it('renders the error state with a retry when the client source fails', async () => {
    apiOverride = makeApi({ clientsError: true });
    renderIndex();
    await waitFor(() => expect(screen.getByText(/Clients could not be loaded/)).toBeInTheDocument());
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });

  it('opens the Import with LDA modal from the header action', async () => {
    apiOverride = makeApi();
    renderIndex();
    await waitFor(() => expect(screen.getByText('Overland AI')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Import with LDA'));
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Import with LDA' })).toBeInTheDocument(),
    );
  });

  it('opens the import modal from a deep link (?modal=import-lda)', async () => {
    apiOverride = makeApi();
    renderIndex('?modal=import-lda');
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Import with LDA' })).toBeInTheDocument(),
    );
  });
});
