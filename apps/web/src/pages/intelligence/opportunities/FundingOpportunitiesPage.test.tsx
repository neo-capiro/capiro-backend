import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { FundingOpportunitiesPage } from './FundingOpportunitiesPage.js';
import type {
  FundingOpportunity,
  FundingOpportunityListResponse,
} from './funding-opportunities-api.js';

/**
 * Mocks `useSearchParams` directly rather than wrapping in a MemoryRouter (repo
 * precedent: Bill360Page.test.tsx, DistrictNexusPage.test.tsx).
 */
let flag = { enabled: true, ready: true };
vi.mock('../../../lib/intel-feature-flags.js', () => ({
  useIntelFeature: () => flag,
  useIntelFeatureEnabled: () => flag.enabled,
}));

let search = '';
const setSearchParamsMock = vi.fn((next: URLSearchParams) => {
  search = `?${next.toString()}`;
});
vi.mock('react-router-dom', () => ({
  useSearchParams: () => [new URLSearchParams(search), setSearchParamsMock],
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

/**
 * `vi.hoisted`, not a bare `const`.
 *
 * `vi.mock` calls are hoisted above every declaration in this file, but their
 * FACTORIES run lazily, at the moment the mocked module is first resolved. That
 * resolution is triggered by the static `import { FundingOpportunitiesPage }`
 * above — which happens before the module body executes — so a factory closing
 * over a plain `const` reads it while it is still in its temporal dead zone and
 * the whole suite dies at collection with "Cannot access X before
 * initialization". This file has been failing on main for exactly that reason,
 * which is why the suite reported `(0 test)` rather than a failing assertion:
 * nothing in it has ever run.
 *
 * `vi.hoisted` moves the initialization INTO the hoisted block, ahead of the
 * factories. Both mock groups need it; `meri-prompt` merely happened to resolve
 * first and take the blame.
 */
const { requestMeriContextPromptMock, apiGetMock, apiPostMock, apiPatchMock } = vi.hoisted(() => ({
  requestMeriContextPromptMock: vi.fn(),
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
  apiPatchMock: vi.fn(),
}));

vi.mock('../../../components/chat/meri-prompt.js', () => ({
  requestMeriContextPrompt: requestMeriContextPromptMock,
}));

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock, post: apiPostMock, patch: apiPatchMock }),
}));

function setupBrowserMocks() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  Object.defineProperty(window, 'getComputedStyle', {
    writable: true,
    value: () => ({ getPropertyValue: () => '' }),
  });
}

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
    // P06 additive field. Null here: nothing in the page reads it yet, and a
    // fixture that invented a recommendation would assert behaviour P09 owns.
    recommendation: null,
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

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AntApp>
        <FundingOpportunitiesPage />
      </AntApp>
    </QueryClientProvider>,
  );
}

function mockApi(list: FundingOpportunityListResponse | Error) {
  apiGetMock.mockImplementation(async (url: string) => {
    if (url === '/api/tenant-members') {
      return { data: [{ id: 'user-1', name: 'Ada Byron', email: 'ada@example.com' }] };
    }
    if (url === '/api/clients/client-1/facilities') {
      return { data: [{ id: 'facility-1', name: 'El Paso Plant', city: 'El Paso', state: 'TX' }] };
    }
    if (url.startsWith('/api/clients')) {
      return { data: [{ id: 'client-1', name: 'Acme Defense', status: 'active' }] };
    }
    if (url.startsWith('/api/intelligence/opportunities')) {
      if (list instanceof Error) throw list;
      return { data: list };
    }
    return { data: {} };
  });
}

beforeEach(() => {
  setupBrowserMocks();
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  apiPatchMock.mockReset();
  apiPostMock.mockResolvedValue({ data: {} });
  apiPatchMock.mockResolvedValue({ data: {} });
  setSearchParamsMock.mockClear();
  flag = { enabled: true, ready: true };
  search = '?clientId=client-1';
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
    expect(
      screen.getByText(/SAM\.gov contract opportunities: current to/i),
    ).toBeInTheDocument();
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
    // A dollar sign in the KPI strip would mean somebody added a money total.
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

  test('a grant with no ceiling and no program funding also says "Not stated"', async () => {
    mockApi(
      listResponse({
        opportunities: [
          grant({
            grantFunding: {
              estimatedProgramFunding: null,
              awardFloor: null,
              awardCeiling: null,
              expectedAwardCount: null,
              costSharingRequired: null,
            },
          }),
        ],
      }),
    );
    renderPage();
    expect(await screen.findByText('Not stated')).toBeInTheDocument();
  });
});

describe('relevance and eligibility are shown separately', () => {
  test('both a relevance number and an eligibility badge appear', async () => {
    mockApi(listResponse({ opportunities: [grant()] }));
    renderPage();
    const card = await screen.findByTestId('fo-card-grants_gov:GRANT-1');
    // Two separate facts on the card, never one merged score. "Eligibility" also
    // appears as a filter label, so this asserts against the CARD, not the page.
    expect(card).toHaveTextContent('Relevance');
    expect(card).toHaveTextContent('Eligibility');
    expect(card).toHaveTextContent('Eligible');
  });

  test('a contract eligibility of unknown is labelled Unknown, not Eligible', async () => {
    mockApi(listResponse({ opportunities: [contract()] }));
    renderPage();
    expect(await screen.findByText('Unknown')).toBeInTheDocument();
  });

  test('matched signals are listed with the value that matched', async () => {
    mockApi(listResponse({ opportunities: [grant()] }));
    renderPage();
    expect(await screen.findByText(/assistanceListing: 81\.086/)).toBeInTheDocument();
  });
});

describe('notice stage', () => {
  test('an amended notice shows what it was originally', async () => {
    mockApi(listResponse({ opportunities: [contract()] }));
    renderPage();
    expect(await screen.findByText(/Was Presolicitation/i)).toBeInTheDocument();
  });

  test('a non-pursuable notice is flagged as not a pursuit', async () => {
    mockApi(
      listResponse({
        opportunities: [contract({ kind: 'award_notice', isPursuable: false, baseKind: null })],
      }),
    );
    renderPage();
    expect(await screen.findByText('Not a pursuit')).toBeInTheDocument();
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

  test('a null deadline with no note says no deadline was stated', async () => {
    mockApi(
      listResponse({
        opportunities: [grant({ responseDeadline: null, responseDeadlineNote: null })],
      }),
    );
    renderPage();
    expect(await screen.findByText('No deadline stated')).toBeInTheDocument();
  });
});

describe('honest states', () => {
  test('a FAILED request renders an error, never an empty list', async () => {
    mockApi(new Error('boom'));
    renderPage();
    // The page sets `retry: 1`, so a transient failure is retried once before the
    // error surfaces. That is deliberate, and it outlasts findBy's default 1s
    // window — hence the explicit timeout rather than weakening the retry.
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

  test('a loading page shows a skeleton, not an empty state', async () => {
    apiGetMock.mockImplementation(() => new Promise(() => {}));
    renderPage();
    await waitFor(() => expect(screen.queryByTestId('fo-empty')).not.toBeInTheDocument());
  });

  test('with no client selected, the page says scores are not shown', async () => {
    search = '';
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
    const saveButton = await screen.findByRole('button', { name: /Save/ });
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
    (await screen.findByRole('button', { name: /Pursue/ })).click();
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
    (await screen.findByRole('button', { name: /Dismiss/ })).click();
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
    expect(screen.queryByRole('button', { name: /Pursue/ })).not.toBeInTheDocument();
  });

  test('with no client selected, workflow buttons are disabled with an explanation', async () => {
    search = '';
    mockApi(listResponse({ opportunities: [contract()] }));
    renderPage();
    const save = await screen.findByRole('button', { name: /Save/ });
    expect(save).toBeDisabled();
    expect(screen.getByText(/Select a client to save or pursue/i)).toBeInTheDocument();
  });

  test('Ask Meri opens a new client-scoped assessment with source facts', async () => {
    mockApi(listResponse({ opportunities: [contract()] }));
    renderPage();
    // Regex, not an exact name: Ant Design's icons render as
    // `<span role="img" aria-label="message">`, and a labelled child CONTRIBUTES to
    // the button's accessible name — so the exact name is "message Ask Meri".
    fireEvent.click(await screen.findByRole('button', { name: /Ask Meri/ }));
    expect(requestMeriContextPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'client-1',
        newSession: true,
        prompt: expect.stringContaining('W911-26-R-0001'),
      }),
    );
  });

  test('assign owner opens a real modal and patches the workflow', async () => {
    mockApi(listResponse({ opportunities: [contract()] }));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /More actions for Turbofan/i }));
    fireEvent.click(await screen.findByText('Assign owner'));
    expect(await screen.findByText('Assign opportunity owner')).toBeInTheDocument();
    // `getByRole('combobox')`, not `getByLabelText`: Ant Design's Select carries the
    // aria-label on BOTH its wrapper and its inner search input, so getByLabelText
    // finds two nodes. The same reason is documented on the accessible-name test
    // below, which uses getAllByLabelText.
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Opportunity owner' }));
    fireEvent.click(await screen.findByText(/Ada Byron/));
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() =>
      expect(apiPatchMock).toHaveBeenCalledWith(
        expect.stringContaining('/opportunities/sam_gov/'),
        { ownerUserId: 'user-1' },
      ),
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
      expect(apiPatchMock).toHaveBeenCalledWith(
        expect.stringContaining('/opportunities/sam_gov/'),
        { notes: 'Coordinate capture review.' },
      ),
    );
  });

  test('link project site patches a client-owned facility', async () => {
    mockApi(listResponse({ opportunities: [contract()] }));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /More actions for Turbofan/i }));
    fireEvent.click(await screen.findByText('Link project site'));
    fireEvent.mouseDown(await screen.findByRole('combobox', { name: 'Project site' }));
    fireEvent.click(await screen.findByText(/El Paso Plant/));
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() =>
      expect(apiPatchMock).toHaveBeenCalledWith(
        expect.stringContaining('/opportunities/sam_gov/'),
        { facilityId: 'facility-1' },
      ),
    );
  });

  test('create task uses the existing engagement task route', async () => {
    mockApi(listResponse({ opportunities: [contract()] }));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /More actions for Turbofan/i }));
    fireEvent.click(await screen.findByText('Create task'));
    fireEvent.change(await screen.findByLabelText('Task context'), {
      target: { value: 'Prepare bid/no-bid review.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith(
        '/api/engagement/tasks',
        expect.objectContaining({
          clientId: 'client-1',
          title: expect.stringContaining('Pursue:'),
          description: expect.stringContaining('Prepare bid/no-bid review.'),
        }),
      ),
    );
  });
});

describe('filters', () => {
  test('the request carries the client and the active-state filter', async () => {
    mockApi(listResponse());
    renderPage();
    await waitFor(() =>
      expect(apiGetMock).toHaveBeenCalledWith(
        expect.stringContaining('clientId=client-1'),
      ),
    );
    expect(apiGetMock).toHaveBeenCalledWith(expect.stringContaining('activeState=active'));
  });

  test.each(['Saved', 'Pursuing'])('%s includes closed workflow history', async (tabLabel) => {
    mockApi(listResponse());
    renderPage();
    // By ROLE, not by text: "Saved" and "Pursuing" are also KPI tile labels a few
    // lines above the tab strip, so findByText matches two nodes.
    fireEvent.click(await screen.findByRole('radio', { name: tabLabel }));
    await waitFor(() =>
      expect(apiGetMock).toHaveBeenCalledWith(expect.stringContaining('activeState=all')),
    );
  });

  test('every filter control has an accessible name', async () => {
    mockApi(listResponse());
    renderPage();
    await screen.findByTestId('fo-kpis');
    // getAllByLabelText, not getByLabelText: Ant Design renders more than one
    // labelled node per Select (a hidden input plus the combobox), so requiring
    // exactly one would test AntD's internals rather than the accessibility
    // requirement, which is that each control HAS an accessible name.
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
    // The card already LABELLED it ("Not a pursuit") while still offering the
    // button next to the label, and the API accepted it — so a competition
    // somebody else won could be marked as an active pursuit, and it would then
    // sort to the TOP of the workflow rail above real bids.
    mockApi(listResponse({ opportunities: [awardNotice()] }));
    renderPage();
    expect(await screen.findByRole('button', { name: /Save/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pursue/ })).not.toBeInTheDocument();
  });

  test('an award notice does not offer Create task', async () => {
    mockApi(listResponse({ opportunities: [awardNotice()] }));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /More actions for Award Notice/i }));
    expect(await screen.findByText('Assign owner')).toBeInTheDocument();
    // A pursuit task is a pursuit action, so it follows Pursue.
    expect(screen.queryByText('Create task')).not.toBeInTheDocument();
  });

  test('the three edit actions REMAIN available on an award notice', async () => {
    // Saving a competitor's win for reference, with a note about it, is exactly how
    // a capture team tracks the market. Only the pursuit claim is refused.
    mockApi(listResponse({ opportunities: [awardNotice()] }));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /More actions for Award Notice/i }));
    for (const label of ['Assign owner', 'Add note', 'Link project site']) {
      expect(await screen.findByText(label)).toBeInTheDocument();
    }
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
    expect(await screen.findByRole('button', { name: /Save/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pursue/ })).not.toBeInTheDocument();
    expect(
      screen.getByText(/closed, so it can be saved for reference but not pursued/i),
    ).toBeInTheDocument();
  });

  test('an open, pursuable notice still offers Pursue', async () => {
    // The guard must not be so broad that it removes the primary action from the
    // rows the page exists to surface.
    mockApi(listResponse({ opportunities: [contract()] }));
    renderPage();
    expect(await screen.findByRole('button', { name: /Pursue/ })).toBeInTheDocument();
  });
});

describe('a failing rail is never rendered as healthy', () => {
  function failingGrantsRail() {
    const base = listResponse();
    return {
      ...base,
      freshness: [
        {
          ...base.freshness[0]!,
          // Succeeded a week ago, has failed every night since.
          lastSyncedAt: '2026-07-22T02:00:00.000Z',
          lastAttemptAt: '2026-07-29T02:00:00.000Z',
          lastRunStatus: 'error',
          lastRunErrorCount: 1,
          lastFailureAt: '2026-07-29T02:00:00.000Z',
          hoursSinceLastSuccess: 168,
          lastRunDegraded: true,
        },
        base.freshness[1]!,
      ],
    };
  }

  test('the last-good date and the failure are BOTH stated', async () => {
    // The old API reported successful runs only, so this rail read as a plain
    // "current to 22 Jul" — the most dangerous rendering, because it looks fine.
    mockApi(failingGrantsRail());
    renderPage();
    expect(await screen.findByText(/current to .* — LAST RUN FAILED/)).toBeInTheDocument();
  });

  test('a stalled detail enricher is reported separately from the catalog rail', async () => {
    const base = listResponse();
    mockApi({
      ...base,
      freshness: [
        {
          ...base.freshness[0]!,
          enrichment: {
            lastAttemptAt: '2026-07-29T02:00:00.000Z',
            lastSuccessAt: '2026-07-01T02:00:00.000Z',
            degraded: true,
            detailedRecordCount: 400,
            activeAwaitingEnrichment: 320,
          },
        },
        base.freshness[1]!,
      ],
    });
    renderPage();
    // sync-grants populates ten fields; award ceilings and eligibility text come
    // from the detail fetch, so a green catalog rail with a dead enricher renders
    // as "this grant has no award ceiling" rather than "we have not fetched it".
    expect(await screen.findByText(/enrichment FAILING/)).toBeInTheDocument();
    expect(screen.getByText(/award ceilings and eligibility text may be missing/)).toBeInTheDocument();
  });

  test('a healthy rail with a backlog says how big the backlog is', async () => {
    const base = listResponse();
    mockApi({
      ...base,
      freshness: [
        {
          ...base.freshness[0]!,
          enrichment: {
            lastAttemptAt: '2026-07-29T02:00:00.000Z',
            lastSuccessAt: '2026-07-29T02:00:00.000Z',
            degraded: false,
            detailedRecordCount: 400,
            activeAwaitingEnrichment: 42,
          },
        },
        base.freshness[1]!,
      ],
    });
    renderPage();
    expect(await screen.findByText(/42 active grants awaiting detail fetch/)).toBeInTheDocument();
  });
});
