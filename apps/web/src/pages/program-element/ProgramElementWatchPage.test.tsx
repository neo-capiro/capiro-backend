import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProgramElementWatchPage } from './ProgramElementWatchPage.js';

vi.mock('./ProgramTeamPanel.js', () => ({
  ProgramTeamPanel: ({ personnel }: { personnel: Array<{ id: string }> }) => (
    <div data-testid="program-team-panel">program-team:{personnel.length}</div>
  ),
}));

vi.mock('./FyHistoryChart.js', () => ({
  FyHistoryChart: ({ rows, onFyClick }: { rows: Array<{ fy: number }>; onFyClick?: (fy: number) => void }) => (
    <div>
      <div data-testid="fy-chart">rows:{rows.length}</div>
      <button type="button" onClick={() => onFyClick?.(rows[0]?.fy ?? 0)}>
        select-fy
      </button>
    </div>
  ),
}));

vi.mock('./BillsTouchingPePanel.js', () => ({
  BillsTouchingPePanel: ({ bills }: { bills: Array<{ id: string }> }) => (
    <div data-testid="bills-panel">bills:{bills.length}</div>
  ),
}));

vi.mock('./ContractorsPanel.js', () => ({
  ContractorsPanel: ({ contractors }: { contractors: { data: Array<{ contractorName: string }> } }) => (
    <div data-testid="contractors-panel">contractors:{contractors.data.length}</div>
  ),
}));

vi.mock('./FyDetailDrawer.js', () => ({
  FyDetailDrawer: ({ open, selectedFy }: { open: boolean; selectedFy: number | null }) => (
    <div data-testid="fy-detail-drawer">
      open:{String(open)} fy:{selectedFy ?? 'null'}
    </div>
  ),
}));

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();

vi.mock('../../lib/use-api.js', () => ({
  useApi: () => ({
    get: apiGetMock,
    post: apiPostMock,
  }),
}));

function detailPayload(currentUserIsWatching: boolean) {
  return {
    peCode: '0603270A',
    title: 'Electronic Warfare Advanced Payloads',
    service: 'Army',
    budgetActivity: 'BA3',
    appropriationType: 'RDT&E',
    status: 'active',
    firstSeenFy: 2023,
    lastSyncedAt: '2026-05-28T15:00:00.000Z',
    currentUserIsWatching,
    years: [
      { id: 'y1', fy: 2023, request: '220.00', hascMark: '230.00', sascMark: '228.00', hacDMark: '229.00', sacDMark: '227.00', conference: '229.00', enacted: '228.50', raw: { sourceAttribution: { request: 'rdoc' } } },
      { id: 'y2', fy: 2024, request: '240.00', hascMark: '245.00', sascMark: '244.00', hacDMark: '243.00', sacDMark: '242.00', conference: '243.00', enacted: '242.00', raw: { sourceAttribution: { request: 'rdoc' } } },
      { id: 'y3', fy: 2025, request: '255.00', hascMark: '258.00', sascMark: '257.00', hacDMark: '256.00', sacDMark: '255.50', conference: '256.00', enacted: '255.00', raw: { sourceAttribution: { request: 'rdoc' } } },
      { id: 'y4', fy: 2026, request: '266.00', hascMark: '269.00', sascMark: '268.00', hacDMark: '267.00', sacDMark: '266.00', conference: '267.00', enacted: '266.50', raw: { sourceAttribution: { request: 'rdoc' } } },
      { id: 'y5', fy: 2027, request: '278.50', hascMark: null, sascMark: null, hacDMark: null, sacDMark: null, conference: null, enacted: null, raw: { sourceAttribution: { request: 'rdoc' } } },
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

function setupApi(currentUserIsWatching: boolean, postImpl?: (url: string, body: { watching: boolean }) => Promise<unknown>) {
  apiGetMock.mockImplementation(async (url: string) => {
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
            { contractorName: 'Acme Dynamics', amount: 1500, awards: 12, contractType: 'IDIQ', contractorIsCrmClient: true, isNewEntrant: false },
          ],
          todo: null,
        },
      };
    }
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
    if (url.includes('/procurement-lines')) {
      return { data: { peCode: '0603270A', years: [], recipients: [], sourceUrl: null, totalRows: 0 } };
    }
    // Most PEs have no computed intelligence verdicts — the endpoint returns null.
    if (url.includes('/intelligence')) return { data: null };
    // Finder list (defensive; the detail page does not call it).
    if (url.includes('/api/program-elements') && !url.includes('/0603270A')) {
      return { data: { data: [], total: 0, page: 1, limit: 25 } };
    }
    return { data: detailPayload(currentUserIsWatching) };
  });

  apiPostMock.mockImplementation(async (url: string, body: { watching: boolean }) => {
    if (postImpl) return postImpl(url, body);
    return { data: { peCode: '0603270A', watching: body.watching } };
  });
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/program-elements/0603270A']}>
        <Routes>
          <Route path="/program-elements/:peCode" element={<ProgramElementWatchPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ProgramElementWatchPage', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    apiPostMock.mockReset();
    setupBrowserMocks();
  });

  test(
    'renders the hero, KPI strip, and tabbed panels',
    async () => {
      setupApi(true);
      renderPage();

      await waitFor(() => expect(screen.getByText(/0603270A/i)).toBeInTheDocument());
      expect(screen.getByText(/Electronic Warfare Advanced Payloads/i)).toBeInTheDocument();
      expect(screen.getByText(/Army/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Watching/i })).toBeInTheDocument();
      // Overview tab (default) shows the funding trajectory chart.
      expect(await screen.findByText(/Funding trajectory/i)).toBeInTheDocument();
      // FY drawer is mounted (outside the tabs) and closed.
      expect(screen.getByTestId('fy-detail-drawer')).toHaveTextContent('open:false fy:null');

      // Funding tab: the interactive FY history chart drives the drawer.
      fireEvent.click(screen.getByRole('tab', { name: /Funding/i }));
      expect(await screen.findByTestId('fy-chart')).toHaveTextContent('rows:5');
      fireEvent.click(screen.getByText('select-fy'));
      expect(screen.getByTestId('fy-detail-drawer')).toHaveTextContent('open:true fy:2023');

      // Legislation tab: bills panel.
      fireEvent.click(screen.getByRole('tab', { name: /Legislation/i }));
      expect(await screen.findByTestId('bills-panel')).toHaveTextContent('bills:1');

      // Contractors tab: contractors panel.
      fireEvent.click(screen.getByRole('tab', { name: /Contractors/i }));
      expect(await screen.findByTestId('contractors-panel')).toHaveTextContent('contractors:1');

      // Team tab: program team panel.
      fireEvent.click(screen.getByRole('tab', { name: /Team/i }));
      expect(await screen.findByTestId('program-team-panel')).toHaveTextContent('program-team:1');
    },
    15000,
  );

  test('watch toggle performs optimistic update and calls POST /watch', async () => {
    setupApi(false);
    renderPage();

    const watchButton = await screen.findByRole('button', { name: /Watch this PE/i });
    fireEvent.click(watchButton);

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledTimes(1);
    });
    expect(apiPostMock).toHaveBeenCalledWith('/api/program-elements/0603270A/watch', { watching: true });
  });

  test('optimistic UI rolls back on POST /watch error', async () => {
    setupApi(false);
    let rejectPost!: (reason?: unknown) => void;
    apiPostMock.mockImplementationOnce(
      async () =>
        await new Promise((_, reject) => {
          rejectPost = reject as (reason?: unknown) => void;
        }),
    );

    renderPage();

    const watchButton = await screen.findByRole('button', { name: /Watch this PE/i });
    fireEvent.click(watchButton);

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Watching/i })).toBeInTheDocument();
    });

    rejectPost(new Error('network failed'));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Watch this PE/i })).toBeInTheDocument();
    });
  });
});
