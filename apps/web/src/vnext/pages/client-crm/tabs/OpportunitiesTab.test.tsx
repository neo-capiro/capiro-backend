import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientCrmOpportunitiesProto } from './OpportunitiesTab.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';

/**
 * Moved verbatim from IntelligenceTab.test.tsx's "funding panel (items 4-5,
 * wire-audit)" describe block when Funding & Budget became its own top-level
 * client directory ("Opportunities") instead of an Intelligence domain — same
 * assertions, same fixtures, only the component under test changed.
 */

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock, post: postMock }),
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

function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">
      {location.pathname}
      {location.search}
    </div>
  );
}

function renderOpportunities() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/clients']}>
        <Routes>
          <Route
            path="/clients"
            element={
              <>
                <ClientCrmOpportunitiesProto client={client} />
                <LocationProbe />
              </>
            }
          />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const RELEVANT_PE = {
  peCode: '0602308A',
  title: 'Advanced Robotics Research',
  score: 0.82,
  paths: [{ path: 'capability_pe_direct', score: 0.82, evidence: ['Capability "Autonomy stack" lists PE 0602308A'] }],
};

const OPPORTUNITY_SUMMARY = {
  clientId: 'client-1',
  counts: { activeGrants: 2, activeContracts: 3, saved: 1, pursuing: 1, dismissed: 0, deadlinesIn30Days: 1 },
  nextDeadline: null,
  topGrants: [
    {
      id: 'opp-1',
      source: 'grants_gov',
      sourceUrl: 'https://grants.gov/opp-1',
      kind: 'grant',
      title: 'Autonomy Research Grant',
      agency: 'DARPA',
      responseDeadline: '2026-09-01T00:00:00.000Z',
      responseDeadlineNote: null,
      grantFunding: { estimatedProgramFunding: 2_000_000, awardFloor: null, awardCeiling: 2_400_000, expectedAwardCount: null, costSharingRequired: null },
      contractValue: null,
      relevanceScore: 87,
      workflow: { id: 'wf-1', status: 'pursuing', owner: null, facility: null, notes: null, dismissedReason: null, outcomeNote: null, userCreated: false, staleAt: null, createdAt: '2026-01-01T00:00:00.000Z' },
    },
  ],
  topContracts: [],
  missingProfileFields: [],
  freshness: [],
  emptyReason: null,
  emptyExplanation: null,
  generatedAt: '2026-08-16T00:00:00.000Z',
};

function mockFundingApis(overrides: { pes?: unknown; flags?: unknown; opportunities?: unknown } = {}) {
  const pes = overrides.pes ?? { data: [RELEVANT_PE], total: 1, page: 1, limit: 12 };
  const flags = overrides.flags ?? { funding_opportunities: true };
  const opportunities = overrides.opportunities ?? OPPORTUNITY_SUMMARY;
  getMock.mockImplementation((url: string) => {
    if (url === '/api/intelligence/clients/client-1/pe-relevance') return Promise.resolve({ data: pes });
    if (url === '/intel-api/feature-flags') return Promise.resolve({ data: flags });
    if (url === '/api/intelligence/clients/client-1/opportunities/summary') return Promise.resolve({ data: opportunities });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

describe('ClientCrmOpportunitiesProto (items 4-5, wire-audit)', () => {
  beforeEach(() => {
    getMock.mockReset();
  });

  it('re-fetches the opportunities and PE-relevance sources when Sync sources is clicked', async () => {
    mockFundingApis();
    renderOpportunities();

    await waitFor(() => expect(screen.getByText('Advanced Robotics Research')).toBeInTheDocument());
    const callsBeforeSync = getMock.mock.calls.length;

    fireEvent.click(screen.getByText('Sync sources'));

    // A static button with no onClick did nothing on click; this asserts a
    // real re-read of the same sources the panel below already renders.
    await waitFor(() => expect(getMock.mock.calls.length).toBeGreaterThan(callsBeforeSync));
  });

  it('renders real relevant PEs and wires "Open PE" navigation using the real peCode (item 4)', async () => {
    mockFundingApis();
    renderOpportunities();

    await waitFor(() => expect(screen.getByText('Advanced Robotics Research')).toBeInTheDocument());
    expect(screen.getByText('82%')).toBeInTheDocument();
    // The fixture's own PE must not leak through as if real.
    expect(screen.queryByText('Ground Vehicle Autonomy Kit')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Open PE →'));
    expect(screen.getByTestId('location')).toHaveTextContent('/program-elements/0602308A');
  });

  it('wires the "Open budget" header link to the real Program Elements index (item 4)', async () => {
    mockFundingApis();
    renderOpportunities();

    await waitFor(() => expect(screen.getByText('Advanced Robotics Research')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Open budget'));
    expect(screen.getByTestId('location')).toHaveTextContent('/program-elements');
  });

  it('renders the real opportunities list when funding_opportunities is enabled (item 5)', async () => {
    mockFundingApis();
    renderOpportunities();

    await waitFor(() => expect(screen.getByText('Autonomy Research Grant')).toBeInTheDocument());
    // "Pursuing" also appears in the domain stats strip's own fixture cell.
    expect(screen.getAllByText('Pursuing').length).toBeGreaterThan(0);
    expect(screen.getByText('87% fit')).toBeInTheDocument();
    // The fixture's own opportunities must not leak through as if real.
    expect(screen.queryByText('Ground Robotics Autonomy Kit')).not.toBeInTheDocument();
  });

  it('keeps the opportunities design fixture when funding_opportunities is disabled for the tenant', async () => {
    mockFundingApis({ flags: {} });
    renderOpportunities();

    await waitFor(() => expect(screen.getByText('Advanced Robotics Research')).toBeInTheDocument());
    expect(screen.getByText('View all 7')).toBeInTheDocument();
    expect(screen.queryByText('Autonomy Research Grant')).not.toBeInTheDocument();
  });

  it('shows an honest empty message when no program element clears the relevance threshold', async () => {
    mockFundingApis({ pes: { data: [], total: 0, page: 1, limit: 12 } });
    renderOpportunities();

    await waitFor(() =>
      expect(
        screen.getByText('No program elements scored above the relevance threshold for this client.'),
      ).toBeInTheDocument(),
    );
  });

  it('shows an honest error, not the OPPS/PROGRAMS fixtures, when funding queries fail on an enabled tenant', async () => {
    getMock.mockImplementation((url: string) => {
      if (url === '/intel-api/feature-flags') return Promise.resolve({ data: { funding_opportunities: true } });
      if (url === '/api/intelligence/clients/client-1/opportunities/summary') {
        return Promise.reject(new Error('opportunities service unavailable'));
      }
      if (url === '/api/intelligence/clients/client-1/pe-relevance') {
        return Promise.reject(new Error('relevance service unavailable'));
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    renderOpportunities();

    // `opportunitiesQ` sets an explicit retry: 1 on the query itself, which
    // overrides this test's QueryClient-level retry:false default.
    await waitFor(
      () => expect(screen.getByText(/Funding opportunities could not be loaded/)).toBeInTheDocument(),
      { timeout: 5000 },
    );
    expect(screen.getByText(/Relevant budget programs could not be loaded/)).toBeInTheDocument();
    expect(screen.queryByText('Autonomous Ground Vehicle Integration')).not.toBeInTheDocument();
    expect(screen.queryByText('Ground Robotics')).not.toBeInTheDocument();
    expect(screen.queryByText('View all 7')).not.toBeInTheDocument();
  });
});
