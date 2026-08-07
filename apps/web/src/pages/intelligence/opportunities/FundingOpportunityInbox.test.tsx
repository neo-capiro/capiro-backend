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
vi.mock('react-router-dom', async () => {
  const React = await import('react');
  return {
    useSearchParams: () => {
      const search = React.useSyncExternalStore(urlStore.subscribe, urlStore.get, urlStore.get);
      return [new URLSearchParams(search), setSearchParamsMock];
    },
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
