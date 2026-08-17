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
    // Enum-shaped import artifact — must render humanized, never raw.
    sectorTag: 'GOVERNMENT_AFFAIRS',
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
  meetingsThisWeek: 2,
  activeStrategies: 5,
};

function makeApi(
  overrides: { clientsError?: boolean; summaryError?: boolean; clientsArchivedOnly?: boolean } = {},
) {
  return {
    get: async (path: string) => {
      if (path === '/api/clients') {
        if (overrides.clientsError) throw new Error('clients boom');
        if (overrides.clientsArchivedOnly) {
          return {
            data: [
              { id: 'c-9', name: 'Old Co', status: 'archived', profileStatus: 'ACTIVE', sectorTag: null, website: null, primaryContactName: null, intakeData: null },
            ],
          };
        }
        return { data: clients };
      }
      if (path === '/api/intelligence/portfolio-summary') {
        if (overrides.summaryError) throw new Error('summary boom');
        return { data: summary };
      }
      if (path === '/api/client-account-owners') {
        return { data: { 'c-1': { accountOwnerUserId: 'u-1', accountOwner: { id: 'u-1', email: 'owner@test.com', firstName: 'Test', lastName: 'Owner' } } } };
      }
      if (path === '/api/intelligence/portfolio-rollup') {
        return {
          data: {
            rollup: {
              'c-1': { attentionCount: 3, intelCount: 5, nextTouch: { id: 'm-1', startsAt: '2026-08-20T15:00:00.000Z', subject: 'HASC briefing' }, workCount: 2 },
              'c-2': { attentionCount: 0, intelCount: 2, nextTouch: null, workCount: 0 },
              'c-3': { attentionCount: 1, intelCount: 0, nextTouch: null, workCount: 4 },
            },
          },
        };
      }
      if (path === '/api/intelligence/portfolio-pe-summary') {
        return {
          data: {
            netDeltaPct: 3.2,
            peAttribution: { '0603112A': ['Overland AI', 'Acme Robotics'] },
            watchedCount: 5,
          },
        };
      }
      if (path === '/strategy-api/strategies') return { data: [] };
      if (path === '/api/engagement/meetings') return { data: [] };
      if (path === '/api/firm/registrant') {
        return { data: { ldaRegistrantId: null, ldaRegistrantName: null } };
      }
      if (path === '/api/firm/import-candidates') {
        return { data: { registrantId: 1, registrantName: 'Capiro', candidates: [] } };
      }
      if (path === '/api/me') {
        return {
          data: {
            user: { id: 'u-1', clerkUserId: 'cu-1', email: null, firstName: 'Test', lastName: 'User', title: null, emailSignatureEnabled: false, hasEmailSignature: false, tourCompleted: true, legiwatchIntroSeen: true },
            tenant: { id: 't-1', slug: 'test', name: 'Test' },
            role: 'user_admin',
            billingAdmin: false,
            features: { meetingsV2: false, meriDockUndockUi: false },
          },
        };
      }
      throw new Error(`unmocked GET ${path}`);
    },
    post: async () => ({ data: { created: 0 } }),
    put: async () => ({ data: { ldaRegistrantId: 1, ldaRegistrantName: 'Capiro' } }),
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
    expect(screen.getByText('Portfolio pulse')).toBeInTheDocument();
    expect(screen.getByText('Active strategies')).toBeInTheDocument();
    expect(screen.getByText('Meetings this week')).toBeInTheDocument();
    expect(screen.getByText(/Showing 3 of 3 clients/)).toBeInTheDocument();
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

  it('renders the Work column with real per-row counts from the rollup (item 5)', async () => {
    apiOverride = makeApi();
    renderIndex();
    await waitFor(() => expect(screen.getByText('Overland AI')).toBeInTheDocument());
    // Overland AI (c-1) has workCount=2; the cell should contain "2".
    const rows = screen.getAllByRole('row').slice(1); // drop header
    const overlandRow = rows.find((r) => r.textContent?.includes('Overland AI'));
    expect(overlandRow).toBeDefined();
    expect(overlandRow!.textContent).toContain('2');
  });

  it('sorts by readiness (item 6) — clients with more work sort first', async () => {
    apiOverride = makeApi();
    renderIndex('?sort=readiness');
    await waitFor(() => expect(screen.getByText('Overland AI')).toBeInTheDocument());
    const nameCells = screen
      .getAllByRole('row')
      .slice(1)
      .map((r) => r.textContent ?? '');
    // Bluewater Dynamics (c-3) has workCount=4 → first; Overland AI (c-1) workCount=2 → second; Acme Robotics (c-2) workCount=0 → third
    expect(nameCells[0]).toContain('Bluewater Dynamics');
    expect(nameCells[1]).toContain('Overland AI');
    expect(nameCells[2]).toContain('Acme Robotics');
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
    // With no firm anchor the modal opens on the firm-selection step.
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Find your firm in LDA filings' })).toBeInTheDocument(),
    );
  });

  it('opens the import modal from a deep link (?modal=import-lda)', async () => {
    apiOverride = makeApi();
    renderIndex('?modal=import-lda');
    // With no firm anchor the modal opens on the firm-selection step.
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Find your firm in LDA filings' })).toBeInTheDocument(),
    );
  });

  it('renders the active-regulations and LDA spend pulse figures from summary', async () => {
    apiOverride = makeApi();
    renderIndex();
    await waitFor(() => expect(screen.getByText('Overland AI')).toBeInTheDocument());
    expect(screen.getByText('Active regulations')).toBeInTheDocument();
    expect(screen.getByText('LDA spend QTD')).toBeInTheDocument();
    // Money goes through the shared compact formatter, not '$' + toLocaleString.
    expect(screen.getByText('$1.8M')).toBeInTheDocument();
  });

  it('humanizes enum-shaped sector values — no raw SNAKE_CASE reaches the user', async () => {
    apiOverride = makeApi();
    renderIndex();
    await waitFor(() => expect(screen.getByText('Acme Robotics')).toBeInTheDocument());
    // c-2's sectorTag GOVERNMENT_AFFAIRS renders as a humanized FOCUS chip.
    expect(screen.getByText('Government Affairs')).toBeInTheDocument();
    expect(screen.queryByText('GOVERNMENT_AFFAIRS')).not.toBeInTheDocument();
  });

  it('drops the sector from the subtitle when FOCUS chips are present (no duplication)', async () => {
    apiOverride = makeApi();
    renderIndex();
    await waitFor(() => expect(screen.getByText('Overland AI')).toBeInTheDocument());
    // Overland has focus chips (autonomy, robotics) → subtitle is location only.
    expect(screen.getByText('Seattle, WA')).toBeInTheDocument();
    expect(screen.queryByText(/Defense · Seattle/)).not.toBeInTheDocument();
  });

  it('shows the no-clients-yet empty state (not the filter one) when every client is archived', async () => {
    apiOverride = makeApi({ clientsArchivedOnly: true });
    renderIndex();
    await waitFor(() => expect(screen.getByText(/No clients yet/)).toBeInTheDocument());
    expect(screen.queryByText('Clear search and filters')).not.toBeInTheDocument();
  });

  it('renders honest rollup values: zeros as 0, next touch as a dated tooltip or "None scheduled"', async () => {
    apiOverride = makeApi();
    renderIndex();
    await waitFor(() => expect(screen.getByText('Overland AI')).toBeInTheDocument());
    // Overland's next touch: real date with the meeting subject as the tooltip.
    await waitFor(() => expect(screen.getByTitle('HASC briefing')).toBeInTheDocument());
    expect(screen.getByTitle('HASC briefing').textContent).toContain('Aug 20');
    // c-2 and c-3 have no next touch → "None scheduled", never a bare em dash.
    expect(screen.getAllByText('None scheduled')).toHaveLength(2);
    // Acme (c-2) resolved with workCount 0 → the honest zero renders.
    const rows = screen.getAllByRole('row').slice(1);
    const acmeRow = rows.find((r) => r.textContent?.includes('Acme Robotics'));
    expect(acmeRow!.textContent).toContain('0');
  });

  it('makes the row keyboard-accessible: the client name is a real button', async () => {
    apiOverride = makeApi();
    renderIndex();
    await waitFor(() => expect(screen.getByText('Overland AI')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Overland AI' })).toBeInTheDocument();
  });

  it('labels the header refresh control "Refresh", not a hardcoded freshness claim', async () => {
    apiOverride = makeApi();
    renderIndex();
    await waitFor(() => expect(screen.getByText('Overland AI')).toBeInTheDocument());
    expect(screen.getByText('Refresh')).toBeInTheDocument();
    expect(screen.queryByText('Sources refreshed just now')).not.toBeInTheDocument();
  });

  it('shows the footer count line in the cards layout too', async () => {
    apiOverride = makeApi();
    renderIndex('?layout=cards');
    await waitFor(() => expect(screen.getByText('Overland AI')).toBeInTheDocument());
    expect(screen.getByText(/Showing 3 of 3 clients/)).toBeInTheDocument();
  });
});
