import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { FundingOpportunitiesSection } from './FundingOpportunitiesSection.js';

let flags = { enabled: true, ready: true, pipelineEnabled: true };
const apiGetMock = vi.fn();
vi.mock('../../../../lib/intel-feature-flags.js', () => ({
  useIntelFeature: (feature: string) => feature === 'funding_opportunities' ? flags : feature === 'funding_opportunities_pipeline_v2' ? { enabled: flags.pipelineEnabled, ready: true } : { enabled: true, ready: true },
}));
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => ({ get: apiGetMock, post: vi.fn(), patch: vi.fn(), delete: vi.fn() }) }));

const response = (overrides: Record<string, unknown> = {}) => ({
  data: {
    criteria: { schemaVersion: 2, mode: 'matched', clientId: 'client-1', query: '', sources: [], types: [], lifecycle: ['active'], agencies: [], sectors: [], naicsCodes: [], pscCodes: [], setAsideCodes: [], eligibility: [], posted: [], geography: [], applicantTypes: [], funding: [], costShare: [], methods: [], disbursement: [], grantPrerequisites: [], codes: [], deadlineWindow: 'any', deadlineFrom: null, deadlineTo: null, sort: 'deadline', direction: 'asc', page: 1, pageSize: 20 },
    opportunities: [], page: 1, pageSize: 20, total: 0, totalIsCapped: false, catalogComplete: true,
    counts: { grants: 0, contracts: 0, active: 0, closed: 0 }, mode: 'matched', clientId: 'client-1',
    freshness: [{ source: 'grants_gov', state: 'current', recordCount: 1, activeRecordCount: 1, lastSyncedAt: '2026-09-24', latestAttemptAt: '2026-09-24', lastSuccessAt: '2026-09-24' }],
    provenance: [], emptyReason: null, profileGaps: null, generatedAt: '2026-09-24T00:00:00Z', ...overrides,
  },
});

function renderSection(clientId = 'client-1') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { ...render(<QueryClientProvider client={queryClient}><AntApp><FundingOpportunitiesSection clientId={clientId} /></AntApp></QueryClientProvider>), queryClient };
}

beforeEach(() => {
  flags = { enabled: true, ready: true, pipelineEnabled: true };
  apiGetMock.mockReset();
  apiGetMock.mockImplementation((url: string) => {
    if (url.includes('/opportunities/v2/search?')) return Promise.resolve(response());
    if (url.includes('/pipeline')) return Promise.resolve({ data: { clientId: 'client-1', counts: { stages: [{ stage: 'pursuing', count: 3 }] }, cards: [], cardsTruncated: false } });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
});

describe('canonical client funding summary', () => {
  test('renders a persistent card at zero matches with truthful empty copy and date-only freshness', async () => {
    renderSection();
    expect(await screen.findByTestId('funding-opportunities-section')).toBeInTheDocument();
    expect(await screen.findByTestId('fo-client-empty')).toHaveTextContent(/No active opportunities matched/i);
    expect(screen.getByText(/Grants\.gov: current to 24 Sep 2026/)).toBeInTheDocument();
    expect(screen.getByText('Pursuing')).toBeInTheDocument();
  });

  test('preserves unknown totals rather than converting them to zero', async () => {
    apiGetMock.mockImplementation((url: string) => url.includes('/opportunities/v2/search?')
      ? Promise.resolve(response({ total: null, counts: { grants: null, contracts: 2, active: null, closed: null } }))
      : Promise.resolve({ data: { clientId: 'client-1', counts: { stages: [] }, cards: [], cardsTruncated: false } }));
    renderSection();
    expect(await screen.findByText('Active opportunities')).toBeInTheDocument();
    expect(screen.getByTestId('funding-opportunities-section')).toHaveTextContent('—');
  });


  test('uses one canonical client-scoped cache per client, sends all six sources, and does not paint client A on client B', async () => {
    const clientARow = { id: 'grants_gov:a', source: 'grants_gov', sourceRecordId: 'a', title: 'Client A', type: 'grant', deadline: null, value: null, valueBasis: 'not_stated_by_source', agency: null, matchedSignals: [], eligibility: null };
    apiGetMock.mockImplementation((url: string) => url.includes('/opportunities/v2/search?')
      ? Promise.resolve(response({ clientId: 'client-a', total: 1, counts: { grants: 1, contracts: 0, active: 1, closed: 0 }, opportunities: [clientARow] }))
      : Promise.resolve({ data: { clientId: 'client-a', counts: { stages: [{ stage: 'pursuing', count: 3 }] }, cards: [], cardsTruncated: false } }));
    const rendered = renderSection('client-a');
    expect(await screen.findByRole('link', { name: 'Client A' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Client A' })).toBeInTheDocument();
    const firstSearch = apiGetMock.mock.calls.find(([url]) => String(url).includes('/opportunities/v2/search?'))?.[0] as string;
    expect(firstSearch).toContain('clientId=client-a');
    expect(firstSearch).toContain('source=grants_gov%2Csam_gov%2Cagency_forecast%2Cdibbs%2Csbir_sttr%2Cca_portal');
    apiGetMock.mockImplementation((url: string) => url.includes('/opportunities/v2/search?')
      ? Promise.resolve(response({ clientId: 'client-b', total: 1, counts: { grants: 0, contracts: 1, active: 1, closed: 0 }, opportunities: [{ ...clientARow, id: 'sam_gov:b', source: 'sam_gov', sourceRecordId: 'b', title: 'Client B', type: 'contract' }] }))
      : Promise.resolve({ data: { clientId: 'client-b', counts: { stages: [] }, cards: [], cardsTruncated: false } }));
    rendered.rerender(<QueryClientProvider client={rendered.queryClient}><AntApp><FundingOpportunitiesSection clientId="client-b" /></AntApp></QueryClientProvider>);
    expect(await screen.findByRole('link', { name: 'Client B' })).toHaveAttribute('href', '/intelligence/opportunities/sam_gov/b?client=client-b');
    expect(screen.queryByRole('link', { name: 'Client A' })).not.toBeInTheDocument();
    expect(apiGetMock.mock.calls.filter(([url]) => String(url).includes('/opportunities/v2/search?')).length).toBeGreaterThanOrEqual(2);
  });

  test('suppresses retained pipeline totals when only the pipeline flag turns off, then hides cached search when master turns off', async () => {
    const rendered = renderSection('client-1');
    await screen.findByTestId('fo-client-empty');
    expect(screen.getByText('3')).toBeInTheDocument();
    const pipelineCalls = apiGetMock.mock.calls.filter(([url]) => String(url).includes('/pipeline')).length;
    flags = { enabled: true, ready: true, pipelineEnabled: false };
    rendered.rerender(<QueryClientProvider client={rendered.queryClient}><AntApp><FundingOpportunitiesSection clientId="client-1" /></AntApp></QueryClientProvider>);
    expect(screen.getByTestId('funding-opportunities-section')).toBeInTheDocument();
    expect(screen.getByText('Pursuing')).toBeInTheDocument();
    expect(screen.queryByText('3')).not.toBeInTheDocument();
    expect(apiGetMock.mock.calls.filter(([url]) => String(url).includes('/pipeline')).length).toBe(pipelineCalls);
    flags = { enabled: false, ready: true, pipelineEnabled: false };
    rendered.rerender(<QueryClientProvider client={rendered.queryClient}><AntApp><FundingOpportunitiesSection clientId="client-1" /></AntApp></QueryClientProvider>);
    expect(screen.queryByTestId('funding-opportunities-section')).not.toBeInTheDocument();
  });

  test('renders request failure distinctly from empty', async () => {
    apiGetMock.mockRejectedValue(new Error('boom'));
    renderSection();
    expect(await screen.findByTestId('fo-client-error', {}, { timeout: 5000 })).toHaveTextContent(/request failure, not an empty result/i);
    expect(screen.queryByTestId('fo-client-empty')).not.toBeInTheDocument();
  });

  test('does not fetch when the feature is disabled', async () => {
    flags = { enabled: false, ready: true, pipelineEnabled: false };
    renderSection();
    expect(screen.queryByTestId('funding-opportunities-section')).not.toBeInTheDocument();
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  test('uses client-scoped canonical detail links', async () => {
    apiGetMock.mockImplementation((url: string) => url.includes('/opportunities/v2/search?')
      ? Promise.resolve(response({ opportunities: [{ id: 'sam_gov:r1', source: 'sam_gov', sourceRecordId: 'r1', title: 'Contract', type: 'contract', deadline: null, value: null, valueBasis: 'not_stated_by_source', agency: null, matchedSignals: [], eligibility: null }] }))
      : Promise.resolve({ data: { clientId: 'client-1', counts: { stages: [] }, cards: [], cardsTruncated: false } }));
    renderSection();
    expect(await screen.findByRole('link', { name: 'Contract' })).toHaveAttribute('href', '/intelligence/opportunities/sam_gov/r1?client=client-1');
  });
});
