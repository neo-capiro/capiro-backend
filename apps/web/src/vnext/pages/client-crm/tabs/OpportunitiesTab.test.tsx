import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Client } from '../../../../pages/clients/clientTypes.js';
import { ClientCrmOpportunitiesProto } from './OpportunitiesTab.js';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../../../../lib/use-api.js', () => ({ useApi: () => ({ get: apiGet, post: vi.fn(), patch: vi.fn(), delete: vi.fn() }) }));
vi.mock('../../../../lib/intel-feature-flags.js', () => ({ useIntelFeature: () => ({ enabled: true, ready: true }) }));
vi.mock('../../../components/feedback/toast.js', () => ({ useCapiroToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('../../../../pages/clients/relevance-api.js', () => ({ getRelevantPesForClient: async () => ({ data: [] }), formatScorePct: (score: number) => `${score * 100}%` }));
afterEach(cleanup);

const criteria = { schemaVersion: 2, mode: 'matched', clientId: 'client-1', query: '', sources: [], types: [], lifecycle: ['active'], agencies: [], sectors: [], naicsCodes: [], pscCodes: [], setAsideCodes: [], eligibility: [], posted: [], geography: [], applicantTypes: [], funding: [], costShare: [], methods: [], disbursement: [], grantPrerequisites: [], codes: [], deadlineWindow: 'any', deadlineFrom: null, deadlineTo: null, sort: 'deadline', direction: 'asc', page: 1, pageSize: 20 };
const search = (row: Record<string, unknown> | null = null) => ({ data: { criteria, opportunities: row ? [row] : [], page: 1, pageSize: 20, total: row ? 1 : 0, totalIsCapped: false, catalogComplete: true, counts: { grants: row ? 1 : 0, contracts: 0, active: row ? 1 : 0, closed: 0 }, mode: 'matched', clientId: 'client-1', freshness: [], provenance: [], emptyReason: row ? null : 'no_match', profileGaps: null, generatedAt: '2026-09-24T00:00:00Z' } });
const pipeline = { data: { clientId: 'client-1', counts: { stages: [{ stage: 'reviewing', count: 10 }, { stage: 'pursuing', count: 3 }], unstaged: { suggested: 0, expired: 0, other: 0 }, total: 13, derivedFromWorkflowStatus: 0 }, cards: [], cardsTruncated: false, summary: { inPipeline: 13, deadlinesInside30Days: null, unassigned: null, awaitingAward: null, lastStageChange: null } } };

function mount() {
  apiGet.mockImplementation((url: string) => url.includes('/opportunities/v2/search?') ? Promise.resolve(search({ id: 'grants_gov:r1', source: 'grants_gov', sourceRecordId: 'r1', title: 'Research & Development', type: 'grant', agency: 'NSF', deadline: '2026-09-24', value: null, valueBasis: 'not_stated_by_source', matchedSignals: [], eligibility: null, decoration: null })) : url.includes('/pipeline') ? Promise.resolve(pipeline) : Promise.resolve({ data: [] }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<MemoryRouter><QueryClientProvider client={queryClient}><ClientCrmOpportunitiesProto client={{ id: 'client-1', name: 'County' } as Client} /></QueryClientProvider></MemoryRouter>);
}

describe('client opportunity canonical V2 reader', () => {
  test('renders canonical row, calendar date, and client-scoped detail link', async () => {
    mount();
    expect(await screen.findByRole('link', { name: 'Research & Development' })).toHaveAttribute('href', '/intelligence/opportunities/grants_gov/r1?client=client-1');
    expect(screen.getByText('24 Sep 2026')).toBeInTheDocument();
  });

  test('uses the pursuing stage count rather than the all-stage pipeline aggregate', async () => {
    mount();
    expect(await screen.findByText('3', { selector: '[class*=stat], [class*=value], span' })).toBeInTheDocument();
  });
});
