import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FundingOpportunityExplore } from './FundingOpportunityExplore.js';
import { OpportunityClientActions } from './OpportunityClientActions.js';
import { TangoOpportunityDetail } from './TangoOpportunityDetail.js';
import { ForecastOpportunityDetail } from './ForecastOpportunityDetail.js';
import { useUrlState } from '../../../pages/intelligence/opportunities/funding-opportunities-url-state.js';
import {
  decodeOpportunityRef,
  encodeOpportunityRef,
  type ForecastOpportunityRecord,
  type FundingOpportunity,
  type FundingOpportunityListResponse,
  type OpportunityWorkflowStatus,
} from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import type { FundingFeedRecord, FundingFeedResponse } from './opportunity-feeds-api.js';

const { flags, apiGet, apiPost, apiPatch, success, error, urlStore } = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  urlStore: (() => {
    let search = '';
    const listeners = new Set<() => void>();
    return {
      get: () => search,
      set: (next: string) => {
        search = next;
        [...listeners].forEach((listener) => listener());
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  })(),
}));

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGet, post: apiPost, patch: apiPatch }),
}));
vi.mock('../../../lib/intel-feature-flags.js', () => ({
  useIntelFeature: (feature: string) => ({ enabled: flags[feature] === true, ready: true }),
}));
vi.mock('../../components/feedback/toast.js', () => ({
  useCapiroToast: () => ({ success, error }),
}));
vi.mock('react-router-dom', async () => {
  const React = await import('react');
  return {
    useSearchParams: () => {
      const value = React.useSyncExternalStore(urlStore.subscribe, urlStore.get, urlStore.get);
      return [
        new URLSearchParams(value),
        (params: URLSearchParams) => urlStore.set(params.toString()),
      ];
    },
  };
});
// Drawer routing is asserted through its real URL identity. Each detail body and
// its actual action form are exercised independently below, without Meri's graph.
vi.mock('./FundingOpportunityDrawer.js', () => ({
  FundingOpportunityDrawer: ({ refValue }: { refValue: unknown }) =>
    refValue ? <div data-testid="browse-drawer">{JSON.stringify(refValue)}</div> : null,
}));

const NOW = '2026-09-06T00:00:00Z';
function opportunity(status?: OpportunityWorkflowStatus): FundingOpportunity {
  return {
    id: 'notice-1',
    source: 'sam_gov',
    sourceRecordId: 'notice/1',
    sourceReference: 'RFP-1',
    sourceUrl: 'https://sam.gov/opp/notice-1/view',
    kind: 'solicitation',
    kindRaw: null,
    baseKind: null,
    title: 'Aircraft engine maintenance',
    agency: 'Air Force',
    subAgency: null,
    office: null,
    status: 'active',
    postedDate: NOW,
    responseDeadline: '2026-10-12',
    responseDeadlineNote: null,
    closeOrArchiveDate: null,
    isActive: true,
    isPursuable: true,
    summary: 'Maintain aircraft engines.',
    summaryIsLink: false,
    naicsCodes: [],
    pscCodes: [],
    setAside: null,
    setAsideCode: null,
    eligibleApplicantTypes: [],
    assistanceListings: [],
    fundingInstrument: null,
    category: null,
    grantFunding: null,
    contractValue: null,
    placeOfPerformance: null,
    districtKey: null,
    districtBasis: null,
    relevanceScore: 0,
    eligibility: { state: 'unknown', reason: 'No client selected.' },
    matchedSignals: [],
    recommendation: null,
    acquisitionPosition: null,
    decision: null,
    missingProfileFields: [],
    sourceUpdatedAt: NOW,
    clientId: status ? 'client-2' : null,
    workflow: status
      ? {
          id: 'workflow-1',
          status,
          owner: null,
          facility: null,
          notes: null,
          dismissedReason: null,
          outcomeNote: null,
          userCreated: true,
          staleAt: null,
          createdAt: NOW,
          updatedAt: NOW,
        }
      : null,
  };
}
function catalog(rows: FundingOpportunity[] = []): FundingOpportunityListResponse {
  return {
    opportunities: rows,
    total: rows.length,
    totalIsCapped: false,
    page: 1,
    pageSize: 25,
    counts: {
      activeContracts: rows.length,
      activeGrants: 0,
      saved: 0,
      pursuing: 0,
      dismissed: 0,
      deadlinesIn30Days: 0,
    },
    freshness: [],
    emptyReason: rows.length ? null : 'no_results_for_filters',
    emptyExplanation: null,
    missingProfileFields: [],
    generatedAt: NOW,
  };
}
function feedRecord(overrides: Partial<FundingFeedRecord> = {}): FundingFeedRecord {
  return {
    source: 'dibbs',
    sourceRecordId: 'dibbs/1',
    title: 'Aircraft fasteners',
    agency: 'DLA',
    description: 'Fasteners for aircraft maintenance.',
    sourceUrl: 'https://www.dibbs.bsm.dla.mil/rfq/1',
    responseDeadline: '2026-10-12',
    anticipatedAwardDate: null,
    status: 'active',
    isActive: true,
    naicsCode: null,
    lastSyncedAt: NOW,
    sourceUpdatedAt: NOW,
    clientId: null,
    workflow: null,
    decision: null,
    facts: {
      documentType: 'rfq',
      solicitation: 'SPE-1',
      solicitationFormatted: 'SPE-1',
      nsn: null,
      partNumber: null,
      quantity: null,
      unitOfIssue: null,
      setAside: null,
      nomenclature: null,
      buyerCode: null,
      closesDate: '2026-10-12',
      isOpen: true,
      documentUrl: 'https://www.dibbs.bsm.dla.mil/rfq/1',
      techDocsUrl: null,
      lastSyncedAt: NOW,
    },
    ...overrides,
  };
}
function feed(rows: FundingFeedRecord[] = []): FundingFeedResponse {
  return {
    source: 'dibbs',
    clientId: null,
    rows,
    total: rows.length,
    page: 1,
    pageSize: 25,
    hasMore: false,
    generatedAt: NOW,
    freshness: {
      state: 'current',
      lastAttemptAt: NOW,
      lastSuccessAt: NOW,
      lastRunStatus: 'success',
    },
  };
}
function forecast(overrides: Partial<ForecastOpportunityRecord> = {}): ForecastOpportunityRecord {
  return {
    source: 'agency_forecast',
    sourceRecordId: 'forecast/7',
    externalId: 'APFS-7',
    title: 'Future aircraft maintenance',
    description: 'The agency anticipates a maintenance requirement.',
    agency: 'Air Force',
    departmentName: null,
    organizationAgencyName: null,
    officeName: null,
    facts: {
      anticipatedAwardDate: '2027-03-01',
      anticipatedSolicitationDate: null,
      estimatedPeriod: 'FY2027',
      fiscalYear: 2027,
      sourceSystem: 'APFS',
      status: 'planning',
      isActive: true,
      lastSyncedAt: NOW,
      providerModifiedAt: null,
    },
    naicsCode: '488190',
    pscCode: null,
    setAside: null,
    contractVehicle: null,
    placeOfPerformance: null,
    primaryContact: null,
    sourceUrl: null,
    recommendation: null,
    clientId: 'client-2',
    decision: null,
    workflow: null,
    linkedOpportunity: null,
    missingProfileFields: [],
    generatedAt: NOW,
    ...overrides,
  };
}
let catalogResponse: FundingOpportunityListResponse;
let feedResponse: FundingFeedResponse;
let detailResponse: FundingFeedRecord;
let forecastResponse: ForecastOpportunityRecord;

function mount(component: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryDelay: 0, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(<QueryClientProvider client={queryClient}>{component}</QueryClientProvider>);
}
function ActionsFromUrl() {
  const url = useUrlState();
  return (
    <OpportunityClientActions
      source="agency_forecast"
      sourceRecordId="forecast/7"
      clientId={url.get('clientId')}
      title="Future aircraft maintenance"
      isActive
    />
  );
}
function requestParams(prefix: string) {
  const path = apiGet.mock.calls
    .map(([value]) => String(value))
    .find((value) => value.startsWith(prefix));
  expect(path).toBeDefined();
  return new URL(path!, 'https://os.capiro.ai').searchParams;
}
beforeEach(() => {
  vi.resetAllMocks();
  urlStore.set('');
  Object.keys(flags).forEach((key) => delete flags[key]);
  flags.funding_opportunities_forecasts = true;
  flags.funding_opportunities_sbir = true;
  catalogResponse = catalog();
  feedResponse = feed();
  detailResponse = feedRecord();
  forecastResponse = forecast();
  apiPost.mockResolvedValue({ data: {} });
  apiPatch.mockResolvedValue({ data: {} });
  apiGet.mockImplementation(async (path: string) => {
    if (path === '/api/clients')
      return {
        data: [
          { id: 'client-1', name: 'Acme Defense' },
          { id: 'client-2', name: 'Beta Systems' },
          { id: 'archived', name: 'Former Client', status: 'archived' },
        ],
      };
    if (path === '/api/tenant-members')
      return {
        data: [
          { id: '00000000-0000-4000-8000-000000000031', name: 'Jamie', email: 'jamie@example.com' },
        ],
      };
    if (path.includes('/forecasts/')) return { data: forecastResponse };
    if (path.match(/\/feeds\/[^/?]+\//)) return { data: detailResponse };
    if (path.includes('/feeds/')) return { data: feedResponse };
    return { data: catalogResponse };
  });
});
afterEach(cleanup);

describe('Browse source selection and existing shared links', () => {
  test('a new Browse visit requests one federal contract feed', async () => {
    mount(<FundingOpportunityExplore clientId={undefined} />);
    await screen.findByText('No records match this search');
    const params = requestParams('/api/intelligence/opportunities?');
    expect(params.get('source')).toBe('sam_gov');
    expect(params.has('clientId')).toBe(false);
    expect(screen.getByLabelText('Opportunity feed')).toHaveValue('sam_gov');
  });
  test('an old saved combined link preserves both catalogs and its client', async () => {
    urlStore.set('view=explore&tab=saved&clientId=client-2');
    mount(<FundingOpportunityExplore clientId="client-2" />);
    await screen.findByText('No records match this search');
    const params = requestParams('/api/intelligence/opportunities?');
    expect(params.has('source')).toBe(false);
    expect(params.get('workflowStatus')).toBe('saved');
    expect(params.get('activeState')).toBe('all');
    expect(params.get('clientId')).toBe('client-2');
    expect(screen.getByLabelText('Opportunity feed')).toHaveValue('combined');
  });
  test.each([
    ['grants_gov', '/api/intelligence/opportunities?', 'grants_gov'],
    ['agency_forecast', '/api/intelligence/opportunities/feeds/agency_forecast?', null],
    ['dibbs', '/api/intelligence/opportunities/feeds/dibbs?', null],
    ['sbir_sttr', '/api/intelligence/opportunities/feeds/sbir_sttr?', null],
  ] as const)(
    'explicit %s Browse uses its advertised source endpoint',
    async (source, prefix, catalogSource) => {
      urlStore.set(`feed=${source}`);
      mount(<FundingOpportunityExplore clientId="client-2" />);
      await screen.findByText('No records match this search');
      const params = requestParams(prefix);
      expect(params.get('source')).toBe(catalogSource);
      expect(params.get('clientId')).toBe('client-2');
    },
  );
  test('switching to a forecast clears stale contract filters and pagination', async () => {
    urlStore.set(
      'feed=sam_gov&page=7&psc=15&setAside=SBA&kind=solicitation&eligibility=eligible&deadlineFrom=2026-09-01&minRelevance=80&q=engines',
    );
    mount(<FundingOpportunityExplore clientId="client-2" />);
    await screen.findByText('No records match this search');
    fireEvent.change(screen.getByLabelText('Opportunity feed'), {
      target: { value: 'agency_forecast' },
    });
    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('/feeds/agency_forecast?')),
    );
    const params = requestParams('/api/intelligence/opportunities/feeds/agency_forecast?');
    expect(params.get('page')).toBe('1');
    for (const key of [
      'psc',
      'setAside',
      'kind',
      'eligibility',
      'deadlineFrom',
      'minRelevance',
      'q',
    ]) {
      expect(params.has(key)).toBe(false);
      expect(new URLSearchParams(urlStore.get()).has(key)).toBe(false);
    }
  });
  test('a failed feed reports failure and Retry, without claiming there are zero results', async () => {
    urlStore.set('feed=dibbs');
    apiGet.mockRejectedValue({ response: { status: 503 } });
    mount(<FundingOpportunityExplore clientId={undefined} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('This feed could not be loaded');
    expect(screen.queryByText('No records match this search')).not.toBeInTheDocument();
    apiGet.mockResolvedValue({ data: feed() });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No records match this search')).toBeInTheDocument();
  });
  test('unscoped Save opens the selected record for client choice without a write', async () => {
    catalogResponse = catalog([opportunity()]);
    mount(<FundingOpportunityExplore clientId={undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save for a client' }));
    expect(decodeOpportunityRef(new URLSearchParams(urlStore.get()).get('detail'))).toEqual({
      source: 'sam_gov',
      sourceRecordId: 'notice/1',
      clientId: null,
    });
    expect(apiPost).not.toHaveBeenCalled();
  });
  test.each(['saved', 'pursuing', 'won', 'lost', 'dismissed', 'expired'] as const)(
    'Browse does not offer Save over an existing %s state',
    async (status) => {
      catalogResponse = catalog([opportunity(status)]);
      mount(<FundingOpportunityExplore clientId="client-2" />);
      await screen.findByRole('button', { name: 'Aircraft engine maintenance' });
      expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'View details' })).toBeEnabled();
      expect(apiPost).not.toHaveBeenCalled();
    },
  );
});

describe('Client actions keep the selected client and source semantics', () => {
  test('choosing a client updates both the scope and drawer identity before allowing Save', async () => {
    urlStore.set(
      `detail=${encodeURIComponent(encodeOpportunityRef({ source: 'agency_forecast', sourceRecordId: 'forecast/7', clientId: null }))}`,
    );
    mount(<ActionsFromUrl />);
    expect(await screen.findByRole('option', { name: 'Beta Systems' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Former Client' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use this client' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Client'), { target: { value: 'client-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use this client' }));
    const params = new URLSearchParams(urlStore.get());
    expect(params.get('clientId')).toBe('client-2');
    expect(decodeOpportunityRef(params.get('detail'))?.clientId).toBe('client-2');
    expect(apiPost).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        '/api/intelligence/clients/client-2/opportunities/agency_forecast/forecast%2F7/save',
        { status: 'saved' },
      ),
    );
  });
  test('a dated review sends a named next action and an explicit follow-up date', async () => {
    mount(
      <OpportunityClientActions
        source="dibbs"
        sourceRecordId="dibbs/1"
        clientId="client-2"
        title="Aircraft fasteners"
        isActive
        canPursue
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create review task' }));
    const dialog = screen.getByRole('dialog', { name: 'Review opportunity' });
    fireEvent.change(within(dialog).getByLabelText('Next action'), {
      target: { value: 'Confirm manufacturing capacity' },
    });
    fireEvent.change(within(dialog).getByLabelText('Follow-up date (optional)'), {
      target: { value: '2026-09-18' },
    });
    await within(dialog).findByRole('option', { name: 'Jamie' });
    fireEvent.change(within(dialog).getByLabelText('Owner'), {
      target: { value: '00000000-0000-4000-8000-000000000031' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        '/api/intelligence/clients/client-2/opportunities/dibbs/dibbs%2F1/action',
        {
          intent: 'review',
          nextAction: 'Confirm manufacturing capacity',
          nextActionDueAt: '2026-09-18T12:00:00.000Z',
          ownerUserId: '00000000-0000-4000-8000-000000000031',
        },
      ),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
  test('a failed review keeps the entered work and date available for retry', async () => {
    apiPost.mockRejectedValue({ response: { data: { message: 'Owner is no longer available.' } } });
    mount(
      <OpportunityClientActions
        source="sam_gov"
        sourceRecordId="notice/1"
        clientId="client-2"
        title="Aircraft engine maintenance"
        isActive
        canPursue
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create review task' }));
    const dialog = screen.getByRole('dialog', { name: 'Review opportunity' });
    fireEvent.change(within(dialog).getByLabelText('Next action'), {
      target: { value: 'Review team availability' },
    });
    fireEvent.change(within(dialog).getByLabelText('Follow-up date (optional)'), {
      target: { value: '2026-09-18' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(error).toHaveBeenCalledWith('Owner is no longer available.'));
    expect(within(dialog).getByLabelText('Next action')).toHaveValue('Review team availability');
    expect(within(dialog).getByLabelText('Follow-up date (optional)')).toHaveValue('2026-09-18');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(success).not.toHaveBeenCalled();
  });
  test('an active pursuit offers review without Save, Watch, or a second pursuit', () => {
    mount(
      <OpportunityClientActions
        source="sam_gov"
        sourceRecordId="notice-1"
        clientId="client-2"
        title="Aircraft engine maintenance"
        isActive
        canPursue
        workflowStatus="pursuing"
      />,
    );
    expect(screen.getByRole('button', { name: 'Create review task' })).toBeEnabled();
    for (const action of ['Save', 'Watch', 'Pursue']) {
      expect(screen.queryByRole('button', { name: action })).not.toBeInTheDocument();
    }
  });
  test('editing a team action preserves an unchanged timestamp and omitted owner/notes fields', async () => {
    mount(
      <OpportunityClientActions
        source="sam_gov"
        sourceRecordId="notice/1"
        clientId="client-2"
        title="Aircraft engine maintenance"
        isActive
        canPursue
        workflowStatus="pursuing"
        nextAction="Call the program office"
        nextActionDueAt="2026-09-18T08:30:00.000Z"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit team plan' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit team plan' });
    expect(within(dialog).getByLabelText('Next action')).toHaveValue('Call the program office');
    expect(within(dialog).getByLabelText('Follow-up date (optional)')).toHaveValue('2026-09-18');
    fireEvent.change(within(dialog).getByLabelText('Next action'), {
      target: { value: 'Prepare questions for the program office' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith(
        '/api/intelligence/clients/client-2/opportunities/sam_gov/notice%2F1',
        { nextAction: 'Prepare questions for the program office' },
      ),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(apiPost).not.toHaveBeenCalled();
  });
  test('team-plan clearing is explicit and cannot leave a follow-up date without an action', async () => {
    mount(
      <OpportunityClientActions
        source="dibbs"
        sourceRecordId="dibbs/1"
        clientId="client-2"
        title="Aircraft fasteners"
        isActive
        canPursue
        workflowStatus="saved"
        ownerUserId="00000000-0000-4000-8000-000000000031"
        notes="Check existing capacity."
        nextAction="Confirm production capacity"
        nextActionDueAt="2026-09-18T08:30:00.000Z"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit team plan' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit team plan' });
    await within(dialog).findByRole('option', { name: 'Jamie' });
    expect(within(dialog).getByLabelText('Owner')).toHaveValue(
      '00000000-0000-4000-8000-000000000031',
    );
    expect(within(dialog).getByLabelText('Notes')).toHaveValue('Check existing capacity.');
    fireEvent.change(within(dialog).getByLabelText('Next action'), { target: { value: '' } });
    expect(within(dialog).getByLabelText('Follow-up date (optional)')).toHaveValue('');
    fireEvent.change(within(dialog).getByLabelText('Follow-up date (optional)'), {
      target: { value: '2026-09-18' },
    });
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Follow-up date (optional)'), {
      target: { value: '' },
    });
    fireEvent.change(within(dialog).getByLabelText('Owner'), { target: { value: '' } });
    fireEvent.change(within(dialog).getByLabelText('Notes'), { target: { value: '' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith(
        '/api/intelligence/clients/client-2/opportunities/dibbs/dibbs%2F1',
        { nextAction: null, nextActionDueAt: null, ownerUserId: null, notes: null },
      ),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(apiPost).not.toHaveBeenCalled();
  });
  test('a rejected forecast team-plan edit keeps the proposed date for retry', async () => {
    apiPatch.mockRejectedValue({
      response: { data: { message: 'The plan could not be updated.' } },
    });
    mount(
      <OpportunityClientActions
        source="agency_forecast"
        sourceRecordId="forecast/7"
        clientId="client-2"
        title="Future aircraft maintenance"
        isActive
        workflowStatus="saved"
        nextAction="Check for the solicitation"
        nextActionDueAt="2026-09-18T08:30:00.000Z"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit team plan' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit team plan' });
    fireEvent.change(within(dialog).getByLabelText('Follow-up date (optional)'), {
      target: { value: '2026-09-25' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(error).toHaveBeenCalledWith('The plan could not be updated.'));
    expect(apiPatch).toHaveBeenCalledWith(
      '/api/intelligence/clients/client-2/opportunities/agency_forecast/forecast%2F7',
      { nextActionDueAt: '2026-09-25T12:00:00.000Z' },
    );
    expect(within(dialog).getByLabelText('Follow-up date (optional)')).toHaveValue('2026-09-25');
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(success).not.toHaveBeenCalled();
  });
});

describe('Tango and forecast details use real records and actions', () => {
  test('DIBBS source links work before a client is selected', async () => {
    mount(<TangoOpportunityDetail source="dibbs" sourceRecordId="dibbs/1" clientId={null} />);
    expect(await screen.findByRole('link', { name: 'Open the source record ↗' })).toHaveAttribute(
      'href',
      'https://www.dibbs.bsm.dla.mil/rfq/1',
    );
    expect(apiGet).toHaveBeenCalledWith('/api/intelligence/opportunities/feeds/dibbs/dibbs%2F1');
    expect(screen.getByRole('button', { name: 'Use this client' })).toBeDisabled();
    expect(apiPost).not.toHaveBeenCalled();
  });
  test('a rejected detail client scope cannot enable writes against the requested client', async () => {
    detailResponse = feedRecord({ clientId: null });
    mount(<TangoOpportunityDetail source="dibbs" sourceRecordId="dibbs/1" clientId="client-2" />);
    await screen.findByRole('heading', { name: 'Aircraft fasteners' });
    expect(apiGet).toHaveBeenCalledWith(
      '/api/intelligence/opportunities/feeds/dibbs/dibbs%2F1?clientId=client-2',
    );
    expect(screen.getByRole('button', { name: 'Use this client' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
  test('forecast detail labels estimates, has no response deadline or Pursue, and Watch persists monitor', async () => {
    mount(<ForecastOpportunityDetail forecastId="forecast/7" clientId="client-2" />);
    await screen.findByRole('heading', { name: 'Future aircraft maintenance' });
    expect(apiGet).toHaveBeenCalledWith(
      '/api/intelligence/opportunities/forecasts/forecast%2F7?clientId=client-2',
    );
    expect(screen.getByText('Anticipated award (estimate)')).toBeInTheDocument();
    expect(screen.queryByText('Response deadline')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pursue' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Watch' }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        '/api/intelligence/clients/client-2/opportunities/agency_forecast/forecast%2F7/decision',
        { decision: 'monitor' },
      ),
    );
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith('Watching. Find this opportunity in Tracking.'),
    );
  });
  test('a forecast read failure is distinct from a missing source record', async () => {
    apiGet.mockRejectedValue({ response: { status: 503 } });
    mount(<ForecastOpportunityDetail forecastId="forecast/7" clientId="client-2" />);
    expect(await screen.findByText('The agency forecast failed to load')).toBeInTheDocument();
    expect(screen.queryByText('No such agency forecast')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Watch' })).not.toBeInTheDocument();
  });
});
