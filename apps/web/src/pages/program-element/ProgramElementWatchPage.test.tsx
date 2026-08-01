import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProgramElementWatchPage } from './ProgramElementWatchPage.js';

vi.mock('./FyHistoryChart.js', () => ({
  FyHistoryChart: ({ rows }: { rows: Array<{ fy: number }> }) => (
    <div data-testid="fy-chart">rows:{rows.length}</div>
  ),
}));
vi.mock('./BillsTouchingPePanel.js', () => ({
  BillsTouchingPePanel: ({
    bills,
    billActionsErrored,
  }: {
    bills: Array<{ id: string }>;
    billActionsErrored?: boolean;
  }) =>
    billActionsErrored ? (
      <div data-testid="pe-secondary-failed-bill-actions">
        Failed to load bill action history
      </div>
    ) : (
      <div data-testid="bills-panel">bills:{bills.length}</div>
    ),
}));
vi.mock('./ContractorsPanel.js', () => ({
  ContractorsPanel: ({
    contractors,
    errored,
  }: {
    contractors?: { data: Array<{ contractorName: string }> };
    errored?: boolean;
  }) =>
    errored ? (
      <div data-testid="pe-secondary-failed-contractors">contractors failed</div>
    ) : (
      <div data-testid="contractors-panel">
        contractors:{contractors?.data.length ?? 0}
      </div>
    ),
}));
vi.mock('./ProgramTeamPanel.js', () => ({
  ProgramTeamPanel: ({
    personnel,
    errored,
  }: {
    personnel: Array<{ id: string }>;
    errored?: boolean;
  }) =>
    errored ? (
      <div data-testid="pe-secondary-failed-personnel-roster">personnel failed</div>
    ) : (
      <div data-testid="program-team-panel">program-team:{personnel.length}</div>
    ),
}));
vi.mock('./FundingNarrativePanel.js', () => ({
  FundingNarrativePanel: ({ errored }: { errored?: boolean }) =>
    errored ? (
      <div data-testid="pe-secondary-failed-narrative">narrative failed</div>
    ) : (
      <div data-testid="funding-narrative">narrative</div>
    ),
}));
vi.mock('./ProvisionsPanel.js', () => ({
  ProvisionsPanel: ({ errored }: { errored?: boolean }) =>
    errored ? (
      <div data-testid="pe-secondary-failed-provisions">provisions failed</div>
    ) : (
      <div data-testid="provisions-panel">provisions</div>
    ),
}));
vi.mock('./SecondaryDistributionPanel.js', () => ({
  SecondaryDistributionPanel: ({ errored }: { errored?: boolean }) =>
    errored ? (
      <div data-testid="pe-secondary-failed-procurement-lines">
        procurement failed
      </div>
    ) : (
      <div data-testid="procurement-panel">procurement</div>
    ),
}));
vi.mock('./BudgetLinePanels.js', () => ({
  BudgetActionsFeed: ({ errored }: { errored?: boolean }) =>
    errored ? (
      <div data-testid="pe-secondary-failed-actions">actions failed</div>
    ) : (
      <div data-testid="budget-actions">actions</div>
    ),
  RelationshipGraphPanel: ({ errored }: { errored?: boolean }) =>
    errored ? (
      <div data-testid="pe-secondary-failed-linked-lines">relationships failed</div>
    ) : (
      <div data-testid="relationships-panel">relationships</div>
    ),
  MaturityLadderPanel: ({ errored }: { errored?: boolean }) =>
    errored ? (
      <div data-testid="pe-secondary-failed-intelligence-maturity">
        intelligence failed
      </div>
    ) : (
      <div data-testid="maturity-panel">maturity</div>
    ),
  AppropriabilityPanel: ({ errored }: { errored?: boolean }) =>
    errored ? (
      <div data-testid="pe-secondary-failed-intelligence-appropriability">
        intelligence failed
      </div>
    ) : (
      <div data-testid="appropriability-panel">appropriability</div>
    ),
  IncumbentMapPanel: ({ errored }: { errored?: boolean }) =>
    errored ? (
      <div data-testid="pe-secondary-failed-incumbents">incumbents failed</div>
    ) : (
      <div data-testid="incumbents-panel">incumbents</div>
    ),
}));

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();

vi.mock('../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock, post: apiPostMock }),
}));

function detailPayload(currentUserIsWatching: boolean, currentCycleFy = 2027) {
  return {
    peCode: '0603270A',
    title: 'Electronic Warfare Advanced Payloads',
    description: 'Develops advanced electronic warfare payloads.',
    service: 'ARMY',
    budgetActivity: 'BA3',
    appropriationType: 'RDT&E',
    status: 'active',
    firstSeenFy: 2023,
    lastSyncedAt: '2026-05-28T15:00:00.000Z',
    currentUserIsWatching,
    currentCycleFy,
    projectCount: 1,
    sourceCount: 3,
    billCount: 1,
    years: [
      { id: 'y1', fy: 2023, request: '220', hascMark: '230', sascMark: '228', hacDMark: '229', sacDMark: '227', conference: '229', enacted: '228.5' },
      { id: 'y2', fy: 2024, request: '240', hascMark: '245', sascMark: '244', hacDMark: '243', sacDMark: '242', conference: '243', enacted: '242' },
      { id: 'y3', fy: 2025, request: '255', hascMark: '258', sascMark: '257', hacDMark: '256', sacDMark: '255.5', conference: '256', enacted: '255' },
      { id: 'y4', fy: 2026, request: '266', hascMark: '269', sascMark: '268', hacDMark: '267', sacDMark: '266', conference: '267', enacted: '266.5' },
      { id: 'y5', fy: 2027, request: '278.5', hascMark: null, sascMark: null, hacDMark: null, sacDMark: null, conference: null, enacted: null },
    ],
  };
}

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
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
}

function setupApi(currentUserIsWatching: boolean, currentCycleFy = 2027) {
  apiGetMock.mockImplementation(async (url: string) => {
    if (url === '/api/intelligence/actions') {
      return { data: { data: [], total: 0, page: 1, limit: 100 } };
    }
    if (url.includes('/client-relevance')) return { data: [] };
    if (url.includes('/personnel')) {
      return {
        data: [
          {
            id: 'person-1',
            fullName: 'COL Jane Doe',
            service: 'ARMY',
            organization: 'PEO Aviation',
            title: 'PEO Aviation',
            role: 'PEO',
            pePrimary: '0603270A',
            peSecondary: [],
            confidence: 0.96,
            status: 'active',
            firstSeenAt: '2026-01-01T00:00:00.000Z',
            lastSeenAt: '2026-01-15T00:00:00.000Z',
            sourceCount: 3,
          },
        ],
      };
    }
    if (url.includes('/contractors')) {
      return {
        data: {
          data: [
            {
              contractorName: 'Acme Dynamics',
              amount: 1500,
              awards: 12,
              contractType: 'IDIQ',
              contractorIsCrmClient: true,
              isNewEntrant: false,
            },
          ],
          todo: null,
        },
      };
    }
    if (url.includes('/bill-actions')) return { data: [] };
    if (url.includes('/bills')) {
      return {
        data: [
          {
            id: 'HR-123',
            congress: 119,
            billType: 'HR',
            billNumber: '123',
            title: 'Focused bill touching this PE',
            policyArea: null,
            latestActionText: null,
            latestActionDate: null,
            url: null,
            sponsor: 'Rep. Doe',
            committee: 'Armed Services',
            passageProbability: 0.75,
          },
        ],
      };
    }
    if (url.includes('/projects')) return { data: [] };
    if (url.includes('/related')) return { data: { related: [], todo: null } };
    if (url.includes('/provisions')) return { data: [] };
    if (url.includes('/opportunities')) return { data: [] };
    if (url.includes('/sources')) return { data: [] };
    if (url.includes('/deltas')) {
      return { data: { data: [], total: 0, page: 1, limit: 25 } };
    }
    if (url.includes('/narrative')) {
      return {
        data: {
          peCode: '0603270A',
          currentCycleFy: 2027,
          steps: [],
          materiality: [],
        },
      };
    }
    if (url.includes('/actions')) return { data: [] };
    if (url.includes('/relationships')) return { data: [] };
    if (url.includes('/incumbents')) return { data: [] };
    if (url.includes('/programs')) return { data: [] };
    if (url.includes('/procurement-lines')) {
      return {
        data: {
          peCode: '0603270A',
          years: [],
          recipients: [],
          sourceUrl: null,
          totalRows: 0,
        },
      };
    }
    if (url.includes('/intelligence')) return { data: null };
    return { data: detailPayload(currentUserIsWatching, currentCycleFy) };
  });
  apiPostMock.mockResolvedValue({
    data: { peCode: '0603270A', watching: !currentUserIsWatching },
  });
}

function renderPage(initialPath = '/program-elements/0603270A') {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route
            path="/program-elements/:peCode"
            element={<ProgramElementWatchPage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function failEndpoint(fragment: string) {
  const base = apiGetMock.getMockImplementation()!;
  apiGetMock.mockImplementation(async (url: string) => {
    if (String(url).includes(fragment)) {
      const error = new Error(`${fragment} failed`) as Error & {
        response?: { status: number };
      };
      error.response = { status: 500 };
      throw error;
    }
    return base(url);
  });
}

describe('ProgramElementWatchPage final redesign', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    setupBrowserMocks();
  });

  test('renders the approved hero and six profile sections', async () => {
    setupApi(true);
    renderPage();

    expect(await screen.findByText('Electronic Warfare Advanced Payloads')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Monitoring/i })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(6);
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByText(/Funding by fiscal year/i)).toBeInTheDocument();
    expect(screen.getByTestId('pe-trust-header')).toBeInTheDocument();
  });

  test('loads the approved grouped sections without removing existing panels', async () => {
    setupApi(true);
    renderPage();
    await screen.findByTestId('pe-trust-header');

    fireEvent.click(screen.getByRole('tab', { name: 'Funding & movement' }));
    expect(await screen.findByTestId('fy-chart')).toHaveTextContent('rows:5');

    fireEvent.click(screen.getByRole('tab', { name: 'Legislative' }));
    expect(await screen.findByTestId('bills-panel')).toHaveTextContent('bills:1');

    fireEvent.click(screen.getByRole('tab', { name: 'Ecosystem' }));
    // Contractors query is cold until Ecosystem is selected — wait for load,
    // not just panel mount (mounts immediately with contractors:0 while loading).
    await waitFor(() =>
      expect(screen.getByTestId('contractors-panel')).toHaveTextContent(
        'contractors:1',
      ),
    );
    expect(screen.getByTestId('program-team-panel')).toHaveTextContent(
      'program-team:1',
    );
  });

  test('monitor uses the existing watch mutation', async () => {
    setupApi(false);
    renderPage();
    // Ant icon prefixes accessible name ("bell Monitor"); match trailing label.
    const monitor = await screen.findByRole('button', { name: /Monitor$/i });
    fireEvent.click(monitor);
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith(
        '/api/program-elements/0603270A/watch',
        { watching: true },
      ),
    );
  });

  test('shows the historical coverage badge without changing funding data', async () => {
    setupApi(true, 2029);
    renderPage();
    expect(
      await screen.findByText(/Historical — no FY2029 entry/i),
    ).toBeInTheDocument();
  });

  test('detail failure remains a failure state with retry', async () => {
    apiGetMock.mockRejectedValue({ response: { status: 500 } });
    renderPage();
    expect(await screen.findByTestId('pe-state-failed')).toBeInTheDocument();
    expect(screen.getByTestId('pe-state-retry')).toBeInTheDocument();
  });

  test('overview secondary failure is partial and never rendered as a valid empty', async () => {
    setupApi(true);
    failEndpoint('/personnel');
    renderPage();
    expect(await screen.findByText('Partial data')).toBeInTheDocument();
    expect(
      screen.getByTestId('pe-secondary-failed-personnel-roster'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/No verified public program-team contacts yet/i),
    ).not.toBeInTheDocument();
  });

  test('funding and legislative failures remain explicit in the new sections', async () => {
    setupApi(true);
    failEndpoint('/narrative');
    renderPage();
    await screen.findByTestId('pe-trust-header');
    fireEvent.click(screen.getByRole('tab', { name: 'Funding & movement' }));
    expect(await screen.findByText('Partial data')).toBeInTheDocument();
    expect(screen.getByTestId('pe-secondary-failed-narrative')).toBeInTheDocument();
  });

  test('hidden heavy sections stay cold until selected', async () => {
    setupApi(true);
    renderPage();
    await screen.findByTestId('pe-trust-header');
    const initialUrls = apiGetMock.mock.calls.map((call) => String(call[0]));
    expect(initialUrls.some((url) => url.includes('/sources'))).toBe(false);
    expect(initialUrls.some((url) => url.includes('/contractors'))).toBe(false);
    expect(initialUrls.some((url) => url.includes('/projects'))).toBe(false);

    fireEvent.click(screen.getByRole('tab', { name: 'Program structure' }));
    await waitFor(() => {
      const urls = apiGetMock.mock.calls.map((call) => String(call[0]));
      expect(urls.some((url) => url.includes('/projects'))).toBe(true);
      expect(urls.some((url) => url.includes('/relationships'))).toBe(true);
    });
  });
});
