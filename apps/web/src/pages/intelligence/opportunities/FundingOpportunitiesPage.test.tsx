import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { FundingOpportunitiesPage } from './FundingOpportunitiesPage.js';
import type {
  FundingOpportunity,
  FundingOpportunityListResponse,
  InboxResponse,
} from './funding-opportunities-api.js';

/**
 * PER-FEATURE flags, not one boolean.
 *
 * Before P11 this mock returned the same `{enabled, ready}` for every feature,
 * which was fine when the page read exactly one flag. It now reads two, and a
 * single shared boolean would silently turn the inbox on for every test in this
 * file — so every catalog assertion below would have been asserting against a page
 * that was no longer rendering the catalog.
 *
 * `funding_opportunities_client_inbox` defaults to OFF here on purpose. This whole
 * file is the proof that FLAG-OFF BEHAVIOUR IS UNCHANGED by P11; the inbox has its
 * own file, and the view switching is tested at the bottom of this one by turning
 * the flag on explicitly.
 */
const { flags, urlStore } = vi.hoisted(() => ({
  flags: { funding_opportunities: true, funding_opportunities_client_inbox: false } as Record<
    string,
    boolean
  >,
  /**
   * A SUBSCRIBABLE search-param store.
   *
   * The old mock held the query string in a plain `let` and handed back a fresh
   * URLSearchParams on each render. That worked while every tab and filter was
   * component state — but P11 moves all of it into the URL, and a store nothing
   * can subscribe to means `setSearchParams` updates a string that no component
   * ever re-reads. Clicking a tab would change the URL and render nothing.
   *
   * `useSyncExternalStore` over one module-level string keeps every consumer
   * (the shell and whichever view is mounted) reading the SAME value, which a
   * `useState` inside the hook would not.
   */
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
    // `flag` still drives the MASTER feature so the existing gating tests, which
    // flip it, keep meaning what they meant.
    enabled: feature === 'funding_opportunities' ? flag.enabled : flags[feature] === true,
    ready: flag.ready,
  }),
  useIntelFeatureEnabled: (feature: string) =>
    feature === 'funding_opportunities' ? flag.enabled : flags[feature] === true,
}));

const setSearchParamsMock = vi.fn((next: URLSearchParams) => {
  urlStore.set(next.toString() ? `?${next.toString()}` : '');
});
// `useNavigate` is reached through P12's detail drawer, which the inbox renders.
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
    // P06/P07 additive fields. Null here: an undecided machine suggestion is the
    // common case, and a fixture that invented either would assert behaviour these
    // tests do not own.
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

function emptyInbox(partial: Partial<InboxResponse> = {}): InboxResponse {
  return {
    filter: 'needs_review',
    clientId: null,
    source: null,
    rows: [],
    nextCursor: null,
    pageSize: 50,
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
    generatedAt: '2026-07-28T12:00:00.000Z',
    ...partial,
  };
}

function mockApi(list: FundingOpportunityListResponse | Error, inbox?: InboxResponse | Error) {
  apiGetMock.mockImplementation(async (url: string) => {
    if (url === '/api/tenant-members') {
      return { data: [{ id: 'user-1', name: 'Ada Byron', email: 'ada@example.com' }] };
    }
    if (url === '/api/clients/client-1/facilities') {
      return { data: [{ id: 'facility-1', name: 'El Paso Plant', city: 'El Paso', state: 'TX' }] };
    }
    if (url.startsWith('/api/clients')) {
      // TWO clients since P11: the selected-client tests need one they can switch
      // TO, and a single-client list makes "picking a client" untestable.
      return {
        data: [
          { id: 'client-1', name: 'Acme Defense', status: 'active' },
          { id: 'client-2', name: 'Beta Systems', status: 'active' },
        ],
      };
    }
    // BEFORE the catalog branch: the inbox path is a prefix match away from the
    // catalog one, and getting this order wrong serves catalog JSON to the inbox.
    if (url.startsWith('/api/intelligence/opportunities/inbox')) {
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

beforeEach(() => {
  setupBrowserMocks();
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  apiPatchMock.mockReset();
  apiPostMock.mockResolvedValue({ data: {} });
  apiPatchMock.mockResolvedValue({ data: {} });
  setSearchParamsMock.mockClear();
  flag = { enabled: true, ready: true };
  flags.funding_opportunities_client_inbox = false;
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
  test('fit and eligibility appear as two separate facts', async () => {
    mockApi(listResponse({ opportunities: [grant()] }));
    renderPage();
    const card = await screen.findByTestId('fo-card-grants_gov:GRANT-1');
    // Still two separate facts, never one merged score — that is the invariant this
    // test has always been about. P09 changed the FIT side from a bare number
    // ("Relevance 54") to a band plus a reason, because a number is not a claim
    // anybody can check. The number is still on the card, inside the evidence
    // disclosure. "Eligibility" also appears as a filter label, so this asserts
    // against the CARD, not the page.
    expect(card).toHaveTextContent('Fit');
    expect(card).toHaveTextContent('Strong fit');
    expect(card).toHaveTextContent('Eligibility');
    expect(card).toHaveTextContent('Eligible');
    // The two are still distinguishable from each other, which is the point.
    expect(card).toHaveTextContent(/relevance 54/);
  });

  test('a contract eligibility of unknown is labelled Unknown, not Eligible', async () => {
    mockApi(listResponse({ opportunities: [contract()] }));
    renderPage();
    expect(await screen.findByText('Unknown')).toBeInTheDocument();
  });

  test('the matched value is shown, under a human label rather than a machine key', async () => {
    // This test used to assert `assistanceListing: 81.086` — i.e. it asserted the
    // defect. A raw camelCase key rendered as prose taught operators a private
    // vocabulary and made an exact classification match indistinguishable from the
    // word "defense" appearing in a DoD notice.
    //
    // What actually matters is preserved and strengthened: the matched VALUE is
    // still on the card, because the whole point of `matchedOn` is that somebody
    // can go and check it.
    mockApi(listResponse({ opportunities: [grant()] }));
    renderPage();
    expect(
      await screen.findByText(/Prior award under this Assistance Listing: 81\.086/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/assistanceListing:/)).not.toBeInTheDocument();
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
    urlStore.set('');
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

  test('create task goes through the ATOMIC action, not the raw task route', async () => {
    // P08. The old call posted straight to /api/engagement/tasks, which created a
    // task titled "Pursue: X" and changed nothing else — so a task saying "pursue
    // this" could exist while the opportunity was still an untouched machine
    // suggestion. Asserting the ROUTE is what keeps that from coming back.
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
    // The server derives title, description, due date and the idempotency key.
    // Sending them from here is what let the two rows drift apart.
    expect(body).not.toHaveProperty('title');
    expect(body).not.toHaveProperty('dueDate');
    expect(body).toMatchObject({ notes: 'Prepare bid/no-bid review.' });
    expect(['review', 'pursuit']).toContain((body as { intent: string }).intent);
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

// ── P11: the shell, the flag, and URL-restorable state ──────────────────────

describe('the inbox flag decides what the DEFAULT is, and nothing else', () => {
  test('with the flag off there is no view switcher and no inbox request at all', async () => {
    mockApi(listResponse());
    renderPage();
    await screen.findByTestId('fo-kpis');
    expect(screen.queryByLabelText('Funding Opportunities view')).not.toBeInTheDocument();
    // The rollback path is "turn the flag off", so the page must not even TALK to
    // the inbox route when it is off — a 404 from the inbox guard would otherwise
    // surface as a broken page for a tenant who never opted in.
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

  test('with the flag ON the inbox is the landing view, not the catalog', async () => {
    // The single most important assertion in this file: "no client selected, here
    // is the entire federal catalog" is no longer the opening screen.
    flags.funding_opportunities_client_inbox = true;
    mockApi(listResponse(), emptyInbox());
    renderPage();
    expect(await screen.findByTestId('fo-inbox')).toBeInTheDocument();
    expect(screen.queryByTestId('fo-kpis')).not.toBeInTheDocument();
  });

  test('the catalog is still reachable, as Explore federal opportunities', async () => {
    flags.funding_opportunities_client_inbox = true;
    mockApi(listResponse(), emptyInbox());
    renderPage();
    fireEvent.click(await screen.findByRole('radio', { name: /Explore federal opportunities/ }));
    expect(await screen.findByTestId('fo-explore')).toBeInTheDocument();
  });

  test('a ?view=explore deep link opens the catalog even with the inbox enabled', async () => {
    // Existing bookmarks must keep their destination when a tenant is canaried.
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

describe('every tab, filter and page number survives a refresh', () => {
  /** Re-mount from the CURRENT url, which is what a browser refresh does. */
  function refreshPage() {
    cleanup();
    return renderPage();
  }

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
    fireEvent.click(await screen.findByRole('radio', { name: 'Dismissed' }));
    await waitFor(() => expect(urlStore.get()).toContain('tab=dismissed'));
    apiGetMock.mockClear();
    refreshPage();
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

  test('the page number is restored from the URL', async () => {
    urlStore.set('?clientId=client-1&page=3');
    mockApi(listResponse({ total: 200 }));
    renderPage();
    await waitFor(() => expect(apiGetMock).toHaveBeenCalledWith(expect.stringContaining('page=3')));
  });

  test('changing a filter resets to page 1 rather than stranding the reader', async () => {
    // A filter applied on page 7 of the old result set lands on a page that may
    // not exist in the new one, which renders as an empty list nobody can explain.
    urlStore.set('?clientId=client-1&page=7');
    mockApi(listResponse({ total: 500 }));
    renderPage();
    fireEvent.change(await screen.findByLabelText('NAICS code'), { target: { value: '541330' } });
    await waitFor(() => expect(urlStore.get()).toContain('naics=541330'));
    expect(urlStore.get()).not.toContain('page=7');
  });

  test('an unknown tab in the URL falls back to All instead of rendering nothing', async () => {
    urlStore.set('?clientId=client-1&tab=not-a-tab');
    mockApi(listResponse());
    renderPage();
    await waitFor(() =>
      expect(apiGetMock).toHaveBeenCalledWith(expect.stringContaining('activeState=active')),
    );
    expect(await screen.findByTestId('fo-explore')).toBeInTheDocument();
  });

  test('selecting a client drops a stale cursor and page from the previous result set', async () => {
    urlStore.set('?clientId=client-1&page=4&cursor=abc');
    mockApi(listResponse({ total: 500 }));
    renderPage();
    fireEvent.mouseDown(await screen.findByRole('combobox', { name: 'Client' }));
    fireEvent.click(await screen.findByText('Beta Systems'));
    await waitFor(() => expect(urlStore.get()).toContain('clientId=client-2'));
    expect(urlStore.get()).not.toContain('cursor=abc');
    expect(urlStore.get()).not.toContain('page=4');
  });
});
