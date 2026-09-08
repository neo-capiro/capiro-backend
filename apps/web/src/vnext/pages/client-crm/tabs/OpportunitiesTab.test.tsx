import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Client } from '../../../../pages/clients/clientTypes.js';
import type { FundingOpportunity } from '../../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import { ClientCrmOpportunitiesProto } from './OpportunitiesTab.js';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => ({ get: apiGet }) }));
vi.mock('../../../../lib/intel-feature-flags.js', () => ({
  useIntelFeature: () => ({ enabled: true, ready: true }),
}));
vi.mock('../../../components/feedback/toast.js', () => ({
  useCapiroToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../../pages/clients/relevance-api.js', () => ({
  getRelevantPesForClient: async () => ({ data: [] }),
  formatScorePct: (score: number) => `${score * 100}%`,
}));
afterEach(cleanup);

describe('client opportunity relevance', () => {
  test('decodes upstream title entities as plain text without creating markup', async () => {
    apiGet.mockResolvedValue({ data: {
      counts: { activeGrants: 1, activeContracts: 0, pursuing: 0, saved: 0 },
      nextDeadline: null, topContracts: [], topGrants: [{
        id: 'grant-encoded', source: 'grants_gov', sourceRecordId: 'grant-encoded',
        title: 'Research &amp; Development &#8212; &lt;img src=x onerror=alert(1)&gt;',
        kind: 'grant', agency: 'NSF', responseDeadline: null, responseDeadlineNote: null,
        grantFunding: null, contractValue: null, workflow: null,
        eligibility: { state: 'needs_review', reason: 'Review applicant criteria.' },
        matchedSignals: [],
      }],
    } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(<MemoryRouter><QueryClientProvider client={queryClient}>
      <ClientCrmOpportunitiesProto client={{ id: 'client-1', name: 'County' } as Client} />
    </QueryClientProvider></MemoryRouter>);
    const link = await screen.findByRole('link', {
      name: 'Research & Development — <img src=x onerror=alert(1)>',
    });
    expect(link.querySelector('img')).toBeNull();
    expect(link.innerHTML).toContain('&lt;img');
    expect(link).toHaveAttribute('href', '/intelligence/opportunities/grants_gov/grant-encoded?clientId=client-1');
  });

  test('shows the recorded funding priority separately from grant eligibility', async () => {
    const grant = {
      id: 'grant-1',
      source: 'grants_gov',
      sourceRecordId: 'grant-1',
      title: 'Rural connectivity program',
      kind: 'grant',
      agency: 'USDA',
      responseDeadline: null,
      responseDeadlineNote: null,
      grantFunding: null,
      contractValue: null,
      workflow: null,
      eligibility: { state: 'needs_review', reason: 'Confirm the organization type.' },
      matchedSignals: [
        {
          signal: 'applicantType',
          strength: 'strong',
          weight: 25,
          matchedOn: 'County governments',
        },
        { signal: 'stateRestriction', strength: 'weak', weight: 15, matchedOn: 'VA' },
        {
          signal: 'capabilityKeyword',
          source: 'funding_priority',
          strength: 'moderate',
          weight: 15,
          matchedOn: 'rural broadband deployment',
        },
      ],
    } as FundingOpportunity;
    apiGet.mockResolvedValue({
      data: {
        clientId: 'client-1',
        counts: { activeGrants: 1, activeContracts: 0, pursuing: 0, saved: 0 },
        nextDeadline: null,
        topGrants: [grant],
        topContracts: [],
        emptyExplanation: null,
      },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <ClientCrmOpportunitiesProto client={{ id: 'client-1', name: 'County' } as Client} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(
      await screen.findByText('Funding priority match: rural broadband deployment'),
    ).toBeInTheDocument();
    expect(screen.getByText('Eligibility: Needs review')).toHaveAttribute(
      'title',
      'Confirm the organization type.',
    );
    expect(screen.queryByText(/County governments/)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Rural connectivity program' })).toHaveAttribute(
      'href',
      '/intelligence/opportunities/grants_gov/grant-1?clientId=client-1',
    );
  });
});
