/**
 * FundingOpportunitiesV2Page — gate + surface probe.
 *
 * The route gate (FundingOpportunitiesV2Gate in App.tsx) renders the v2 workspace
 * for capiro-internal and the legacy surface for every other tenant. These probes
 * assert the v2 surface mounts its mockup anchors (funnel, rail, view bar, stats)
 * and that the flag-off state renders the honest "not enabled" empty state.
 */
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { vi, describe, expect, it, beforeEach } from 'vitest';

const apiGet = vi.fn();
const apiPost = vi.fn();

vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGet, post: apiPost }),
}));

const flags: Record<string, boolean> = {
  funding_opportunities: true,
  funding_opportunities_client_inbox: true,
  funding_opportunities_pipeline_v2: true,
};
vi.mock('../../../../lib/intel-feature-flags.js', () => ({
  useIntelFeatureFlags: () => ({ data: flags }),
  useIntelFeature: (f: string) => ({ enabled: Boolean(flags[f]), ready: true }),
}));

import { FundingOpportunitiesV2Page } from './FundingOpportunitiesV2Page.js';

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiGet.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/clients'))
      return { data: [{ id: 'c1', name: 'Overland AI', status: 'active' }] };
    if (url.startsWith('/api/intelligence/opportunities/inbox'))
      return {
        data: {
          filter: 'needs_review',
          clientId: null,
          source: null,
          rows: [],
          nextCursor: null,
          pageSize: 25,
          counts: {
            needs_review: 0,
            pursuing: 0,
            deadlines: 0,
            recently_changed: 0,
            monitoring: 0,
            passed: 0,
          },
          countsAllClients: null,
          countsUnavailableReason: null,
          generatedAt: new Date().toISOString(),
        },
      };
    if (url.startsWith('/api/intelligence/opportunities'))
      return {
        data: {
          opportunities: [],
          total: 0,
          totalIsCapped: false,
          page: 1,
          pageSize: 1,
          counts: {
            activeGrants: 0,
            activeContracts: 0,
            saved: 0,
            pursuing: 0,
            dismissed: 0,
            deadlinesIn30Days: 0,
          },
          freshness: [],
          emptyReason: 'no_source_records',
          emptyExplanation: 'No source records.',
          missingProfileFields: [],
          generatedAt: new Date().toISOString(),
        },
      };
    return { data: {} };
  });
});

describe('FundingOpportunitiesV2Page', () => {
  it('mounts the v2 shell anchors: header, funnel, rail, view bar, stats', async () => {
    render(<FundingOpportunitiesV2Page />, { wrapper });
    expect(await screen.findByTestId('fo-v2-page')).toBeInTheDocument();
    expect(screen.getByText('Funding Opportunities')).toBeInTheDocument();
    // funnel tabs
    expect(screen.getByRole('tab', { name: /Explore/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Matched/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Triage/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Pipeline/i })).toBeInTheDocument();
    // view bar + stats
    expect(screen.getByTestId('fo-v2-stats')).toBeInTheDocument();
    // never fakes the unsupported header affordances
    expect(screen.queryByText('Saved views')).not.toBeInTheDocument();
    expect(screen.queryByText('Add pursuit')).not.toBeInTheDocument();
  });

  it('renders the honest not-enabled empty state when the master flag is off', async () => {
    flags.funding_opportunities = false;
    render(<FundingOpportunitiesV2Page />, { wrapper });
    expect(await screen.findByTestId('fo-v2-disabled')).toBeInTheDocument();
    flags.funding_opportunities = true;
  });
});
