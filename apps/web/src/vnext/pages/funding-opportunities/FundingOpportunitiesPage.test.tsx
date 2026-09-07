import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FundingOpportunitiesPage } from './FundingOpportunitiesPage.js';
import {
  INBOX_FILTERS,
  type InboxResponse,
  type InboxRow,
} from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';

const { flags, urlStore, apiGet, apiPost, success, error } = vi.hoisted(() => ({
  flags: {} as Record<string, boolean>,
  apiGet: vi.fn(),
  apiPost: vi.fn(),
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
vi.mock('../../../lib/intel-feature-flags.js', () => ({
  useIntelFeature: (feature: string) => ({
    enabled: flags[feature] === true,
    ready: true,
  }),
}));
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGet, post: apiPost }),
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
vi.mock('./FundingOpportunityExplore.js', () => ({
  FundingOpportunityExplore: ({ clientId }: { clientId?: string }) => (
    <div data-testid="fo-explore">Browse for {clientId ?? 'all'}</div>
  ),
}));
vi.mock('./FundingOpportunityPipeline.js', () => ({
  FundingOpportunityPipeline: () => <div data-testid="fo-pipeline">Pursuit board</div>,
}));
vi.mock('./FundingOpportunityDrawer.js', () => ({
  FundingOpportunityDrawer: ({ refValue }: { refValue: unknown }) =>
    refValue ? <div data-testid="fo-drawer">{JSON.stringify(refValue)}</div> : null,
}));

function row(overrides: Partial<InboxRow> = {}): InboxRow {
  return {
    id: 'row-1',
    client: { id: 'client-1', name: 'Acme Defense' },
    source: 'sam_gov',
    sourceRecordId: 'notice-1',
    title: 'Engine maintenance',
    agency: 'Army',
    forecast: null,
    dibbs: null,
    sbir: null,
    responseDeadline: '2026-10-01',
    daysUntilDeadline: 25,
    workflowStatus: 'suggested',
    humanDecision: null,
    nextAction: null,
    nextActionDueAt: null,
    owner: null,
    relevanceScore: 65,
    eligibility: { state: null, reason: null },
    noLongerSuggested: false,
    sourceClosed: false,
    updatedAt: '2026-09-06T00:00:00Z',
    matchSignals: [
      {
        signal: 'capabilityKeyword',
        matchedOn: 'engine maintenance',
        weight: 20,
        strength: 'strong',
      },
    ],
    pipelineStage: null,
    ...overrides,
  };
}
function response(overrides: Partial<InboxResponse> = {}): InboxResponse {
  return {
    filter: 'suggested',
    clientId: null,
    source: null,
    rows: [],
    nextCursor: null,
    pageSize: 50,
    counts: Object.fromEntries(
      INBOX_FILTERS.map((filter) => [filter, 0]),
    ) as InboxResponse['counts'],
    countsAllClients: null,
    countsUnavailableReason: null,
    generatedAt: '2026-09-06T00:00:00Z',
    ...overrides,
  };
}
let current: InboxResponse;
function mount() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={qc}>
      <FundingOpportunitiesPage />
    </QueryClientProvider>,
  );
  return qc;
}
beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(flags)) delete flags[key];
  flags.funding_opportunities = true;
  flags.funding_opportunities_client_inbox = true;
  urlStore.set('');
  current = response();
  apiPost.mockResolvedValue({ data: {} });
  apiGet.mockImplementation(async (path: string) => {
    if (path === '/api/clients')
      return {
        data: [
          { id: 'client-1', name: 'Acme Defense' },
          { id: 'client-2', name: 'Beta Systems' },
        ],
      };
    if (path.includes('/inbox?')) return { data: current };
    return { data: { freshness: [] } };
  });
});
afterEach(cleanup);

describe('simple vNext navigation', () => {
  test('Recommended is the default and requests only new suggestions', async () => {
    mount();
    expect(
      await screen.findByRole('tab', { name: 'Recommended', selected: true }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('filter=suggested&sort=updated')),
    );
    expect(screen.getByRole('heading', { name: 'Funding Opportunities' })).toBeInTheDocument();
    expect(screen.queryByText('Triage inbox')).not.toBeInTheDocument();
  });
  test('Browse remains explicit in URLs and preserves the client', async () => {
    urlStore.set('view=inbox&clientId=client-1');
    current = response({ clientId: 'client-1' });
    mount();
    fireEvent.click(await screen.findByRole('tab', { name: 'Browse' }));
    expect(urlStore.get()).toContain('view=explore');
    expect(urlStore.get()).toContain('clientId=client-1');
    expect(await screen.findByTestId('fo-explore')).toHaveTextContent('client-1');
  });
  test('an old explicit Explore link stays in Browse', async () => {
    urlStore.set('view=explore&tab=saved&clientId=client-1');
    mount();
    expect(await screen.findByRole('tab', { name: 'Browse', selected: true })).toBeInTheDocument();
  });
  test('unavailable recommendations fall back to Browse with an explanation', async () => {
    flags.funding_opportunities_client_inbox = false;
    mount();
    expect(await screen.findByTestId('fo-explore')).toBeInTheDocument();
    expect(screen.getByText(/Recommendations and tracking are not enabled/)).toBeInTheDocument();
    expect(apiGet.mock.calls.some(([path]) => String(path).includes('/inbox'))).toBe(false);
  });
  test('Tracking defaults to Show All and fetches the cross-client inbox', async () => {
    urlStore.set('view=pipeline');
    mount();
    expect(await screen.findByTestId('fo-tracking')).toBeInTheDocument();
    const selector = screen
      .getAllByRole('combobox', { name: 'Client' })
      .find((el) => (el as HTMLSelectElement).value === '')!;
    expect(selector).toBeDefined();
    // The Show All option is the first entry in the dropdown.
    expect((selector as HTMLSelectElement).options[0]?.text).toBe('Show all clients');
    // The inbox is queried without a clientId so every tracked client appears.
    expect(
      apiGet.mock.calls.some(
        ([path]) => String(path).includes('/inbox') && !String(path).includes('clientId='),
      ),
    ).toBe(true);
  });
  test('switching to Tracking clears a pinned client (Show All is the landing state)', async () => {
    urlStore.set('view=inbox&clientId=client-1');
    current = response({ clientId: 'client-1' });
    mount();
    fireEvent.click(await screen.findByRole('tab', { name: 'Tracking' }));
    expect(urlStore.get()).toContain('view=pipeline');
    expect(urlStore.get()).not.toContain('clientId=');
  });
  test('leaving Tracking for Recommended keeps the pinned client', async () => {
    urlStore.set('view=pipeline&clientId=client-1');
    current = response({ clientId: 'client-1' });
    mount();
    fireEvent.click(await screen.findByRole('tab', { name: 'Recommended' }));
    expect(urlStore.get()).toContain('view=inbox');
    expect(urlStore.get()).toContain('clientId=client-1');
  });
  test('Tracking is list first and saved items need no pipeline stage or board flag', async () => {
    urlStore.set('view=pipeline&clientId=client-1');
    current = response({
      clientId: 'client-1',
      rows: [
        row({
          workflowStatus: 'saved',
          nextAction: 'Discuss with capture lead',
          nextActionDueAt: '2026-09-10T00:00:00Z',
        }),
      ],
    });
    mount();
    expect(await screen.findByTestId('fo-tracking')).toBeInTheDocument();
    expect(await screen.findByText('No stage recorded')).toBeInTheDocument();
    expect(screen.getByText('Discuss with capture lead')).toBeInTheDocument();
    expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('filter=tracked'));
    expect(screen.queryByTestId('fo-pipeline')).not.toBeInTheDocument();
  });
  test('a leftover recommendation filter cannot show untracked suggestions in Tracking', async () => {
    urlStore.set('view=pipeline&clientId=client-1&filter=suggested');
    current = response({ clientId: 'client-1' });
    mount();
    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('filter=tracked')),
    );
    expect(apiGet.mock.calls.some(([path]) => String(path).includes('filter=suggested'))).toBe(
      false,
    );
  });
  test('Due soon in Tracking uses tracked follow-ups instead of the whole deadline queue', async () => {
    urlStore.set('view=pipeline&clientId=client-1');
    current = response({ clientId: 'client-1' });
    mount();
    fireEvent.change(await screen.findByLabelText('Tracked opportunities'), {
      target: { value: 'tracked_deadlines' },
    });
    await waitFor(() =>
      expect(apiGet).toHaveBeenCalledWith(expect.stringContaining('filter=tracked_deadlines')),
    );
  });
});

describe('useful and correctly scoped recommendations', () => {
  test('funding priority reasons name the actual phrase and keep grant eligibility separate', async () => {
    current = response({
      rows: [
        row({
          source: 'grants_gov',
          eligibility: { state: 'eligible', reason: 'Organization type matches.' },
          matchSignals: [
            {
              signal: 'applicantType',
              matchedOn: 'County governments',
              strength: 'weak',
              weight: 25,
            },
            { signal: 'stateRestriction', matchedOn: 'VA', strength: 'weak', weight: 15 },
            {
              signal: 'capabilityKeyword',
              source: 'funding_priority',
              matchedOn: 'rural broadband deployment',
              strength: 'moderate',
              weight: 15,
            },
          ],
        }),
      ],
    });
    mount();
    const card = await screen.findByTestId('fo-inbox-row-row-1');
    expect(
      within(card).getByText('Funding priority match: rural broadband deployment'),
    ).toBeInTheDocument();
    expect(within(card).getByText('Last assessed eligibility')).toBeInTheDocument();
    expect(within(card).getByText('Last assessed match')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'View current match' })).toBeInTheDocument();
    expect(within(card).queryByText(/County governments/)).not.toBeInTheDocument();
    expect(within(card).queryByText(/Restricted to a state/)).not.toBeInTheDocument();
    expect(within(card).queryByText(/Capability match/)).not.toBeInTheDocument();
  });

  test('an eligibility-only saved row does not claim a reason it matched', async () => {
    current = response({
      rows: [
        row({
          matchSignals: [
            {
              signal: 'applicantType',
              matchedOn: 'Small businesses',
              strength: 'weak',
              weight: 25,
            },
            { signal: 'stateRestriction', matchedOn: 'VA', strength: 'weak', weight: 0 },
          ],
        }),
      ],
    });
    mount();
    const card = await screen.findByTestId('fo-inbox-row-row-1');
    expect(within(card).queryByText('Why it matched')).not.toBeInTheDocument();
    expect(
      within(card).getByText('Review the source details and client requirements before deciding.'),
    ).toBeInTheDocument();
  });

  test('each row names its client and displays recorded fit reasons instead of a percent', async () => {
    current = response({
      rows: [row(), row({ id: 'row-2', client: { id: 'client-2', name: 'Beta Systems' } })],
    });
    mount();
    expect(
      await screen.findByRole('button', { name: 'Show only Acme Defense' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show only Beta Systems' })).toBeInTheDocument();
    expect(screen.getAllByText('Capability match: engine maintenance')).toHaveLength(2);
    expect(screen.queryByText('65% fit')).not.toBeInTheDocument();
  });
  test('a client scope rejection never puts another client beneath the requested heading', async () => {
    urlStore.set('view=inbox&clientId=client-1');
    current = response({
      clientId: null,
      rows: [row({ client: { id: 'client-2', name: 'Beta Systems' } })],
    });
    mount();
    expect(await screen.findByText('That client filter could not be applied')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Show only Beta Systems' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear client filter' }));
    expect(
      await screen.findByRole('button', { name: 'Show only Beta Systems' }),
    ).toBeInTheDocument();
  });
  test('Save uses the row client and refetches recommendations after the server succeeds', async () => {
    current = response({
      rows: [row({ client: { id: 'client-2', name: 'Beta Systems' } })],
    });
    apiPost.mockImplementation(async () => {
      current = response();
      return { data: {} };
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        '/api/intelligence/clients/client-2/opportunities/sam_gov/notice-1/save',
        { status: 'saved' },
      ),
    );
    await waitFor(() => expect(screen.queryByText('Engine maintenance')).not.toBeInTheDocument());
    expect(success).toHaveBeenCalledWith('Saved for Beta Systems. Find it in Tracking.');
  });
  test('forecast timing is estimated and can be saved without a pursuit action', async () => {
    flags.funding_opportunities_forecasts = true;
    urlStore.set('source=agency_forecast');
    current = response({
      rows: [
        row({
          source: 'agency_forecast',
          responseDeadline: null,
          forecast: {
            anticipatedAwardDate: '2027-03-01',
            anticipatedSolicitationDate: null,
            estimatedPeriod: null,
            fiscalYear: 2027,
            sourceSystem: 'APFS',
            status: null,
            isActive: true,
            lastSyncedAt: '2026-09-06T00:00:00Z',
            providerModifiedAt: null,
          },
        }),
      ],
    });
    mount();
    const card = await screen.findByTestId('fo-inbox-row-row-1');
    expect(within(card).getByText('Estimated award')).toBeInTheDocument();
    expect(card).toHaveTextContent('Agency planning estimate');
    expect(within(card).queryByText('Eligibility')).not.toBeInTheDocument();
    expect(within(card).queryByText('Response deadline')).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Pursue' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Sort opportunities')).toBeDisabled();
  });
  test('an empty page with a next cursor remains navigable', async () => {
    urlStore.set('cursor=old-cursor');
    current = response({ nextCursor: 'new-cursor' });
    mount();
    expect(await screen.findByText('No results on this page')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(urlStore.get()).toContain('cursor=new-cursor'));
    expect(await screen.findByRole('button', { name: 'Previous' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await waitFor(() => expect(urlStore.get()).toContain('cursor=old-cursor'));
  });
  test('the drawer uses the selected row identity and client', async () => {
    current = response({
      rows: [row({ client: { id: 'client-2', name: 'Beta Systems' } })],
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'View details' }));
    expect(await screen.findByTestId('fo-drawer')).toHaveTextContent('client-2');
  });
  test('Refresh waits for active requests before reporting success', async () => {
    mount();
    await screen.findByTestId('fo-inbox-empty');
    let finish: (() => void) | undefined;
    apiGet.mockImplementation((path: string) =>
      path.includes('/inbox?')
        ? new Promise((resolve) => {
            finish = () => resolve({ data: current });
          })
        : Promise.resolve({ data: { freshness: [] } }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(finish).toBeDefined());
    expect(success).not.toHaveBeenCalled();
    finish!();
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith('Current opportunity records refreshed.'),
    );
  });
});
