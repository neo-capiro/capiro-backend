import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { FundingOpportunitiesPage } from './FundingOpportunitiesPage.js';
import type {
  FundingOpportunityListResponse,
  InboxResponse,
  InboxRow,
} from './funding-opportunities-api.js';

/**
 * The cross-client triage inbox, exercised THROUGH THE PAGE rather than by
 * mounting the component directly.
 *
 * Rendering `FundingOpportunitiesPage` is what proves the thing P11 is actually
 * about: that the inbox is what a flagged tenant LANDS ON, wired to the real
 * client selector and the real URL state. A direct mount of
 * `FundingOpportunityInbox` would pass with the shell still defaulting to the
 * catalog.
 */

const { flags, urlStore } = vi.hoisted(() => ({
  flags: { funding_opportunities: true, funding_opportunities_client_inbox: true } as Record<
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

vi.mock('../../../lib/intel-feature-flags.js', () => ({
  useIntelFeature: (feature: string) => ({ enabled: flags[feature] === true, ready: true }),
  useIntelFeatureEnabled: (feature: string) => flags[feature] === true,
}));

const setSearchParamsMock = vi.fn((next: URLSearchParams) => {
  urlStore.set(next.toString() ? `?${next.toString()}` : '');
});
// P12's drawer navigates to the full-page route. Mocked here rather than switching
// this file to a MemoryRouter: these tests are about the inbox's URL STATE, which
// the subscribable store models exactly, and the real router is exercised by
// FundingOpportunityDetail.test.tsx where routing is the subject.
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

vi.mock('../../../components/chat/meri-prompt.js', () => ({
  requestMeriContextPrompt: vi.fn(),
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
    // P26. Null on every catalog rail; a forecast row overrides it.
    forecast: null,
    // P41. Null on every rail but the bid board; a dibbs row overrides it.
    dibbs: null,
    // P43. Null on every rail but SBIR/STTR; a topic row overrides it.
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

function inboxResponse(partial: Partial<InboxResponse> = {}): InboxResponse {
  return {
    filter: 'needs_review',
    clientId: null,
    source: null,
    rows: [inboxRow()],
    nextCursor: null,
    pageSize: 50,
    counts: { ...ZERO_COUNTS, needs_review: 1 },
    countsAllClients: null,
    countsUnavailableReason: null,
    generatedAt: '2026-08-06T12:00:00.000Z',
    ...partial,
  };
}

/** Only `freshness` is read from this; the inbox never renders catalog rows. */
function catalogForFreshness(
  partial: Partial<FundingOpportunityListResponse> = {},
): FundingOpportunityListResponse {
  return {
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
    freshness: [
      {
        source: 'grants_gov',
        verb: 'sync-grants',
        label: 'Grants.gov opportunities',
        lastSyncedAt: '2026-08-05T00:00:00.000Z',
        lastAttemptAt: '2026-08-05T00:00:00.000Z',
        lastRunStatus: 'success',
        lastRunErrorCount: 0,
        lastFailureAt: null,
        hoursSinceLastSuccess: 12,
        neverSynced: false,
        lastRunDegraded: false,
        countsUnavailable: false,
        recordCount: 800,
        activeRecordCount: 120,
        enrichment: null,
      },
    ],
    emptyReason: null,
    emptyExplanation: null,
    missingProfileFields: [],
    generatedAt: '2026-08-06T12:00:00.000Z',
    ...partial,
  };
}

let inboxData: InboxResponse | Error = inboxResponse();
let catalogData: FundingOpportunityListResponse | Error = catalogForFreshness();
let inboxUrls: string[] = [];

function mockApi() {
  apiGetMock.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/clients')) {
      return {
        data: [
          { id: 'client-1', name: 'Acme Defense', status: 'active' },
          { id: 'client-2', name: 'Beta Systems', status: 'active' },
        ],
      };
    }
    if (url.startsWith('/api/intelligence/opportunities/inbox')) {
      inboxUrls.push(url);
      if (inboxData instanceof Error) throw inboxData;
      return { data: inboxData };
    }
    if (url.startsWith('/api/intelligence/opportunities')) {
      if (catalogData instanceof Error) throw catalogData;
      return { data: catalogData };
    }
    return { data: {} };
  });
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

beforeEach(() => {
  setupBrowserMocks();
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  apiPatchMock.mockReset();
  setSearchParamsMock.mockClear();
  flags.funding_opportunities = true;
  flags.funding_opportunities_client_inbox = true;
  // P26. Off by default in every test, matching every real tenant today — a
  // forecast test has to turn it on explicitly, so no existing assertion can
  // start depending on it silently.
  flags.funding_opportunities_forecasts = false;
  // P43, same reasoning for the SBIR rail.
  flags.funding_opportunities_sbir = false;
  inboxData = inboxResponse();
  catalogData = catalogForFreshness();
  inboxUrls = [];
  urlStore.set('');
  mockApi();
});

describe('the inbox is the default, and it is client-first', () => {
  test('it lands on needs_review without being asked', async () => {
    renderPage();
    await screen.findByTestId('fo-inbox');
    await waitFor(() => expect(inboxUrls.length).toBeGreaterThan(0));
    expect(inboxUrls[0]).toContain('filter=needs_review');
  });

  test('EVERY row names its client', async () => {
    // A cross-client list without the client on each row is a list nobody can act
    // on: the same notice means different things to two different clients.
    inboxData = inboxResponse({
      rows: [
        inboxRow(),
        inboxRow({ id: 'wf-0002', client: { id: 'client-2', name: 'Beta Systems' } }),
      ],
      counts: { ...ZERO_COUNTS, needs_review: 2 },
    });
    renderPage();
    expect(await screen.findByRole('button', { name: /Show only Acme Defense/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Show only Beta Systems/ })).toBeInTheDocument();
  });

  test('a row shows deadline, owner, next action and eligibility as separate facts', async () => {
    renderPage();
    const row = await screen.findByTestId('fo-inbox-row-wf-0001');
    expect(row).toHaveTextContent('Deadline');
    expect(row).toHaveTextContent('(9d)');
    expect(row).toHaveTextContent('Unassigned');
    expect(row).toHaveTextContent('None recorded');
    expect(row).toHaveTextContent('Needs review');
  });

  test('an unevaluated eligibility says "Not evaluated", never a blank and never Eligible', async () => {
    inboxData = inboxResponse({
      rows: [inboxRow({ eligibility: { state: null, reason: null } })],
    });
    renderPage();
    const row = await screen.findByTestId('fo-inbox-row-wf-0001');
    expect(row).toHaveTextContent('Not evaluated');
    expect(row).not.toHaveTextContent('Eligible');
  });

  test('a stale suggestion and a closed source are flagged, not hidden', async () => {
    inboxData = inboxResponse({
      rows: [inboxRow({ noLongerSuggested: true, sourceClosed: true })],
    });
    renderPage();
    const row = await screen.findByTestId('fo-inbox-row-wf-0001');
    expect(row).toHaveTextContent('No longer suggested');
    expect(row).toHaveTextContent('Source closed');
  });

  test('a persisted human decision is shown distinctly from the workflow status', async () => {
    // Machine recommendation, human decision and workflow stage are three separate
    // concepts and all three can legitimately disagree.
    inboxData = inboxResponse({
      rows: [inboxRow({ humanDecision: 'monitor', workflowStatus: 'saved' })],
    });
    renderPage();
    const row = await screen.findByTestId('fo-inbox-row-wf-0001');
    expect(row).toHaveTextContent('Decided: monitor');
    expect(row).toHaveTextContent('Saved');
  });
});

describe('the six queues are the top-level model, and source is only a filter', () => {
  test('all six queues are offered, with their counts', async () => {
    inboxData = inboxResponse({
      counts: {
        needs_review: 4,
        pursuing: 2,
        deadlines: 7,
        recently_changed: 9,
        monitoring: 1,
        passed: 3,
      },
    });
    renderPage();
    for (const label of [
      'Needs review',
      'Pursuing',
      'Deadlines',
      'Recently changed',
      'Monitoring',
      'Passed',
    ]) {
      expect(await screen.findByRole('radio', { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  test('source is a FILTER control, never a top-level tab', async () => {
    renderPage();
    await screen.findByTestId('fo-inbox');
    expect(screen.getAllByLabelText('Source rail', { exact: false }).length).toBeGreaterThan(0);
    // The catalog's rail tabs must not have followed the page across.
    expect(screen.queryByRole('radio', { name: 'Grants' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('radio', { name: 'Government contracts' }),
    ).not.toBeInTheDocument();
  });

  test('changing the queue writes it to the URL and re-requests', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('radio', { name: /Deadlines/ }));
    await waitFor(() => expect(urlStore.get()).toContain('filter=deadlines'));
    await waitFor(() =>
      expect(inboxUrls.some((u) => u.includes('filter=deadlines'))).toBe(true),
    );
  });

  test('a queue in the URL is restored on load', async () => {
    urlStore.set('?filter=monitoring');
    renderPage();
    await waitFor(() =>
      expect(inboxUrls.some((u) => u.includes('filter=monitoring'))).toBe(true),
    );
  });

  test('an unknown queue in the URL falls back to needs_review rather than 400ing', async () => {
    urlStore.set('?filter=urgent');
    renderPage();
    await waitFor(() => expect(inboxUrls.length).toBeGreaterThan(0));
    expect(inboxUrls[0]).toContain('filter=needs_review');
  });

  test('changing the queue clears the cursor, so page 3 of one queue is not page 3 of another', async () => {
    urlStore.set('?filter=needs_review&cursor=abc123');
    renderPage();
    fireEvent.click(await screen.findByRole('radio', { name: /Passed/ }));
    await waitFor(() => expect(urlStore.get()).toContain('filter=passed'));
    expect(urlStore.get()).not.toContain('cursor=abc123');
  });
});

describe('the selected-client view', () => {
  test('a ?clientId deep link narrows the inbox server-side', async () => {
    // Server-side, not a client-side slice of a cursor page: a page could contain
    // zero rows for the chosen client while more exist further down the walk.
    urlStore.set('?clientId=client-2');
    inboxData = inboxResponse({ clientId: 'client-2' });
    renderPage();
    await waitFor(() => expect(inboxUrls.length).toBeGreaterThan(0));
    expect(inboxUrls[0]).toContain('clientId=client-2');
  });

  test('clicking a row client narrows to that client', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Show only Acme Defense/ }));
    await waitFor(() => expect(urlStore.get()).toContain('clientId=client-1'));
  });

  test('the chip renders from what the SERVER applied, not from the request', async () => {
    // The server drops a walled or unknown clientId and reports null. Rendering
    // "Only Walled Co · no rows" would both lie about the queue and confirm that a
    // client the reader may not see exists.
    urlStore.set('?clientId=client-2');
    inboxData = inboxResponse({ clientId: null });
    renderPage();
    await screen.findByTestId('fo-inbox');
    expect(screen.queryByTestId('fo-inbox-client-filter')).not.toBeInTheDocument();
  });

  test('the chip clears the narrowing', async () => {
    urlStore.set('?clientId=client-1');
    inboxData = inboxResponse({ clientId: 'client-1' });
    renderPage();
    const chip = await screen.findByTestId('fo-inbox-client-filter');
    fireEvent.click(chip.querySelector('.ant-tag-close-icon')!);
    await waitFor(() => expect(urlStore.get()).not.toContain('clientId'));
  });
});

describe('an empty queue explains WHICH kind of empty it is', () => {
  test('nothing anywhere is reported as "no decisions exist yet", not "no opportunities"', async () => {
    inboxData = inboxResponse({ rows: [], counts: { ...ZERO_COUNTS } });
    renderPage();
    const empty = await screen.findByTestId('fo-inbox-empty');
    expect(empty).toHaveTextContent(/No client-opportunity decisions exist yet/i);
    expect(empty).toHaveTextContent(/not a statement that no relevant opportunities exist/i);
  });

  test('an empty queue beside a full one offers the full one', async () => {
    inboxData = inboxResponse({
      filter: 'monitoring',
      rows: [],
      counts: { ...ZERO_COUNTS, needs_review: 12 },
    });
    urlStore.set('?filter=monitoring');
    renderPage();
    const empty = await screen.findByTestId('fo-inbox-empty');
    expect(empty).toHaveTextContent(/Other queues do have work waiting/i);
    expect(await screen.findByRole('button', { name: /Needs review \(12\)/ })).toBeInTheDocument();
  });

  test('a client filter hiding the rows says so and offers to clear itself', async () => {
    urlStore.set('?clientId=client-1');
    inboxData = inboxResponse({
      clientId: 'client-1',
      rows: [],
      counts: { ...ZERO_COUNTS },
      countsAllClients: { ...ZERO_COUNTS, needs_review: 9 },
    });
    renderPage();
    const empty = await screen.findByTestId('fo-inbox-empty');
    expect(empty).toHaveTextContent(/Other clients have 9 here/i);
    expect(await screen.findByRole('button', { name: 'Show every client' })).toBeInTheDocument();
  });

  test('a source filter hiding the rows says so and offers to clear itself', async () => {
    urlStore.set('?source=grants_gov');
    inboxData = inboxResponse({ source: 'grants_gov', rows: [], counts: { ...ZERO_COUNTS } });
    renderPage();
    const empty = await screen.findByTestId('fo-inbox-empty');
    expect(empty).toHaveTextContent(/narrows this queue to one rail/i);
    expect(await screen.findByRole('button', { name: 'Show all sources' })).toBeInTheDocument();
  });

  test('unreadable counts do not let the empty state claim there is no work', async () => {
    inboxData = inboxResponse({
      rows: [],
      counts: {
        needs_review: -1,
        pursuing: -1,
        deadlines: -1,
        recently_changed: -1,
        monitoring: -1,
        passed: -1,
      },
      countsUnavailableReason: 'count timed out',
    });
    renderPage();
    const empty = await screen.findByTestId('fo-inbox-empty');
    expect(empty).toHaveTextContent(/counts could not be read/i);
    expect(empty).toHaveTextContent(/Retry before concluding there is no work waiting/i);
  });

  test('a -1 count renders as "?" on the tab, never as 0', async () => {
    // A zero badge on a queue that actually has forty rows is the more dangerous
    // of the two failures, and it is indistinguishable from an empty queue.
    inboxData = inboxResponse({
      counts: {
        needs_review: -1,
        pursuing: -1,
        deadlines: -1,
        recently_changed: -1,
        monitoring: -1,
        passed: -1,
      },
      countsUnavailableReason: 'count timed out',
    });
    renderPage();
    // The tabs render before the counts arrive, so findByRole alone resolves against
    // the loading state ("—"). Wait for the resolved value.
    //
    // `.closest('label')`: AntD Segmented's radio IS a bare `<input>`, whose own
    // textContent is empty. The visible count lives in the sibling label div.
    await waitFor(() => {
      const tab = screen.getByRole('radio', { name: /Needs review/ }).closest('label');
      expect(tab?.textContent).toContain('?');
    });
    const tab = screen.getByRole('radio', { name: /Needs review/ }).closest('label');
    expect(tab?.textContent).not.toMatch(/\b0\b/);
  });
});

describe('a failure is a failure, never an empty inbox', () => {
  test('a failed request renders an explicit error with a retry', async () => {
    inboxData = new Error('boom');
    renderPage();
    const err = await screen.findByTestId('fo-inbox-error', {}, { timeout: 8000 });
    expect(err).toHaveTextContent(/request failure, not an empty inbox/i);
    expect(screen.queryByTestId('fo-inbox-empty')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  test('a loading inbox shows a skeleton, not an empty state', async () => {
    apiGetMock.mockImplementation(() => new Promise(() => {}));
    renderPage();
    await waitFor(() =>
      expect(screen.queryByTestId('fo-inbox-empty')).not.toBeInTheDocument(),
    );
  });

  test('source-rail health is shown on the inbox too, because a dead rail serves stale rows', async () => {
    // The inbox reads decision-context snapshots, so a dead rail does not empty it
    // — it quietly serves last week's picture, which is the worse failure.
    catalogData = catalogForFreshness({
      freshness: [
        {
          ...catalogForFreshness().freshness[0]!,
          lastSyncedAt: '2026-07-22T02:00:00.000Z',
          lastAttemptAt: '2026-08-05T02:00:00.000Z',
          lastRunStatus: 'error',
          lastRunDegraded: true,
        },
      ],
    });
    renderPage();
    expect(await screen.findByText(/current to .* — LAST RUN FAILED/)).toBeInTheDocument();
  });

  test('a freshness read that fails does not take the inbox down with it', async () => {
    catalogData = new Error('freshness unavailable');
    renderPage();
    expect(await screen.findByTestId('fo-inbox-row-wf-0001')).toBeInTheDocument();
  });
});

describe('cursor paging neither repeats nor strands a page', () => {
  test('Next carries the server cursor verbatim into the URL and the request', async () => {
    inboxData = inboxResponse({ nextCursor: 'CURSOR-2' });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    await waitFor(() => expect(urlStore.get()).toContain('cursor=CURSOR-2'));
    await waitFor(() => expect(inboxUrls.some((u) => u.includes('cursor=CURSOR-2'))).toBe(true));
  });

  test('Next is disabled on the last page', async () => {
    inboxData = inboxResponse({ nextCursor: null });
    renderPage();
    expect(await screen.findByRole('button', { name: 'Next' })).toBeDisabled();
  });

  test('Previous is disabled on the first page', async () => {
    inboxData = inboxResponse({ nextCursor: 'CURSOR-2' });
    renderPage();
    expect(await screen.findByRole('button', { name: 'Previous' })).toBeDisabled();
  });

  test('a cursor restored from the URL offers First page rather than a Previous that would guess', async () => {
    // A keyset cursor is forward-only. After a refresh the trail is gone, so a
    // Previous would have to invent a destination.
    urlStore.set('?cursor=CURSOR-2');
    inboxData = inboxResponse({ nextCursor: 'CURSOR-3' });
    renderPage();
    expect(await screen.findByRole('button', { name: 'First page' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
  });

  test('First page clears the cursor', async () => {
    urlStore.set('?cursor=CURSOR-2');
    inboxData = inboxResponse({ nextCursor: 'CURSOR-3' });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'First page' }));
    await waitFor(() => expect(urlStore.get()).not.toContain('cursor'));
  });

  test('the footer counts the queue, never inventing a page total the keyset walk has no way to know', async () => {
    inboxData = inboxResponse({ counts: { ...ZERO_COUNTS, needs_review: 137 } });
    renderPage();
    expect(await screen.findByText(/Showing 1 of 137 in needs review/i)).toBeInTheDocument();
  });
});

// ── P12: inbox rows open the detail drawer ──────────────────────────────────

describe('an inbox row opens the detail drawer, from the URL', () => {
  test('there is no drawer until a row is opened', async () => {
    renderPage();
    await screen.findByTestId('fo-inbox-row-wf-0001');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('clicking a row title writes the ref to the URL', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Open detail for Turbofan/ }));
    await waitFor(() => expect(urlStore.get()).toContain('detail=sam_gov%3A'));
  });

  test('the ref carries the ROW’s client, not the page filter', async () => {
    // The inbox is cross-client. Relevance, eligibility and the decision are facts
    // about a client-opportunity PAIR, so a drawer opened from Beta Systems' row
    // while the page filter says Acme would otherwise show the wrong client's view.
    inboxData = inboxResponse({
      rows: [inboxRow({ client: { id: 'client-2', name: 'Beta Systems' } })],
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Open detail for Turbofan/ }));
    await waitFor(() => expect(decodeURIComponent(urlStore.get())).toContain(':client-2'));
  });

  test('a detail ref in the URL opens the drawer on load, so the link is shareable', async () => {
    urlStore.set(
      `?detail=${encodeURIComponent('sam_gov')}:${encodeURIComponent('11111111-1111-1111-1111-111111111111')}:${encodeURIComponent('client-1')}`,
    );
    renderPage();
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  test('a MALFORMED detail ref leaves the drawer closed instead of crashing the queue', async () => {
    urlStore.set('?detail=not-a-ref');
    renderPage();
    await screen.findByTestId('fo-inbox-row-wf-0001');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('closing clears the ref, so browser Back closes the drawer rather than leaving the page', async () => {
    urlStore.set(
      `?detail=${encodeURIComponent('sam_gov')}:${encodeURIComponent('11111111-1111-1111-1111-111111111111')}:${encodeURIComponent('client-1')}`,
    );
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /close/i }));
    await waitFor(() => expect(urlStore.get()).not.toContain('detail='));
  });
});

// ── P26: agency forecasts in the queue ──────────────────────────────────────

/**
 * A forecast row as the inbox API sends one: identity carried entirely by P13's
 * generic key, no response-deadline snapshot, and its own source-facts block.
 */
function forecastInboxRow(partial: Partial<InboxRow> = {}): InboxRow {
  return inboxRow({
    id: 'wf-f001',
    source: 'agency_forecast',
    sourceRecordId: 'FCST-1',
    title: 'Depot-level turbofan sustainment',
    agency: 'Department of the Navy',
    responseDeadline: null,
    daysUntilDeadline: null,
    relevanceScore: null,
    eligibility: { state: null, reason: null },
    forecast: {
      anticipatedAwardDate: '2027-03-01',
      anticipatedSolicitationDate: null,
      estimatedPeriod: 'Q2 FY27',
      fiscalYear: 2027,
      sourceSystem: 'APFS',
      status: 'Forecasted',
      isActive: true,
      lastSyncedAt: '2026-08-06T02:00:00.000Z',
      providerModifiedAt: null,
    },
    ...partial,
  });
}

describe('agency forecasts appear as forecasts, and only when the capability is on', () => {
  test('with the flag ON a forecast row renders the FORECAST card, not the opportunity card', async () => {
    flags.funding_opportunities_forecasts = true;
    inboxData = inboxResponse({ rows: [forecastInboxRow()] });
    renderPage();
    expect(await screen.findByTestId('fo-forecast-row-wf-f001')).toBeInTheDocument();
    // The opportunity card would have rendered under the other test id, with a
    // deadline slot and an eligibility slot the forecast has no answer for.
    expect(screen.queryByTestId('fo-inbox-row-wf-f001')).not.toBeInTheDocument();
  });

  /**
   * Open the source Select.
   *
   * By CSS rather than by label: AntD v5 puts the `aria-label` on both the
   * wrapper and the inner input, so `getByLabelText` finds two nodes, and only
   * mousedown on the selector actually opens the list.
   */
  async function openSourceFilter() {
    await screen.findByTestId('fo-inbox');
    const selector = document.querySelector('.fo-inbox__controls .ant-select-selector');
    expect(selector).not.toBeNull();
    fireEvent.mouseDown(selector!);
  }

  test('with the flag ON the source filter offers the forecast rail', async () => {
    flags.funding_opportunities_forecasts = true;
    renderPage();
    await openSourceFilter();
    expect(await screen.findByTitle('Agency forecast')).toBeInTheDocument();
  });

  test('with the flag OFF the source filter does NOT offer a rail that would return nothing', async () => {
    // An empty result from a filter the capability cannot serve reads as "this
    // client has no forecasts", which is a claim about the client.
    flags.funding_opportunities_forecasts = false;
    renderPage();
    await openSourceFilter();
    await screen.findByTitle('SAM.gov');
    expect(screen.queryByTitle('Agency forecast')).not.toBeInTheDocument();
  });

  test('with the flag OFF a forecast row is withheld, and the page SAYS how many', async () => {
    flags.funding_opportunities_forecasts = false;
    inboxData = inboxResponse({
      rows: [inboxRow(), forecastInboxRow()],
      counts: { ...ZERO_COUNTS, needs_review: 2 },
    });
    renderPage();
    // The catalog row still renders; only the forecast is withheld.
    expect(await screen.findByTestId('fo-inbox-row-wf-0001')).toBeInTheDocument();
    expect(screen.queryByTestId('fo-forecast-row-wf-f001')).not.toBeInTheDocument();
    const notice = screen.getByTestId('fo-inbox-forecasts-withheld');
    expect(notice).toHaveTextContent('1 agency forecast row not shown');
    // And it does not pretend the counts changed.
    expect(notice).toHaveTextContent('The queue counts above still include them');
  });

  test('with the flag OFF and ONLY forecast rows, the withheld notice appears beside the empty state', async () => {
    flags.funding_opportunities_forecasts = false;
    inboxData = inboxResponse({
      rows: [forecastInboxRow()],
      counts: { ...ZERO_COUNTS, needs_review: 1 },
    });
    renderPage();
    expect(await screen.findByTestId('fo-inbox-forecasts-withheld')).toBeInTheDocument();
    expect(screen.getByTestId('fo-inbox-empty')).toBeInTheDocument();
  });

  test('with the flag ON, no withheld notice appears at all', async () => {
    flags.funding_opportunities_forecasts = true;
    inboxData = inboxResponse({ rows: [forecastInboxRow()] });
    renderPage();
    await screen.findByTestId('fo-forecast-row-wf-f001');
    expect(screen.queryByTestId('fo-inbox-forecasts-withheld')).not.toBeInTheDocument();
  });

  test('a stale `?source=agency_forecast` deep link degrades to ALL sources when the flag is off', async () => {
    // Falling back to the wider view is the safe degradation: falling back to an
    // empty list would look like "there is nothing here".
    flags.funding_opportunities_forecasts = false;
    urlStore.set('?source=agency_forecast');
    renderPage();
    await waitFor(() => expect(inboxUrls.length).toBeGreaterThan(0));
    expect(inboxUrls[0]).not.toContain('source=');
  });

  test('with the flag ON a `?source=agency_forecast` deep link is honoured', async () => {
    flags.funding_opportunities_forecasts = true;
    urlStore.set('?source=agency_forecast');
    inboxData = inboxResponse({ rows: [forecastInboxRow()], source: 'agency_forecast' });
    renderPage();
    await waitFor(() => expect(inboxUrls.length).toBeGreaterThan(0));
    expect(inboxUrls[0]).toContain('source=agency_forecast');
  });

  test('opening a forecast row writes a forecast ref and opens the FORECAST drawer body', async () => {
    flags.funding_opportunities_forecasts = true;
    inboxData = inboxResponse({ rows: [forecastInboxRow()] });
    renderPage();
    fireEvent.click(
      await screen.findByRole('button', { name: /Open agency forecast detail for Depot-level/ }),
    );
    await waitFor(() => expect(urlStore.get()).toContain('detail=agency_forecast%3A'));
  });

  test('a forecast ref in the URL opens the drawer titled as a forecast', async () => {
    flags.funding_opportunities_forecasts = true;
    inboxData = inboxResponse({ rows: [forecastInboxRow()] });
    urlStore.set(
      `?detail=${encodeURIComponent('agency_forecast')}:${encodeURIComponent('FCST-1')}:${encodeURIComponent('client-1')}`,
    );
    renderPage();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Agency forecast detail');
  });

  test('a forecast card in the queue states no deadline and no eligibility', async () => {
    flags.funding_opportunities_forecasts = true;
    inboxData = inboxResponse({ rows: [forecastInboxRow()] });
    renderPage();
    const card = await screen.findByTestId('fo-forecast-row-wf-f001');
    expect(card.textContent ?? '').not.toMatch(/deadline/i);
    expect(card.textContent ?? '').not.toMatch(/eligib/i);
    expect(card).toHaveTextContent('Anticipated award');
  });
});

// ── P41 part 3: the DLA bid board in the queue ──────────────────────────────

/**
 * A dibbs row as the inbox API sends one (P41 part 2).
 *
 * The `dibbs` block mirrors `InboxDibbsFacts` field for field, including
 * `lastSyncedAt`, which the card does not read — carried anyway so this fixture
 * stays a copy of the wire rather than a copy of what one component happens to
 * use today.
 */
function dibbsInboxRow(partial: Partial<InboxRow> = {}): InboxRow {
  return inboxRow({
    id: 'wf-d001',
    source: 'dibbs',
    sourceRecordId: 'SPE4A625T1234',
    title: 'BEARING, ROLLER, TAPERED',
    agency: 'Defense Logistics Agency',
    // A bid-board line item has no response-deadline snapshot and no
    // eligibility determination; the closing date lives in the facts block.
    responseDeadline: null,
    daysUntilDeadline: null,
    relevanceScore: 41,
    eligibility: { state: null, reason: null },
    dibbs: {
      documentType: 'rfq',
      solicitation: 'SPE4A625T1234',
      solicitationFormatted: 'SPE4A6-25-T-1234',
      nsn: '3110-00-100-1234',
      partNumber: null,
      nomenclature: 'BEARING, ROLLER, TAPERED',
      quantity: '500',
      unitOfIssue: 'EA',
      setAside: 'Total Small Business',
      buyerCode: null,
      closesDate: '2026-08-20',
      isOpen: true,
      documentUrl: 'https://example.invalid/sol.pdf',
      techDocsUrl: null,
      lastSyncedAt: '2026-08-07T02:00:00.000Z',
    },
    ...partial,
  });
}

describe('DLA bid-board items appear as bid-board items (P41 part 3)', () => {
  test('a dibbs row renders the BID-BOARD card, not the opportunity card', async () => {
    inboxData = inboxResponse({ rows: [dibbsInboxRow()] });
    renderPage();
    expect(await screen.findByTestId('fo-dibbs-row-SPE4A625T1234')).toBeInTheDocument();
    // The opportunity card would have rendered a deadline slot and an
    // eligibility slot against a record that has neither.
    expect(screen.queryByTestId('fo-inbox-row-wf-d001')).not.toBeInTheDocument();
  });

  test('the card names its client, like every other row in a cross-client queue', async () => {
    inboxData = inboxResponse({ rows: [dibbsInboxRow()] });
    renderPage();
    expect(await screen.findByTestId('fo-dibbs-row-SPE4A625T1234')).toHaveTextContent(
      'Acme Defense',
    );
  });

  /**
   * The gap is the assertion this whole rail turns on.
   *
   * The inbox response carries no scoring breakdown, so the gap is passed from
   * DIBBS_PART_PROFILE_GAP_TODAY. Passing `null` instead would render nothing
   * here — and "nothing" is a claim: it says a part-level comparison ran and
   * found no gap. No client part store exists, so none has ever run.
   */
  test('the card says no part-level match was ATTEMPTED, not that the parts did not match', async () => {
    inboxData = inboxResponse({ rows: [dibbsInboxRow()] });
    renderPage();
    const gap = await screen.findByTestId('fo-dibbs-part-gap');
    expect(gap).toHaveTextContent('no part-level match was attempted');
    // The relevance number is still shown, and must not be read as a part score.
    expect(screen.getByTestId('fo-dibbs-relevance')).toHaveTextContent('41');
  });

  test('no "record this client’s parts" control is offered, because no such surface exists', async () => {
    inboxData = inboxResponse({ rows: [dibbsInboxRow()] });
    renderPage();
    await screen.findByTestId('fo-dibbs-part-gap');
    expect(screen.queryByTestId('fo-dibbs-review-parts')).not.toBeInTheDocument();
  });

  test('no action row is rendered at all, rather than an inert one', async () => {
    // No pursuit mutation is wired to a dibbs row yet. The card's rule is that an
    // absent handler removes the control instead of disabling it.
    inboxData = inboxResponse({ rows: [dibbsInboxRow()] });
    renderPage();
    await screen.findByTestId('fo-dibbs-row-SPE4A625T1234');
    expect(screen.queryByTestId('fo-dibbs-actions')).not.toBeInTheDocument();
  });

  async function openSourceFilter() {
    await screen.findByTestId('fo-inbox');
    const selector = document.querySelector('.fo-inbox__controls .ant-select-selector');
    expect(selector).not.toBeNull();
    fireEvent.mouseDown(selector!);
  }

  test('the source filter offers the bid board with NO capability flag involved', async () => {
    // Unlike forecasts, this rail has no flag on either side — the API has
    // returned these rows to every tenant since part 2, so a gate here would
    // hide a filter for rows the page is already rendering.
    flags.funding_opportunities_forecasts = false;
    renderPage();
    await openSourceFilter();
    expect(await screen.findByTitle('DLA bid board')).toBeInTheDocument();
  });

  test('a `?source=dibbs` deep link is honoured with the forecast flag off', async () => {
    flags.funding_opportunities_forecasts = false;
    urlStore.set('?source=dibbs');
    inboxData = inboxResponse({ rows: [dibbsInboxRow()], source: 'dibbs' });
    renderPage();
    await waitFor(() => expect(inboxUrls.length).toBeGreaterThan(0));
    expect(inboxUrls[0]).toContain('source=dibbs');
  });

  test('opening a bid-board row writes a dibbs ref', async () => {
    inboxData = inboxResponse({ rows: [dibbsInboxRow()] });
    renderPage();
    fireEvent.click(
      await screen.findByRole('button', { name: /Open bid-board detail for SPE4A625T1234/ }),
    );
    await waitFor(() => expect(urlStore.get()).toContain('detail=dibbs%3A'));
  });

  /**
   * The regression this part introduced and had to close.
   *
   * `asCatalogRef` returns null for a dibbs ref exactly as it does for a
   * forecast, so the drawer's old `catalogRef == null` dispatch would have sent
   * a bid-board solicitation to ForecastOpportunityDetail and rendered a DLA
   * line item as an agency forecast.
   */
  test('a dibbs ref in the drawer is NOT rendered as a forecast', async () => {
    flags.funding_opportunities_forecasts = true;
    inboxData = inboxResponse({ rows: [dibbsInboxRow()] });
    urlStore.set(
      `?detail=${encodeURIComponent('dibbs')}:${encodeURIComponent('SPE4A625T1234')}:${encodeURIComponent('client-1')}`,
    );
    renderPage();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Bid-board item');
    expect(screen.getByTestId('fo-drawer-dibbs-no-detail')).toBeInTheDocument();
    expect(dialog.textContent ?? '').not.toMatch(/forecast/i);
  });

  test('the drawer offers no "Open full page" for a rail with no full page', async () => {
    inboxData = inboxResponse({ rows: [dibbsInboxRow()] });
    urlStore.set(
      `?detail=${encodeURIComponent('dibbs')}:${encodeURIComponent('SPE4A625T1234')}:${encodeURIComponent('client-1')}`,
    );
    renderPage();
    await screen.findByRole('dialog');
    expect(screen.queryByRole('button', { name: /Open full page/ })).not.toBeInTheDocument();
  });

  test('a dibbs row whose source facts are gone stays on the bid-board rail and says so', async () => {
    // The generic card would answer "No deadline stated" and "Not evaluated" —
    // two questions never asked of a bid-board line item.
    inboxData = inboxResponse({ rows: [dibbsInboxRow({ dibbs: null })] });
    renderPage();
    const card = await screen.findByTestId('fo-dibbs-unrenderable-wf-d001');
    expect(card).toHaveTextContent('Capiro no longer holds the bid-board record');
    expect(card).toHaveTextContent('DLA bid board');
    expect(screen.queryByTestId('fo-inbox-row-wf-d001')).not.toBeInTheDocument();
  });

  test('an unrecognised document type degrades instead of being coerced into an RFQ', async () => {
    const row = dibbsInboxRow();
    inboxData = inboxResponse({
      rows: [{ ...row, dibbs: { ...row.dibbs!, documentType: 'award' } }],
    });
    renderPage();
    const card = await screen.findByTestId('fo-dibbs-unrenderable-wf-d001');
    expect(card).toHaveTextContent('which this rail does not render');
    // Above all: no quote control was rendered for something that is not an RFQ.
    expect(screen.queryByTestId('fo-dibbs-actions')).not.toBeInTheDocument();
  });
});

// ── P43 part 3: SBIR/STTR topics in the queue ───────────────────────────────

function sbirInboxRow(partial: Partial<InboxRow> = {}): InboxRow {
  return inboxRow({
    id: 'wf-s001',
    source: 'sbir_sttr',
    sourceRecordId: 'TOPIC-9001',
    title: 'Autonomous sustainment diagnostics',
    agency: 'Department of Defense',
    responseDeadline: null,
    daysUntilDeadline: null,
    relevanceScore: 54,
    eligibility: { state: null, reason: null },
    sbir: {
      topicNumber: 'A26-001',
      title: 'Autonomous sustainment diagnostics',
      agency: 'Department of Defense',
      year: 2026,
      solicitationNumber: 'DoD-SBIR-26.A',
      releaseDate: '2025-12-04',
      openDate: '2026-01-06',
      closeDate: '2026-02-04',
      solicitationStatus: 'Open',
      topicUrl: 'https://example.invalid/topic/9001',
      officialSolicitationUrl: 'https://example.invalid/dsip/9001',
      lastSyncedAt: '2026-08-07T02:00:00.000Z',
      cycle: {
        solicitationNumber: 'DoD-SBIR-26.A',
        cycleName: '26.A',
        program: 'SBIR',
        year: 2026,
        startDate: '2026-01-06',
        endDate: '2026-02-04',
        solicitationStatus: 'Open',
        solDownloadUrl: 'https://example.invalid/sol.pdf',
      },
    },
    ...partial,
  });
}

describe('SBIR/STTR topics appear as topics, and only when the capability is on', () => {
  async function openSourceFilter() {
    await screen.findByTestId('fo-inbox');
    const selector = document.querySelector('.fo-inbox__controls .ant-select-selector');
    expect(selector).not.toBeNull();
    fireEvent.mouseDown(selector!);
  }

  test('with the flag ON a topic row renders the TOPIC card, not the opportunity card', async () => {
    flags.funding_opportunities_sbir = true;
    inboxData = inboxResponse({ rows: [sbirInboxRow()] });
    renderPage();
    expect(await screen.findByTestId('fo-sbir-row-A26-001')).toBeInTheDocument();
    expect(screen.queryByTestId('fo-inbox-row-wf-s001')).not.toBeInTheDocument();
  });

  test('the card names the program from the CYCLE', async () => {
    flags.funding_opportunities_sbir = true;
    inboxData = inboxResponse({ rows: [sbirInboxRow()] });
    renderPage();
    expect(await screen.findByTestId('fo-sbir-program')).toHaveTextContent('SBIR');
  });

  test('an ORPHAN topic — cycle not held — says so instead of guessing a program', async () => {
    flags.funding_opportunities_sbir = true;
    const row = sbirInboxRow();
    inboxData = inboxResponse({ rows: [{ ...row, sbir: { ...row.sbir!, cycle: null } }] });
    renderPage();
    expect(await screen.findByTestId('fo-sbir-program-unknown')).toBeInTheDocument();
    expect(screen.getByTestId('fo-sbir-cycle')).toHaveTextContent('Capiro does not hold this cycle');
  });

  test('no action row is rendered — no workflow mutation is wired for a topic', async () => {
    flags.funding_opportunities_sbir = true;
    inboxData = inboxResponse({ rows: [sbirInboxRow()] });
    renderPage();
    await screen.findByTestId('fo-sbir-row-A26-001');
    expect(screen.queryByTestId('fo-sbir-actions')).not.toBeInTheDocument();
  });

  test('with the flag ON the source filter offers the SBIR rail', async () => {
    flags.funding_opportunities_sbir = true;
    renderPage();
    await openSourceFilter();
    expect(await screen.findByTitle('SBIR/STTR')).toBeInTheDocument();
  });

  test('with the flag OFF the rail is not offered', async () => {
    flags.funding_opportunities_sbir = false;
    renderPage();
    await openSourceFilter();
    await screen.findByTitle('SAM.gov');
    expect(screen.queryByTitle('SBIR/STTR')).not.toBeInTheDocument();
  });

  test('with the flag OFF topic rows are withheld, and the page SAYS how many', async () => {
    flags.funding_opportunities_sbir = false;
    inboxData = inboxResponse({
      rows: [inboxRow(), sbirInboxRow()],
      counts: { ...ZERO_COUNTS, needs_review: 2 },
    });
    renderPage();
    expect(await screen.findByTestId('fo-inbox-row-wf-0001')).toBeInTheDocument();
    expect(screen.queryByTestId('fo-sbir-row-A26-001')).not.toBeInTheDocument();
    const notice = screen.getByTestId('fo-inbox-sbir-withheld');
    expect(notice).toHaveTextContent('1 SBIR/STTR topic row not shown');
  });

  /**
   * Two flagged rails can be off at once. A pooled "rows withheld" count would
   * leave a reader unable to tell WHICH capability to ask for.
   */
  test('forecasts and topics withheld together are counted separately', async () => {
    flags.funding_opportunities_forecasts = false;
    flags.funding_opportunities_sbir = false;
    inboxData = inboxResponse({
      rows: [forecastInboxRow(), sbirInboxRow()],
      counts: { ...ZERO_COUNTS, needs_review: 2 },
    });
    renderPage();
    expect(await screen.findByTestId('fo-inbox-forecasts-withheld')).toHaveTextContent(
      '1 agency forecast row not shown',
    );
    expect(screen.getByTestId('fo-inbox-sbir-withheld')).toHaveTextContent(
      '1 SBIR/STTR topic row not shown',
    );
  });

  test('a stale `?source=sbir_sttr` deep link degrades to ALL sources when the flag is off', async () => {
    flags.funding_opportunities_sbir = false;
    urlStore.set('?source=sbir_sttr');
    renderPage();
    await waitFor(() => expect(inboxUrls.length).toBeGreaterThan(0));
    expect(inboxUrls[0]).not.toContain('source=');
  });

  test('a topic ref in the drawer is NOT rendered as a forecast or a bid-board item', async () => {
    flags.funding_opportunities_sbir = true;
    flags.funding_opportunities_forecasts = true;
    inboxData = inboxResponse({ rows: [sbirInboxRow()] });
    urlStore.set(
      `?detail=${encodeURIComponent('sbir_sttr')}:${encodeURIComponent('TOPIC-9001')}:${encodeURIComponent('client-1')}`,
    );
    renderPage();
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('SBIR/STTR topic');
    expect(screen.getByTestId('fo-drawer-sbir-no-detail')).toBeInTheDocument();
    expect(dialog.textContent ?? '').not.toMatch(/forecast|bid-board/i);
  });

  test('a topic row whose source facts are gone stays on the SBIR rail and says so', async () => {
    flags.funding_opportunities_sbir = true;
    inboxData = inboxResponse({ rows: [sbirInboxRow({ sbir: null })] });
    renderPage();
    const card = await screen.findByTestId('fo-sbir-unrenderable-wf-s001');
    expect(card).toHaveTextContent('Capiro no longer holds the topic record');
    expect(card).toHaveTextContent('SBIR/STTR');
    // Never mislabelled as the bid board, which the shared component made easy
    // to get wrong before it took a label.
    expect(card.textContent ?? '').not.toMatch(/DLA bid board/);
  });
});
