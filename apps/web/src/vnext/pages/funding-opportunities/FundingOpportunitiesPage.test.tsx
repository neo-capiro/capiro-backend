import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FundingOpportunitiesPage } from './FundingOpportunitiesPage.js';
import type {
  FundingOpportunity,
  FundingOpportunityListResponse,
  InboxResponse,
  InboxRow,
} from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';

/**
 * The vNext Funding Opportunities shell + views, exercised through the page —
 * ported from the canonical FundingOpportunitiesPage.test.tsx and
 * FundingOpportunityInbox.test.tsx (same fixtures, same mock harness, same
 * assertions on endpoints, query params and copy).
 *
 * Structural adaptations from canonical, and nothing else:
 *   - no antd App wrapper;
 *   - the segmented switchers render role="tab" (vNext FovSegmented), where
 *     antd's Segmented rendered role="radio";
 *   - the client / owner / site selects are native selects, driven with
 *     fireEvent.change instead of antd's mouseDown-then-click dance.
 */

const { flags, urlStore } = vi.hoisted(() => ({
  flags: { funding_opportunities: true, funding_opportunities_client_inbox: false } as Record<
    string,
    boolean
  >,
  urlStore: (() => {
    let search = '';
    const listeners = new Set<() => void>();
    return {
      get: () => search,
      set: (next: string) => {
        search = next;
        for (const l of [...listeners]) l();
      },
      subscribe: (l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
  })(),
}));

let flag = { enabled: true, ready: true };
vi.mock('../../../lib/intel-feature-flags.js', () => ({
  useIntelFeature: (feature: string) => ({
    enabled: feature === 'funding_opportunities' ? flag.enabled : flags[feature] === true,
    ready: flag.ready,
  }),
  useIntelFeatureEnabled: (feature: string) =>
    feature === 'funding_opportunities' ? flag.enabled : flags[feature] === true,
}));

const setSearchParamsMock = vi.fn((next: URLSearchParams) => {
  urlStore.set(next.toString() ? `?${next.toString()}` : '');
});
const navigateMock = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async () => {
  const React = await import('react');
  return {
    useSearchParams: () => {
      const search = React.useSyncExternalStore(urlStore.subscribe, urlStore.get, urlStore.get);
      return [new URLSearchParams(search), setSearchParamsMock];
    },
    useNavigate: () => navigateMock,
    Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  };
});

const { apiGetMock, apiPostMock, apiPatchMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
  apiPatchMock: vi.fn(),
}));

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock, post: apiPostMock, patch: apiPatchMock }),
}));

function grant(partial: Partial<FundingOpportunity> = {}): FundingOpportunity {
  return {
    id: 'grants_gov:GRANT-1',
    source: 'grants_gov',
    sourceRecordId: 'GRANT-1',
    sourceReference: 'DE-FOA-0001',
    sourceUrl: 'https://www.grants.gov/x',
    kind: 'grant',
    kindRaw: 'Grant',
    baseKind: null,
    recommendation: null,
    acquisitionPosition: null,
    decision: null,
    title: 'Advanced Manufacturing Research',
    agency: 'Department of Energy',
    subAgency: null,
    office: null,
    status: 'posted',
    postedDate: '2026-06-01T00:00:00.000Z',
    responseDeadline: '2026-12-01T00:00:00.000Z',
    responseDeadlineNote: null,
    closeOrArchiveDate: '2026-12-01T00:00:00.000Z',
    isActive: true,
    isPursuable: true,
    summary: 'Research into advanced manufacturing.',
    summaryIsLink: false,
    naicsCodes: [],
    pscCodes: [],
    setAside: null,
    setAsideCode: null,
    eligibleApplicantTypes: ['Small businesses'],
    assistanceListings: ['81.086'],
    fundingInstrument: 'Grant',
    category: null,
    grantFunding: {
      estimatedProgramFunding: 5_000_000,
      awardFloor: null,
      awardCeiling: 1_000_000,
      expectedAwardCount: 5,
      costSharingRequired: null,
    },
    contractValue: null,
    placeOfPerformance: null,
    districtKey: null,
    districtBasis: null,
    relevanceScore: 54,
    eligibility: { state: 'eligible', reason: 'Client applicant type Small businesses is accepted.' },
    matchedSignals: [
      { signal: 'assistanceListing', strength: 'strong', weight: 40, matchedOn: '81.086' },
    ],
    missingProfileFields: [],
    sourceUpdatedAt: '2026-07-20T00:00:00.000Z',
    workflow: null,
    clientId: 'client-1',
    ...partial,
  };
}

function contract(partial: Partial<FundingOpportunity> = {}): FundingOpportunity {
  return {
    ...grant(),
    id: 'sam_gov:11111111-1111-1111-1111-111111111111',
    source: 'sam_gov',
    sourceRecordId: '11111111-1111-1111-1111-111111111111',
    sourceReference: 'W911-26-R-0001',
    sourceUrl: 'https://sam.gov/opp/N-1/view',
    kind: 'solicitation',
    kindRaw: 'Solicitation',
    baseKind: 'presolicitation',
    title: 'Turbofan Engine Sustainment',
    agency: 'Department of the Army',
    assistanceListings: [],
    eligibleApplicantTypes: [],
    naicsCodes: ['336411'],
    pscCodes: ['1560'],
    grantFunding: null,
    contractValue: { estimatedValue: null, basis: 'not_stated_by_source' },
    eligibility: {
      state: 'unknown',
      reason:
        'This notice records no set-aside in the fields Capiro holds. Contract eligibility also depends on a responsibility determination.',
    },
    matchedSignals: [{ signal: 'naicsExact', strength: 'strong', weight: 30, matchedOn: '336411' }],
    ...partial,
  };
}

function listResponse(
  partial: Partial<FundingOpportunityListResponse> = {},
): FundingOpportunityListResponse {
  return {
    opportunities: [grant(), contract()],
    total: 2,
    totalIsCapped: false,
    page: 1,
    pageSize: 25,
    counts: {
      activeGrants: 1,
      activeContracts: 1,
      saved: 0,
      pursuing: 0,
      dismissed: 0,
      deadlinesIn30Days: 0,
    },
    freshness: [
      {
        source: 'grants_gov',
        verb: 'sync-grants',
        label: 'Grants.gov opportunities',
        lastSyncedAt: '2026-07-28T00:00:00.000Z',
        lastAttemptAt: '2026-07-28T00:00:00.000Z',
        lastRunStatus: 'success',
        lastRunErrorCount: 0,
        lastFailureAt: null,
        hoursSinceLastSuccess: 12,
        neverSynced: false,
        lastRunDegraded: false,
        countsUnavailable: false,
        recordCount: 800,
        activeRecordCount: 120,
        enrichment: {
          lastAttemptAt: '2026-07-28T02:00:00.000Z',
          lastSuccessAt: '2026-07-28T02:00:00.000Z',
          degraded: false,
          detailedRecordCount: 700,
          activeAwaitingEnrichment: 0,
        },
      },
      {
        source: 'sam_gov',
        verb: 'sync-sam-opportunities',
        label: 'SAM.gov contract opportunities',
        lastSyncedAt: '2026-07-27T00:00:00.000Z',
        lastAttemptAt: '2026-07-27T00:00:00.000Z',
        lastRunStatus: 'success',
        lastRunErrorCount: 0,
        lastFailureAt: null,
        hoursSinceLastSuccess: 36,
        neverSynced: false,
        lastRunDegraded: false,
        countsUnavailable: false,
        recordCount: 4000,
        activeRecordCount: 900,
        enrichment: null,
      },
    ],
    emptyReason: null,
    emptyExplanation: null,
    missingProfileFields: [],
    generatedAt: '2026-07-28T12:00:00.000Z',
    ...partial,
  };
}

const ZERO_COUNTS = {
  needs_review: 0,
  pursuing: 0,
  deadlines: 0,
  recently_changed: 0,
  monitoring: 0,
  passed: 0,
};

function inboxRow(partial: Partial<InboxRow> = {}): InboxRow {
  return {
    id: 'wf-0001',
    client: { id: 'client-1', name: 'Acme Defense' },
    source: 'sam_gov',
    sourceRecordId: '11111111-1111-1111-1111-111111111111',
    title: 'Turbofan Engine Sustainment',
    agency: 'Department of the Army',
    forecast: null,
    dibbs: null,
    sbir: null,
    responseDeadline: new Date(Date.now() + 9 * 86_400_000).toISOString(),
    daysUntilDeadline: 9,
    workflowStatus: 'suggested',
    humanDecision: null,
    nextAction: null,
    nextActionDueAt: null,
    owner: null,
    relevanceScore: 62,
    eligibility: { state: 'needs_review', reason: 'Set-aside not evaluated.' },
    noLongerSuggested: false,
    sourceClosed: false,
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...partial,
  };
}

function emptyInbox(partial: Partial<InboxResponse> = {}): InboxResponse {
  return {
    filter: 'needs_review',
    clientId: null,
    source: null,
    rows: [],
    nextCursor: null,
    pageSize: 50,
    counts: { ...ZERO_COUNTS },
    countsAllClients: null,
    countsUnavailableReason: null,
    generatedAt: '2026-07-28T12:00:00.000Z',
    ...partial,
  };
}

let inboxUrls: string[] = [];

function mockApi(list: FundingOpportunityListResponse | Error, inbox?: InboxResponse | Error) {
  apiGetMock.mockImplementation(async (url: string) => {
    if (url === '/api/tenant-members') {
      return { data: [{ id: 'user-1', name: 'Ada Byron', email: 'ada@example.com' }] };
    }
    if (url === '/api/clients/client-1/facilities') {
      return { data: [{ id: 'facility-1', name: 'El Paso Plant', city: 'El Paso', state: 'TX' }] };
    }
    if (url.startsWith('/api/clients')) {
      return {
        data: [
          { id: 'client-1', name: 'Acme Defense', status: 'active' },
          { id: 'client-2', name: 'Beta Systems', status: 'active' },
        ],
      };
    }
    // BEFORE the catalog branch: the inbox path is a prefix match away from the
    // catalog one.
    if (url.startsWith('/api/intelligence/opportunities/inbox')) {
      inboxUrls.push(url);
      const response = inbox ?? emptyInbox();
      if (response instanceof Error) throw response;
      return { data: response };
    }
    if (url.startsWith('/api/intelligence/opportunities')) {
      if (list instanceof Error) throw list;
      return { data: list };
    }
    return { data: {} };
  });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <FundingOpportunitiesPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  apiPatchMock.mockReset();
  apiPostMock.mockResolvedValue({ data: {} });
  apiPatchMock.mockResolvedValue({ data: {} });
  setSearchParamsMock.mockClear();
  navigateMock.mockClear();
  flag = { enabled: true, ready: true };
  flags.funding_opportunities_client_inbox = false;
  flags.funding_opportunities_forecasts = false;
  flags.funding_opportunities_sbir = false;
  flags.funding_opportunities_pipeline_v2 = false;
  inboxUrls = [];
  urlStore.set('?clientId=client-1');
});

describe('feature gating', () => {
  test('an un-flagged tenant sees an availability message, not a broken page', async () => {
    flag = { enabled: false, ready: true };
    mockApi(listResponse());
    renderPage();
    expect(
      await screen.findByText(/Funding Opportunities is not enabled for this workspace/i),
    ).toBeInTheDocument();
  });

  test('nothing is fetched while the flag is still resolving', () => {
    flag = { enabled: false, ready: false };
    mockApi(listResponse());
    renderPage();
    expect(apiGetMock).not.toHaveBeenCalled();
  });
});

describe('header and honest framing', () => {
  test('the header states that these are future pursuits, not awarded funding', async () => {
    mockApi(listResponse());
    renderPage();
    expect(await screen.findByText(/Funding Opportunities/)).toBeInTheDocument();
    expect(screen.getByText(/future competitions, not awarded funding/i)).toBeInTheDocument();
  });

  test('source freshness is shown per rail', async () => {
    mockApi(listResponse());
    renderPage();
    expect(await screen.findByText(/Grants\.gov opportunities: current to/i)).toBeInTheDocument();
    expect(screen.getByText(/SAM\.gov contract opportunities: current to/i)).toBeInTheDocument();
  });

  test('a never-synced rail says so explicitly', async () => {
    const r = listResponse();
    r.freshness[1]!.neverSynced = true;
    r.freshness[1]!.lastSyncedAt = null;
    mockApi(r);
    renderPage();
    expect(
      await screen.findByText(/SAM\.gov contract opportunities: never synced/i),
    ).toBeInTheDocument();
  });
});

describe('KPI strip', () => {
  test('grants and contracts are counted SEPARATELY', async () => {
    mockApi(listResponse());
    renderPage();
    expect(await screen.findByText('Active grants')).toBeInTheDocument();
    expect(screen.getByText('Active contract opportunities')).toBeInTheDocument();
  });

  test('there is NO blended dollar total anywhere in the KPI strip', async () => {
    mockApi(listResponse());
    renderPage();
    const kpis = await screen.findByTestId('fo-kpis');
    expect(kpis.textContent ?? '').not.toContain('$');
    expect((kpis.textContent ?? '').toLowerCase()).not.toContain('total value');
  });
});

describe('grant versus contract labels, and null money', () => {
  test('a grant shows an award CEILING, labelled as such', async () => {
    mockApi(listResponse({ opportunities: [grant()] }));
    renderPage();
    expect(await screen.findByText('Award ceiling')).toBeInTheDocument();
    expect(screen.getByText('$1.0M')).toBeInTheDocument();
  });

  test('a SAM notice with no stated value renders "Not stated", never $0', async () => {
    mockApi(listResponse({ opportunities: [contract()] }));
    renderPage();
    expect(await screen.findByText('Contract value')).toBeInTheDocument();
    expect(screen.getByText('Not stated')).toBeInTheDocument();
    const card = screen.getByTestId('fo-card-sam_gov:11111111-1111-1111-1111-111111111111');
    expect(card.textContent ?? '').not.toContain('$0');
  });
});

describe('relevance and eligibility are shown separately', () => {
  test('fit and eligibility appear as two separate facts', async () => {
    mockApi(listResponse({ opportunities: [grant()] }));
    renderPage();
    const card = await screen.findByTestId('fo-card-grants_gov:GRANT-1');
    expect(card).toHaveTextContent('Fit');
    expect(card).toHaveTextContent('Strong fit');
    expect(card).toHaveTextContent('Eligibility');
    expect(card).toHaveTextContent('Eligible');
    expect(card).toHaveTextContent(/relevance 54/);
  });

  test('the matched value is shown, under a human label rather than a machine key', async () => {
    mockApi(listResponse({ opportunities: [grant()] }));
    renderPage();
    const card = await screen.findByTestId('fo-card-grants_gov:GRANT-1');
    // Label and matched value are two lines (a stacked "strongest reason"
    // block, not one joined string), so assert both independently.
    expect(card).toHaveTextContent('Prior award under this Assistance Listing');
    expect(card).toHaveTextContent(/matched on\s*"?81\.086"?/);
    expect(screen.queryByText(/assistanceListing:/)).not.toBeInTheDocument();
  });
});

describe('deadlines', () => {
  test('a deadline renders as a date with days remaining', async () => {
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString();
    mockApi(listResponse({ opportunities: [grant({ responseDeadline: soon })] }));
    renderPage();
    expect(await screen.findByText(/\(10d\)/)).toBeInTheDocument();
  });

  test('a null deadline with a note shows the NOTE, not a blank', async () => {
    mockApi(
      listResponse({
        opportunities: [grant({ responseDeadline: null, responseDeadlineNote: 'Continuous' })],
      }),
    );
    renderPage();
    expect(await screen.findByText('Continuous')).toBeInTheDocument();
  });
});

describe('honest states', () => {
  test('a FAILED request renders an error, never an empty list', async () => {
    mockApi(new Error('boom'));
    renderPage();
    const err = await screen.findByTestId('fo-error', {}, { timeout: 8000 });
    expect(err.textContent).toMatch(/request failure, not an empty result/i);
    expect(screen.queryByTestId('fo-empty')).not.toBeInTheDocument();
  });

  test('an empty result explains WHY, using the API reason', async () => {
    mockApi(
      listResponse({
        opportunities: [],
        total: 0,
        emptyReason: 'source_never_synced',
        emptyExplanation: 'This source has never completed a successful sync.',
      }),
    );
    renderPage();
    const empty = await screen.findByTestId('fo-empty');
    expect(empty.textContent).toMatch(/never completed a successful sync/i);
  });

  test('an empty result lists the profile gaps that would fix it', async () => {
    mockApi(
      listResponse({
        opportunities: [],
        total: 0,
        emptyReason: 'client_profile_too_thin',
        emptyExplanation: 'This client has nothing any matching signal reads.',
        missingProfileFields: [
          {
            field: 'naicsCodes',
            label: 'NAICS codes',
            impact: 'NAICS is the strongest contract-matching signal.',
            href: '/clients?client=client-1',
          },
        ],
      }),
    );
    renderPage();
    const empty = await screen.findByTestId('fo-empty');
    expect(empty.textContent).toMatch(/NAICS codes/);
    expect(empty.textContent).toMatch(/strongest contract-matching signal/);
  });

  test('with no client selected, the page says scores are not shown', async () => {
    urlStore.set('');
    mockApi(listResponse());
    renderPage();
    expect(await screen.findByTestId('fo-no-client')).toBeInTheDocument();
  });
});

describe('workflow actions', () => {
  test('save posts to the save route for the right source and record', async () => {
    mockApi(listResponse({ opportunities: [contract()] }));
    apiPostMock.mockResolvedValue({ data: {} });
    renderPage();
    const saveButton = await screen.findByRole('button', { name: /^Save$/ });
    saveButton.click();
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith(
        '/api/intelligence/clients/client-1/opportunities/sam_gov/11111111-1111-1111-1111-111111111111/save',
        { status: 'saved' },
      ),
    );
  });

  test('pursue posts status pursuing', async () => {
    mockApi(listResponse({ opportunities: [contract()] }));
    apiPostMock.mockResolvedValue({ data: {} });
    renderPage();
    (await screen.findByRole('button', { name: /^Pursue$/ })).click();
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith(expect.stringContaining('/save'), {
        status: 'pursuing',
      }),
    );
  });

  test('dismiss posts to the dismiss route', async () => {
    mockApi(listResponse({ opportunities: [contract()] }));
    apiPostMock.mockResolvedValue({ data: {} });
    renderPage();
    (await screen.findByRole('button', { name: /^Dismiss$/ })).click();
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith(expect.stringContaining('/dismiss'), {}),
    );
  });

  test('a dismissed opportunity offers Restore instead of Save/Pursue', async () => {
    mockApi(
      listResponse({
        opportunities: [
          contract({
            workflow: {
              id: 'wf-1',
              status: 'dismissed',
              owner: null,
              facility: null,
              notes: null,
              dismissedReason: 'Wrong NAICS',
              outcomeNote: null,
              userCreated: true,
              staleAt: null,
              createdAt: '2026-07-01T00:00:00.000Z',
              updatedAt: '2026-07-02T00:00:00.000Z',
            },
          }),
        ],
      }),
    );
    apiPostMock.mockResolvedValue({ data: {} });
    renderPage();
    expect(await screen.findByRole('button', { name: /Restore/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Pursue$/ })).not.toBeInTheDocument();
  });

  test('with no client selected, workflow buttons are disabled with an explanation', async () => {
    urlStore.set('');
    mockApi(listResponse({ opportunities: [contract()] }));
    renderPage();
    const save = await screen.findByRole('button', { name: /^Save$/ });
    expect(save).toBeDisabled();
    expect(screen.getByText(/Select a client to save or pursue/i)).toBeInTheDocument();
  });

  test('Ask Meri navigates to the vNext workspace with a client-scoped assessment prompt', async () => {
    // vNext's Meri is a dedicated route (VNextApp) that bypasses AppShellUui
    // entirely — the legacy chat-drawer event bus (requestMeriContextPrompt /
    // MeriOverlay) is never mounted here, so this must navigate, not dispatch.
    mockApi(listResponse({ opportunities: [contract()] }));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Ask Meri/ }));
    expect(navigateMock).toHaveBeenCalledWith(expect.stringMatching(/^\/meri\/new\?/));
    const url = navigateMock.mock.calls.at(-1)?.[0] as string;
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('meriClient')).toBe('client-1');
    expect(params.get('meriPrompt')).toContain('W911-26-R-0001');
  });

  test('assign owner opens a real modal and patches the workflow', async () => {
    mockApi(listResponse({ opportunities: [contract()] }));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /More actions for Turbofan/i }));
    fireEvent.click(await screen.findByText('Assign owner'));
    expect(await screen.findByText('Assign opportunity owner')).toBeInTheDocument();
    fireEvent.change(await screen.findByRole('combobox', { name: 'Opportunity owner' }), {
      target: { value: 'user-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() =>
      expect(apiPatchMock).toHaveBeenCalledWith(expect.stringContaining('/opportunities/sam_gov/'), {
        ownerUserId: 'user-1',
      }),
    );
  });

  test('add note persists the note through the workflow PATCH', async () => {
    mockApi(listResponse({ opportunities: [contract()] }));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /More actions for Turbofan/i }));
    fireEvent.click(await screen.findByText('Add note'));
    fireEvent.change(await screen.findByLabelText('Opportunity note'), {
      target: { value: 'Coordinate capture review.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() =>
      expect(apiPatchMock).toHaveBeenCalledWith(expect.stringContaining('/opportunities/sam_gov/'), {
        notes: 'Coordinate capture review.',
      }),
    );
  });

  test('link project site patches a client-owned facility', async () => {
    mockApi(listResponse({ opportunities: [contract()] }));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /More actions for Turbofan/i }));
    fireEvent.click(await screen.findByText('Link project site'));
    fireEvent.change(await screen.findByRole('combobox', { name: 'Project site' }), {
      target: { value: 'facility-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() =>
      expect(apiPatchMock).toHaveBeenCalledWith(expect.stringContaining('/opportunities/sam_gov/'), {
        facilityId: 'facility-1',
      }),
    );
  });

  test('create task goes through the ATOMIC action, not the raw task route', async () => {
    mockApi(listResponse({ opportunities: [contract()] }));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /More actions for Turbofan/i }));
    fireEvent.click(await screen.findByText('Create task'));
    fireEvent.change(await screen.findByLabelText('Task context'), {
      target: { value: 'Prepare bid/no-bid review.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(apiPostMock).toHaveBeenCalled());

    const [url, body] = apiPostMock.mock.calls[0]!;
    expect(String(url)).not.toContain('/api/engagement/tasks');
    expect(String(url)).toMatch(/\/opportunities\/sam_gov\/[^/]+\/action$/);
    expect(body).not.toHaveProperty('title');
    expect(body).not.toHaveProperty('dueDate');
    expect(body).toMatchObject({ notes: 'Prepare bid/no-bid review.' });
    expect(['review', 'pursuit']).toContain((body as { intent: string }).intent);
  });
});

describe('filters and URL state', () => {
  test('the request carries the client and the active-state filter', async () => {
    mockApi(listResponse());
    renderPage();
    await waitFor(() =>
      expect(apiGetMock).toHaveBeenCalledWith(expect.stringContaining('clientId=client-1')),
    );
    expect(apiGetMock).toHaveBeenCalledWith(expect.stringContaining('activeState=active'));
  });

  test.each(['Saved', 'Pursuing'])('%s includes closed workflow history', async (tabLabel) => {
    mockApi(listResponse());
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: tabLabel }));
    await waitFor(() =>
      expect(apiGetMock).toHaveBeenCalledWith(expect.stringContaining('activeState=all')),
    );
  });

  test('every filter control has an accessible name', async () => {
    mockApi(listResponse());
    renderPage();
    await screen.findByTestId('fo-kpis');
    for (const label of [
      'Client',
      'Search opportunities',
      'Agency',
      'NAICS code',
      'PSC code',
      'Set-aside',
      'Notice type',
      'Eligibility',
      'Minimum relevance',
    ]) {
      expect(screen.getAllByLabelText(label, { exact: false }).length).toBeGreaterThan(0);
    }
  });

  test('the explore tab is restored from the URL', async () => {
    urlStore.set('?clientId=client-1&tab=pursuing');
    mockApi(listResponse());
    renderPage();
    await waitFor(() =>
      expect(apiGetMock).toHaveBeenCalledWith(expect.stringContaining('workflowStatus=pursuing')),
    );
  });

  test('clicking a tab writes it to the URL, so a refresh lands on the same tab', async () => {
    mockApi(listResponse());
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: 'Dismissed' }));
    await waitFor(() => expect(urlStore.get()).toContain('tab=dismissed'));
    apiGetMock.mockClear();
    cleanup();
    mockApi(listResponse());
    renderPage();
    await waitFor(() =>
      expect(apiGetMock).toHaveBeenCalledWith(expect.stringContaining('workflowStatus=dismissed')),
    );
  });

  test('filters are restored from the URL', async () => {
    urlStore.set('?clientId=client-1&naics=336411&minRelevance=40');
    mockApi(listResponse());
    renderPage();
    await waitFor(() =>
      expect(apiGetMock).toHaveBeenCalledWith(expect.stringContaining('naics=336411')),
    );
    expect(apiGetMock).toHaveBeenCalledWith(expect.stringContaining('minRelevance=40'));
  });

  test('changing a filter resets to page 1 rather than stranding the reader', async () => {
    urlStore.set('?clientId=client-1&page=7');
    mockApi(listResponse({ total: 500 }));
    renderPage();
    fireEvent.change(await screen.findByLabelText('NAICS code'), { target: { value: '541330' } });
    await waitFor(() => expect(urlStore.get()).toContain('naics=541330'));
    expect(urlStore.get()).not.toContain('page=7');
  });

  test('selecting a client drops a stale cursor and page from the previous result set', async () => {
    urlStore.set('?clientId=client-1&page=4&cursor=abc');
    mockApi(listResponse({ total: 500 }));
    renderPage();
    await screen.findByRole('option', { name: 'Beta Systems' });
    fireEvent.change(screen.getByLabelText('Client'), { target: { value: 'client-2' } });
    await waitFor(() => expect(urlStore.get()).toContain('clientId=client-2'));
    expect(urlStore.get()).not.toContain('cursor=abc');
    expect(urlStore.get()).not.toContain('page=4');
  });
});

describe('pagination', () => {
  test('a capped total says so rather than implying it is the whole universe', async () => {
    mockApi(listResponse({ total: 2400, totalIsCapped: true }));
    renderPage();
    expect(await screen.findByText(/scan bound reached/i)).toBeInTheDocument();
  });
});

describe('informational and closed notices never offer a pursuit', () => {
  const awardNotice = () =>
    contract({
      kind: 'award_notice',
      kindRaw: 'Award Notice',
      baseKind: null,
      isPursuable: false,
      title: 'Award Notice: Turbofan Engine Sustainment',
    });

  test('an award notice offers Save but NOT Pursue', async () => {
    mockApi(listResponse({ opportunities: [awardNotice()] }));
    renderPage();
    expect(await screen.findByRole('button', { name: /^Save$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Pursue$/ })).not.toBeInTheDocument();
  });

  test('an award notice does not offer Create task', async () => {
    mockApi(listResponse({ opportunities: [awardNotice()] }));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /More actions for Award Notice/i }));
    expect(await screen.findByText('Assign owner')).toBeInTheDocument();
    expect(screen.queryByText('Create task')).not.toBeInTheDocument();
  });

  test('the card explains why pursuit is unavailable', async () => {
    mockApi(listResponse({ opportunities: [awardNotice()] }));
    renderPage();
    expect(
      await screen.findByText(/informational, so it can be saved for reference but not pursued/i),
    ).toBeInTheDocument();
  });

  test('a CLOSED but pursuable notice also hides Pursue, with a different reason', async () => {
    mockApi(
      listResponse({
        opportunities: [contract({ isActive: false, isPursuable: true })],
      }),
    );
    renderPage();
    expect(await screen.findByRole('button', { name: /^Save$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Pursue$/ })).not.toBeInTheDocument();
    expect(
      screen.getByText(/closed, so it can be saved for reference but not pursued/i),
    ).toBeInTheDocument();
  });

  test('an open, pursuable notice still offers Pursue', async () => {
    mockApi(listResponse({ opportunities: [contract()] }));
    renderPage();
    expect(await screen.findByRole('button', { name: /^Pursue$/ })).toBeInTheDocument();
  });
});

// ── P11: the shell, the flag, and URL-restorable state ──────────────────────

describe('the inbox flag decides whether the inbox is reachable at all', () => {
  test('with the flag off there is no view switcher and no inbox request at all', async () => {
    mockApi(listResponse());
    renderPage();
    await screen.findByTestId('fo-kpis');
    expect(screen.queryByLabelText('Funding Opportunities view')).not.toBeInTheDocument();
    for (const [url] of apiGetMock.mock.calls) {
      expect(String(url)).not.toContain('/opportunities/inbox');
    }
  });

  test('with the flag off the raw catalog is still what renders', async () => {
    mockApi(listResponse());
    renderPage();
    expect(await screen.findByTestId('fo-explore')).toBeInTheDocument();
    expect(screen.queryByTestId('fo-inbox')).not.toBeInTheDocument();
  });

  test('with the flag ON, explore is still the landing view, but the inbox is reachable via the switcher', async () => {
    flags.funding_opportunities_client_inbox = true;
    mockApi(listResponse(), emptyInbox());
    renderPage();
    expect(await screen.findByTestId('fo-explore')).toBeInTheDocument();
    expect(screen.getByLabelText('Funding Opportunities view')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Triage inbox' }));
    expect(await screen.findByTestId('fo-inbox')).toBeInTheDocument();
    expect(screen.queryByTestId('fo-kpis')).not.toBeInTheDocument();
  });

  test('the catalog is still reachable, as Explore federal opportunities', async () => {
    flags.funding_opportunities_client_inbox = true;
    mockApi(listResponse(), emptyInbox());
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: /Explore federal opportunities/ }));
    expect(await screen.findByTestId('fo-explore')).toBeInTheDocument();
  });

  test('a ?view=explore deep link opens the catalog even with the inbox enabled', async () => {
    flags.funding_opportunities_client_inbox = true;
    urlStore.set('?clientId=client-1&view=explore');
    mockApi(listResponse(), emptyInbox());
    renderPage();
    expect(await screen.findByTestId('fo-explore')).toBeInTheDocument();
  });

  test('a stale ?view=inbox link falls back to the catalog once the flag is off again', async () => {
    urlStore.set('?clientId=client-1&view=inbox');
    mockApi(listResponse());
    renderPage();
    expect(await screen.findByTestId('fo-explore')).toBeInTheDocument();
  });

  test('an un-flagged tenant sees the availability message regardless of the inbox flag', async () => {
    flag = { enabled: false, ready: true };
    flags.funding_opportunities_client_inbox = true;
    mockApi(listResponse(), emptyInbox());
    renderPage();
    expect(
      await screen.findByText(/Funding Opportunities is not enabled for this workspace/i),
    ).toBeInTheDocument();
  });
});

// ── The triage inbox, exercised through the page (canonical inbox suite subset) ──

describe('Explore federal opportunities is the default view', () => {
  test('with no view param at all, the page lands on Explore, not the inbox', async () => {
    flags.funding_opportunities_client_inbox = true;
    urlStore.set('?clientId=client-1');
    mockApi(listResponse());
    renderPage();
    expect(await screen.findByRole('tab', { name: /Explore federal opportunities/, selected: true })).toBeInTheDocument();
    expect(screen.queryByTestId('fo-inbox')).toBeNull();
  });
});

describe('the inbox is client-first', () => {
  beforeEach(() => {
    flags.funding_opportunities_client_inbox = true;
    // Explore federal opportunities is now the page's default view — the
    // inbox is reached via ?view=inbox, no longer via an absent param.
    urlStore.set('?view=inbox');
  });

  test('it lands on needs_review without being asked', async () => {
    mockApi(listResponse(), emptyInbox({ rows: [inboxRow()], counts: { ...ZERO_COUNTS, needs_review: 1 } }));
    renderPage();
    await screen.findByTestId('fo-inbox');
    await waitFor(() => expect(inboxUrls.length).toBeGreaterThan(0));
    expect(inboxUrls[0]).toContain('filter=needs_review');
  });

  test('EVERY row names its client', async () => {
    mockApi(
      listResponse(),
      emptyInbox({
        rows: [
          inboxRow(),
          inboxRow({ id: 'wf-0002', client: { id: 'client-2', name: 'Beta Systems' } }),
        ],
        counts: { ...ZERO_COUNTS, needs_review: 2 },
      }),
    );
    renderPage();
    expect(
      await screen.findByRole('button', { name: /Show only Acme Defense/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Show only Beta Systems/ })).toBeInTheDocument();
  });

  test('an unevaluated eligibility says "Not evaluated", never a blank and never Eligible', async () => {
    mockApi(
      listResponse(),
      emptyInbox({
        rows: [inboxRow({ eligibility: { state: null, reason: null } })],
        counts: { ...ZERO_COUNTS, needs_review: 1 },
      }),
    );
    renderPage();
    const row = await screen.findByTestId('fo-inbox-row-wf-0001');
    expect(row).toHaveTextContent('Not evaluated');
    expect(row).not.toHaveTextContent('Eligible');
  });

  test('changing the queue writes it to the URL and re-requests', async () => {
    mockApi(listResponse(), emptyInbox({ rows: [inboxRow()], counts: { ...ZERO_COUNTS, needs_review: 1 } }));
    renderPage();
    fireEvent.click(await screen.findByRole('tab', { name: /Deadlines/ }));
    await waitFor(() => expect(urlStore.get()).toContain('filter=deadlines'));
    await waitFor(() => expect(inboxUrls.some((u) => u.includes('filter=deadlines'))).toBe(true));
  });

  test('an unknown queue in the URL falls back to needs_review rather than 400ing', async () => {
    urlStore.set('?view=inbox&filter=urgent');
    mockApi(listResponse(), emptyInbox());
    renderPage();
    await waitFor(() => expect(inboxUrls.length).toBeGreaterThan(0));
    expect(inboxUrls[0]).toContain('filter=needs_review');
  });

  test('nothing anywhere is reported as "no decisions exist yet", not "no opportunities"', async () => {
    mockApi(listResponse(), emptyInbox());
    renderPage();
    const empty = await screen.findByTestId('fo-inbox-empty');
    expect(empty.textContent).toMatch(/No client-opportunity decisions exist yet/);
    expect(empty.textContent).toMatch(/not a statement that no relevant opportunities exist/i);
  });

  test('an empty queue beside a full one offers the full one', async () => {
    mockApi(
      listResponse(),
      emptyInbox({ counts: { ...ZERO_COUNTS, pursuing: 3 } }),
    );
    renderPage();
    const empty = await screen.findByTestId('fo-inbox-empty');
    expect(empty.textContent).toMatch(/Other queues do have work waiting/i);
    expect(screen.getByRole('button', { name: /Pursuing \(3\)/ })).toBeInTheDocument();
  });

  test('a failed request renders an explicit error with a retry', async () => {
    mockApi(listResponse(), new Error('boom'));
    renderPage();
    const err = await screen.findByTestId('fo-inbox-error', {}, { timeout: 8000 });
    expect(err.textContent).toMatch(/request failure, not an empty inbox/i);
  });

  test('clicking a row title writes the ref to the URL, carrying the ROW’s client', async () => {
    mockApi(
      listResponse(),
      emptyInbox({
        rows: [inboxRow({ client: { id: 'client-9', name: 'Ninth Client' } })],
        counts: { ...ZERO_COUNTS, needs_review: 1 },
      }),
    );
    renderPage();
    fireEvent.click(
      await screen.findByRole('button', { name: /Open detail for Turbofan Engine Sustainment/ }),
    );
    await waitFor(() => expect(urlStore.get()).toContain('detail='));
    const detail = new URLSearchParams(urlStore.get()).get('detail')!;
    expect(decodeURIComponent(detail)).toContain('client-9');
  });

  test('with the forecast flag OFF a forecast row is withheld, and the page SAYS how many', async () => {
    flags.funding_opportunities_forecasts = false;
    mockApi(
      listResponse(),
      emptyInbox({
        rows: [
          inboxRow({
            id: 'wf-f1',
            source: 'agency_forecast',
            sourceRecordId: 'FCST-1',
            responseDeadline: null,
            daysUntilDeadline: null,
            forecast: {
              anticipatedAwardDate: '2027-03-01',
              anticipatedSolicitationDate: null,
              estimatedPeriod: null,
              fiscalYear: 2027,
              sourceSystem: 'APFS',
              status: null,
              isActive: true,
              lastSyncedAt: '2026-08-06T02:00:00.000Z',
              providerModifiedAt: null,
            },
          }),
        ],
        counts: { ...ZERO_COUNTS, needs_review: 1 },
      }),
    );
    renderPage();
    const notice = await screen.findByTestId('fo-inbox-forecasts-withheld');
    expect(notice.textContent).toMatch(/1 agency forecast row not shown/);
    expect(screen.queryByTestId('fo-forecast-row-wf-f1')).not.toBeInTheDocument();
  });
});
