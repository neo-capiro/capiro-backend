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

function detailPayload(currentUserIsWatching: boolean, currentCycleFy: number | null = null) {
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
    currentCycleFy,
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

function setupApi(
  currentUserIsWatching: boolean,
  postImpl?: (url: string, body: { watching: boolean }) => Promise<unknown>,
  currentCycleFy: number | null = null,
) {
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
        if (url.includes('/sources')) return { data: [] };
        if (url.includes('/deltas')) return { data: { data: [], total: 0, page: 1, limit: 25 } };
        if (url.includes('/narrative')) return { data: { peCode: '0603270A', currentCycleFy: 2027, steps: [], materiality: [] } };
        if (url.includes('/actions')) return { data: [] };
        if (url.includes('/relationships')) return { data: [] };
        if (url.includes('/incumbents')) return { data: [] };
        if (url.includes('/programs')) return { data: [] };
        if (url.includes('/procurement-lines')) {
          return { data: { peCode: '0603270A', years: [], recipients: [], sourceUrl: null, totalRows: 0 } };
        }
        // Most PEs have no computed intelligence verdicts — the endpoint returns null.
        if (url.includes('/intelligence')) return { data: null };
        // Finder list (defensive; the detail page does not call it).
        if (url.includes('/api/program-elements') && !url.includes('/0603270A')) {
          return { data: { data: [], total: 0, page: 1, limit: 25 } };
        }
        return { data: detailPayload(currentUserIsWatching, currentCycleFy) };
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

      // Incumbents tab (BL-2, was Contractors): incumbent map + contractors panel.
            fireEvent.click(screen.getByRole('tab', { name: /Incumbents/i }));
            await waitFor(() => {
              expect(screen.getByTestId('contractors-panel')).toHaveTextContent('contractors:1');
            });

            // People & office tab (BL-2, was Team): program team panel.
            fireEvent.click(screen.getByRole('tab', { name: /People & office/i }));
            await waitFor(() => {
              expect(screen.getByTestId('program-team-panel')).toHaveTextContent('program-team:1');
            });
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

  test('shows the historical badge when the PE has no entry in the current cycle', async () => {
    // The mock PE's latest real budget-year row is FY2027; a currentCycleFy of
    // FY2029 (later than that) means it dropped out of the current cycle.
    setupApi(true, undefined, 2029);
    renderPage();

    await waitFor(() => expect(screen.getByText(/0603270A/i)).toBeInTheDocument());
    expect(screen.getByText(/Historical — no FY2029 entry/i)).toBeInTheDocument();
  });

  test('does not show the historical badge when the PE is in the current cycle', async () => {
      // currentCycleFy matches the mock PE's own latest real year (FY2027).
      setupApi(true, undefined, 2027);
      renderPage();

      await waitFor(() => expect(screen.getByText(/0603270A/i)).toBeInTheDocument());
      expect(screen.queryByText(/Historical —/i)).not.toBeInTheDocument();
    });

    test('trust header is present and failed load is not empty catalog', async () => {
      setupApi(true, undefined, 2027);
      renderPage();
      await waitFor(() => expect(screen.getByTestId('pe-trust-header')).toBeInTheDocument());
      expect(screen.getByTestId('pe-trust-fy')).toBeInTheDocument();
      expect(screen.getByTestId('pe-trust-copy-claim')).toBeInTheDocument();

      apiGetMock.mockReset();
      apiGetMock.mockRejectedValue({ response: { status: 500 } });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/program-elements/0603270A']}>
            <Routes>
              <Route path="/program-elements/:peCode" element={<ProgramElementWatchPage />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('pe-state-failed')).toBeInTheDocument());
      expect(screen.getByTestId('pe-state-retry')).toBeInTheDocument();
      expect(screen.queryByText(/No budget-year data has been synced/i)).not.toBeInTheDocument();
    });

    test('initial overview render does not fetch hidden-tab endpoints', async () => {
            setupApi(true, undefined, 2027);
            renderPage();
            await waitFor(() => expect(screen.getByTestId('pe-trust-header')).toBeInTheDocument());
            const urls = apiGetMock.mock.calls.map((c) => String(c[0]));
            expect(urls.some((u) => /\/api\/program-elements\/0603270A(?:\?|$)/.test(u))).toBe(true);
            // Hidden tabs must stay cold on first paint.
            expect(urls.some((u) => u.includes('/sources'))).toBe(false);
            expect(urls.some((u) => u.includes('/personnel'))).toBe(false);
            expect(urls.some((u) => u.includes('/contractors'))).toBe(false);
            expect(urls.some((u) => u.includes('/provisions'))).toBe(false);

            fireEvent.click(screen.getByRole('tab', { name: /People & office/i }));
            await waitFor(() => {
              const after = apiGetMock.mock.calls.map((c) => String(c[0]));
              expect(after.some((u) => u.includes('/personnel'))).toBe(true);
            });
          });

      test('personnel secondary isError shows failed UI, not success empty', async () => {
        setupApi(true, undefined, 2027);
        const baseImpl = apiGetMock.getMockImplementation()!;
        apiGetMock.mockImplementation(async (url: string) => {
          if (String(url).includes('/personnel')) {
            const err = new Error('personnel boom') as Error & { response?: { status: number } };
            err.response = { status: 500 };
            throw err;
          }
          return baseImpl(url);
        });
        renderPage();
        await waitFor(() => expect(screen.getByTestId('pe-trust-header')).toBeInTheDocument());
        fireEvent.click(screen.getByRole('tab', { name: /People & office/i }));
            // Charts on the team tab are not mocked — they must show failed UI, not "No identified personnel".
            await waitFor(() => {
              expect(screen.getByTestId('pe-secondary-failed-personnel-roster')).toBeInTheDocument();
            });
            expect(screen.getByTestId('pe-secondary-failed-personnel-confidence')).toBeInTheDocument();
            expect(screen.queryByText(/No identified personnel yet/i)).not.toBeInTheDocument();
            // Partial surface banner from enabled secondary failure.
            expect(screen.getByText(/Partial data/i)).toBeInTheDocument();
            expect(screen.getAllByTestId('pe-secondary-retry').length).toBeGreaterThan(0);
          });

      test('provisions secondary isError shows failed UI, not empty congressional language', async () => {
        setupApi(true, undefined, 2027);
        const baseImpl = apiGetMock.getMockImplementation()!;
        apiGetMock.mockImplementation(async (url: string) => {
          if (String(url).includes('/provisions')) {
            const err = new Error('provisions boom') as Error & { response?: { status: number } };
            err.response = { status: 503 };
            throw err;
          }
          return baseImpl(url);
        });
        renderPage();
        await waitFor(() => expect(screen.getByTestId('pe-trust-header')).toBeInTheDocument());
        fireEvent.click(screen.getByRole('tab', { name: /Legislation/i }));
        await waitFor(() => {
          expect(screen.getByTestId('pe-secondary-failed-provisions')).toBeInTheDocument();
        });
        expect(
          screen.queryByText(/No congressional report language linked to this PE yet/i),
        ).not.toBeInTheDocument();
        expect(screen.getByText(/Partial data/i)).toBeInTheDocument();
      });

      test('B8 overview actions 500 shows failed UI, not budget-actions Empty', async () => {
        setupApi(true, undefined, 2027);
        const baseImpl = apiGetMock.getMockImplementation()!;
        apiGetMock.mockImplementation(async (url: string) => {
          if (String(url).includes('/actions')) {
            const err = new Error('actions boom') as Error & { response?: { status: number } };
            err.response = { status: 500 };
            throw err;
          }
          return baseImpl(url);
        });
        renderPage();
        await waitFor(() => expect(screen.getByTestId('pe-trust-header')).toBeInTheDocument());
        await waitFor(() => {
          expect(screen.getByTestId('pe-secondary-failed-actions')).toBeInTheDocument();
        });
        expect(screen.queryByText(/No recorded budget actions/i)).not.toBeInTheDocument();
        expect(screen.getByText(/Partial data/i)).toBeInTheDocument();
        expect(screen.getAllByTestId('pe-secondary-retry').length).toBeGreaterThan(0);
      });

      test('B9 overview relationships 500 shows failed UI, not linked-lines Empty', async () => {
        setupApi(true, undefined, 2027);
        const baseImpl = apiGetMock.getMockImplementation()!;
        apiGetMock.mockImplementation(async (url: string) => {
          if (String(url).includes('/relationships')) {
            const err = new Error('relationships boom') as Error & { response?: { status: number } };
            err.response = { status: 500 };
            throw err;
          }
          return baseImpl(url);
        });
        renderPage();
        await waitFor(() => expect(screen.getByTestId('pe-trust-header')).toBeInTheDocument());
        await waitFor(() => {
          expect(screen.getByTestId('pe-secondary-failed-linked-lines')).toBeInTheDocument();
        });
        expect(screen.queryByText(/No linked lines yet/i)).not.toBeInTheDocument();
        expect(screen.getByText(/Partial data/i)).toBeInTheDocument();
      });

      test('B10 overview bills 500 shows recent-activity failed UI, not dated Empty', async () => {
        setupApi(true, undefined, 2027);
        const baseImpl = apiGetMock.getMockImplementation()!;
        apiGetMock.mockImplementation(async (url: string) => {
          if (String(url).includes('/bills')) {
            const err = new Error('bills boom') as Error & { response?: { status: number } };
            err.response = { status: 500 };
            throw err;
          }
          return baseImpl(url);
        });
        renderPage();
        await waitFor(() => expect(screen.getByTestId('pe-trust-header')).toBeInTheDocument());
        await waitFor(() => {
          expect(screen.getByTestId('pe-secondary-failed-recent-activity')).toBeInTheDocument();
        });
        expect(screen.queryByText(/No dated legislative actions yet/i)).not.toBeInTheDocument();
        expect(screen.getByText(/Partial data/i)).toBeInTheDocument();
      });

      test('B11 procurement-lines 500 shows failed UI, not Secondary Distribution honesty Empty', async () => {
        setupApi(true, undefined, 2027);
        const baseImpl = apiGetMock.getMockImplementation()!;
        apiGetMock.mockImplementation(async (url: string) => {
          if (String(url).includes('/procurement-lines')) {
            const err = new Error('procurement-lines boom') as Error & {
              response?: { status: number };
            };
            err.response = { status: 500 };
            throw err;
          }
          // Force PROC line so Procurement detail tab mounts and enables the query.
          if (
            String(url).includes('/api/program-elements/0603270A') &&
            !String(url).match(
              /\/(personnel|contractors|bills|projects|related|provisions|opportunities|sources|deltas|narrative|actions|relationships|incumbents|programs|procurement-lines|intelligence)\b/,
            )
          ) {
            const base = await baseImpl(url);
            return {
              ...base,
              data: {
                ...base.data,
                appropriationType: 'PROC',
              },
            };
          }
          return baseImpl(url);
        });
        renderPage();
        await waitFor(() => expect(screen.getByTestId('pe-trust-header')).toBeInTheDocument());
        fireEvent.click(screen.getByRole('tab', { name: /Procurement detail/i }));
        await waitFor(() => {
          expect(screen.getByTestId('pe-secondary-failed-procurement-lines')).toBeInTheDocument();
        });
        expect(screen.queryByText(/No per-recipient procurement breakdown/i)).not.toBeInTheDocument();
        expect(screen.getByText(/Partial data/i)).toBeInTheDocument();
      });

      test('B12 funding narrative 500 shows failed UI, not stages Empty', async () => {
        setupApi(true, undefined, 2027);
        const baseImpl = apiGetMock.getMockImplementation()!;
        apiGetMock.mockImplementation(async (url: string) => {
          if (String(url).includes('/narrative')) {
            const err = new Error('narrative boom') as Error & { response?: { status: number } };
            err.response = { status: 500 };
            throw err;
          }
          return baseImpl(url);
        });
        renderPage();
        await waitFor(() => expect(screen.getByTestId('pe-trust-header')).toBeInTheDocument());
        // Narrative is funding-tab only (lazy); must not fire on overview.
        expect(
          apiGetMock.mock.calls.map((c) => String(c[0])).some((u) => u.includes('/narrative')),
        ).toBe(false);
        fireEvent.click(screen.getByRole('tab', { name: /Funding/i }));
        await waitFor(() => {
          expect(screen.getByTestId('pe-secondary-failed-narrative')).toBeInTheDocument();
        });
        expect(
          screen.queryByText(/No current-cycle funding stages recorded for this program element yet/i),
        ).not.toBeInTheDocument();
        expect(screen.getByText(/Partial data/i)).toBeInTheDocument();
        expect(screen.getAllByTestId('pe-secondary-retry').length).toBeGreaterThan(0);
      });
      });
