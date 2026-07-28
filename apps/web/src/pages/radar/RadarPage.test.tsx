import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { App as AntApp } from 'antd';
import {
  RadarPage,
  tenantBoardCardMatchesFilter,
  tenantBoardChangeTone,
  type TenantBoardCard,
} from './RadarPage.js';
import { BillDrawer, bill360DrawerWidth } from './BillDrawer.js';

const apiGetMock = vi.fn();

vi.mock('../../lib/use-api.js', () => ({
  useApi: () => ({
    get: apiGetMock,
  }),
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

  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
}

/** URL-keyed API stub; `flags` controls /intel-api/feature-flags. */
function mockApi(flags: Record<string, boolean>) {
  apiGetMock.mockImplementation(async (url: string) => {
    if (url === '/intel-api/feature-flags') return { data: flags };
    if (url === '/api/clients') {
      return { data: [{ id: 'c1', name: 'Acme Aerospace', status: 'active' }] };
    }
    if (url === '/intel-api/hearings') return { data: [] };
    if (url === '/intel-api/upcoming-hearings') return { data: [] };
    if (url.startsWith('/intel-api/upcoming-hearings/browse')) {
      return { data: { items: [], total: 0 } };
    }
    // L2b all-clients board roll-up: client-labelled, keyset-paginated cards.
    if (url.includes('/_all/tracker/board')) {
      const secondPage = url.includes('cursor=page-2');
      return {
        data: secondPage
          ? {
              columns: [
                { id: 'introduced', label: 'Introduced', cards: [] },
                {
                  id: 'committee',
                  label: 'In committee',
                  cards: [
                    {
                      billId: 'hr-2',
                      displayNum: 'H.R. 2',
                      title: 'Second Page Act',
                      passageProbability: 65,
                      unread: false,
                      matchedTags: ['Defense'],
                      matchedHighPriorityTopics: ['Defense'],
                      changeChip: null,
                      hearingCount: 1,
                      clientId: 'c1',
                      clientName: 'Acme Aerospace',
                    },
                  ],
                },
              ],
              nextCursor: null,
              hasMore: false,
              total: 2,
              withheld: 0,
            }
          : {
              columns: [
                { id: 'introduced', label: 'Introduced', cards: [] },
                {
                  id: 'committee',
                  label: 'In committee',
                  cards: [
                    {
                      billId: 'hr-1',
                      displayNum: 'H.R. 1',
                      title: 'Test Roll-up Act',
                      passageProbability: 80,
                      unread: false,
                      matchedTags: ['General relevance'],
                      matchedHighPriorityTopics: [],
                      changeChip: {
                        label: 'Critical move',
                        changeType: 'bill_failed',
                        severity: 'critical',
                        tone: 'critical',
                      },
                      hearingCount: 0,
                      clientId: 'c1',
                      clientName: 'Acme Aerospace',
                    },
                  ],
                },
              ],
              nextCursor: 'page-2',
              hasMore: true,
              total: 2,
              withheld: 1,
            },
      };
    }
    if (url.endsWith('/tracker/board')) return { data: { columns: [], total: 0 } };
    if (url.endsWith('/tracker/recommendations')) {
      return { data: { recommendations: [], aboveFloorCount: 0, total: 0, floor: 0.5 } };
    }
    // P11 global cross-client roll-up + per-client feed (empty by default).
    if (url.includes('/_all/feed') || url.includes('/feed')) {
      return { data: { items: [], nextCursor: null, hasMore: false, counts: {} } };
    }
    if (url === '/api/intelligence/issue-areas') return { data: { issueAreas: [] } };
    // Watchlist (P6 cold-start check + Configure panel). Default: configured
    // (so Feed/Bills render the panel, not the guided first-run state).
    if (url.endsWith('/tracker/watchlist')) {
      return { data: { issueAreas: ['Defense'], tags: [] } };
    }
    if (url.endsWith('/tracker/alert-prefs')) {
      return { data: { triggers: [], materiality: 'medium', emailEnabled: false } };
    }
    if (url.endsWith('/tracker/watchlist/seed-suggestions')) {
      return { data: { tags: [], issueAreas: [] } };
    }
    return { data: [] };
  });
}

function renderRadar(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <AntApp>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/radar" element={<RadarPage />} />
          </Routes>
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

const tenantCard = (patch: Partial<TenantBoardCard> = {}): TenantBoardCard => ({
  billId: 'hr-1',
  displayNum: 'H.R. 1',
  title: 'Example',
  passageProbability: 0.5,
  unread: false,
  matchedTags: [],
  matchedHighPriorityTopics: [],
  changeChip: null,
  clientId: 'c1',
  clientName: 'Acme',
  ...patch,
});

describe('tenant board trust helpers', () => {
  test('Priority-tag filter requires a high-priority topic, not any matched tag', () => {
    expect(
      tenantBoardCardMatchesFilter(
        tenantCard({ matchedTags: ['General relevance'], matchedHighPriorityTopics: [] }),
        'hifit',
      ),
    ).toBe(false);
    expect(
      tenantBoardCardMatchesFilter(
        tenantCard({ matchedTags: ['Defense'], matchedHighPriorityTopics: ['Defense'] }),
        'hifit',
      ),
    ).toBe(true);
  });

  test('change indicator preserves the server tone with a severity fallback', () => {
    expect(tenantBoardChangeTone(tenantCard({ changeChip: { label: 'Failed', changeType: 'bill_failed', tone: 'critical' } }))).toBe('critical');
    expect(tenantBoardChangeTone(tenantCard({ changeChip: { label: 'Info', changeType: 'bill_action', severity: 'info' } }))).toBe('info');
    expect(tenantBoardChangeTone(tenantCard({ changeChip: { label: 'Unknown', changeType: null } }))).toBe('notable');
  });
});

describe('RadarPage', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    window.sessionStorage.clear();
    window.localStorage.clear();
    // Default to the returning-user state so the first-run orientation modal
    // (L5) doesn't auto-open and collide with tab-label assertions. The intro
    // itself is covered by its own test below.
    window.localStorage.setItem('legiwatch-intro-seen-v1', '1');
    setupBrowserMocks();
  });

  test('defaults to the Feed tab; when tracker_v2 is off, shows the not-enabled state', async () => {
    mockApi({});
    renderRadar('/radar');

    expect(screen.getByText('LegiWatch')).toBeInTheDocument();
    // All four tabs render regardless of flags.
    for (const label of ['Feed', 'Bills', 'Hearings', 'Configure']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // P11: the Feed no longer prompts for a client at global altitude; without
    // tracker_v2 it falls to the "not enabled" Empty (no client picker gate).
    await waitFor(() =>
      expect(
        screen.getByText(/unified alert feed is not enabled for this workspace/i),
      ).toBeInTheDocument(),
    );
  });

  test('P11: Feed at global altitude (no client, tracker_v2 on) renders the cross-client roll-up', async () => {
    mockApi({ tracker_v2: true });
    renderRadar('/radar');

    // No client selected → the tenant-wide feed panel renders (empty here), NOT
    // the ClientGate picker prompt. The empty-state copy is the global variant
    // (LegiWatch v2 calm re-skin). P2-15 (Gate E phase e) rebuilt this copy
    // from SOURCE_LABEL instead of a hard-coded "bill or hearing" phrase —
    // match the stable structural part, not the enumerated source-type list.
    await waitFor(() =>
      expect(screen.getByText(/moves for any client, it lands here/i)).toBeInTheDocument(),
    );
    // It must hit the tenant-wide roll-up endpoint, not a per-client feed.
    expect(
      apiGetMock.mock.calls.some((args: unknown[]) => String(args[0]).includes('/clients/_all/feed')),
    ).toBe(true);
  });

  test('hearings tab is global (no client) and no longer carries a Watchlists view (absorbed by P5)', async () => {
    mockApi({ hearing_watch: true });
    renderRadar('/radar?tab=hearings');

    // LegiWatch v2 (L3): lands on the schedule; the watch history is "My Sessions".
    await waitFor(() => expect(screen.getByText('My Sessions')).toBeInTheDocument());
    expect(screen.getByText('Upcoming')).toBeInTheDocument();
    expect(screen.getByText('All hearings')).toBeInTheDocument();
    // P5: the hearing term-watchlist CRUD was absorbed into the unified editor on
    // the LegiWatch Configure tab — the Hearings surface no longer has its own view.
    expect(screen.queryByText('Watchlists')).not.toBeInTheDocument();
  });

  test('hearings tab respects the hearing_watch flag', async () => {
    mockApi({});
    renderRadar('/radar?tab=hearings');

    await waitFor(() =>
      expect(
        screen.getByText(/Hearing Watch is not enabled for this workspace/i),
      ).toBeInTheDocument(),
    );
  });

  test('bills tab renders the Board/Recs surface for the selected client', async () => {
    mockApi({});
    renderRadar('/radar?tab=bills&client=c1');

    // LegiWatch v2 (L2): the Bills tab stacks "Recommended by Meri" above "Your
    // board" (no Board|Recs sub-nav toggle) — both section headers are present.
    await waitFor(() => expect(screen.getByText('Your board')).toBeInTheDocument());
    expect(screen.getByText(/Recommended by Meri/)).toBeInTheDocument();
    // "Configure" names the outer LegiWatch tab (renamed from "Watchlist").
    expect(screen.getByText('Configure')).toBeInTheDocument();
    // Calm re-skin board-empty guide copy.
    await waitFor(() => expect(screen.getByText(/Your board is empty/i)).toBeInTheDocument());
  });

  test('L5: first-run orientation auto-opens, dismiss persists, and a "How it works" control exists', async () => {
    // First run: no seen-flag → the orientation auto-opens.
    window.localStorage.removeItem('legiwatch-intro-seen-v1');
    mockApi({});
    renderRadar('/radar');

    await waitFor(() => expect(screen.getByText('What LegiWatch does')).toBeInTheDocument());
    // The permanent reopen control is present in the top bar.
    expect(screen.getByRole('button', { name: /How it works/i })).toBeInTheDocument();
    // Dismiss ("Got it") persists the per-user seen-flag so it won't reappear.
    fireEvent.click(screen.getByRole('button', { name: /Got it/i }));
    await waitFor(() =>
      expect(window.localStorage.getItem('legiwatch-intro-seen-v1')).toBe('1'),
    );
  });

  test('L2b: Bills at all-clients (tracker_v2 on) shows the tenant board roll-up with client labels', async () => {
    mockApi({ tracker_v2: true });
    renderRadar('/radar?tab=bills');

    await waitFor(() => expect(screen.getByText('H.R. 1')).toBeInTheDocument());
    expect(screen.getByText('Test Roll-up Act')).toBeInTheDocument();
    // Each card is labelled with its client (U4 roll-up).
    expect(screen.getByText('Acme Aerospace')).toBeInTheDocument();
    // The global card must preserve the server's critical tone instead of
    // painting every change as ordinary/notable.
    expect(screen.getByTitle('Critical move')).toHaveClass('critical');
    // It fetches the tenant-wide board, not a per-client one.
    expect(
      apiGetMock.mock.calls.some((args: unknown[]) => String(args[0]).includes('/_all/tracker/board')),
    ).toBe(true);
  });

  test('L2b: all-clients Bills loads every keyset page instead of silently stopping at page one', async () => {
    mockApi({ tracker_v2: true });
    renderRadar('/radar?tab=bills');

    await waitFor(() => expect(screen.getByText('H.R. 1')).toBeInTheDocument());
    expect(screen.queryByText('H.R. 2')).not.toBeInTheDocument();
    expect(screen.getByText(/Showing 1 of 2 tracked bills/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Load more tracked bills/i }));

    await waitFor(() => expect(screen.getByText('H.R. 2')).toBeInTheDocument());
    expect(screen.getByText('Second Page Act')).toBeInTheDocument();
    expect(screen.getByText(/Showing 2 of 2 tracked bills/i)).toBeInTheDocument();
    expect(
      apiGetMock.mock.calls.some((args: unknown[]) =>
        String(args[0]).includes('/_all/tracker/board?cursor=page-2'),
      ),
    ).toBe(true);
  });

  test('L2b: Bills at all-clients without tracker_v2 falls back to the client-gate', async () => {
    mockApi({});
    renderRadar('/radar?tab=bills');

    await waitFor(() =>
      expect(screen.getByText(/Select a client to view its bill board/i)).toBeInTheDocument(),
    );
  });

  test('L5: returning user (seen-flag set) does not see the orientation on load', async () => {
    window.localStorage.setItem('legiwatch-intro-seen-v1', '1');
    mockApi({});
    renderRadar('/radar');

    await waitFor(() => expect(screen.getByText('LegiWatch')).toBeInTheDocument());
    expect(screen.queryByText('What LegiWatch does')).not.toBeInTheDocument();
  });
});

// ── Bill 360 drawer (R2 §2.3 / §2.6) ────────────────────────────────────────
//
// Every LegiWatch bill entry point (board card, feed action, recommendation) opens
// BillDrawer, so the drawer is where the "board card → Bill 360 drawer" contract
// and the responsive + flag rules are verified. Same harness as above: flags come
// from the real hook over the mocked /intel-api/feature-flags.

const B360_BILL = '119-hr-8800';
const B360_CLIENT = '11111111-1111-1111-1111-111111111111';

/** Minimal R1-shaped dossier: rule failed, no floor vote, funding unavailable. */
function billDossierFixture() {
  return {
    bill: {
      id: B360_BILL,
      num: 'H.R. 8800',
      title: 'Border Security and Enforcement Appropriations Act, 2026',
      chamber: 'House',
      type: 'hr',
      congress: 119,
      sponsor: null,
      introduced: null,
      statusLabel: 'Rule failed',
      statusSev: 'critical',
      statusAt: '2026-06-18T21:30:00.000Z',
      stage: 'rule_failed',
      jurisdiction: 'US',
      isState: false,
      url: null,
    },
    latest: { text: 'Rule reported.', date: '2026-06-17T00:00:00.000Z' },
    context: null,
    tracking: null,
    kpis: [
      { label: 'Current status', value: 'Rule failed', sub: null },
      { label: 'Latest recorded vote', value: 'None recorded', sub: null },
      { label: 'Funding position', value: '—', sub: null },
      { label: 'Δ from request', value: '—', sub: null },
      { label: 'Last official action', value: '2026-06-17', sub: null },
      { label: 'Next milestone', value: '—', sub: null },
    ],
    overview: {
      whatChanged: null,
      whyItMatters: null,
      officialNextStep: null,
      analystOutlook: null,
    },
    milestones: [],
    votes: [],
    governingRules: [],
    noVote: 'No roll call vote has been recorded on this bill.',
    funding: {
      available: false,
      status: 'Funding intelligence is not yet enabled for this vehicle.',
      positions: [],
      reqCompare: null,
      senateCompare: null,
      comparisons: [],
      guardrail: null,
      programElementImpacts: [],
      provisions: [],
      parentPackageLabel: null,
    },
    relatedVehicles: [],
    hearings: [],
    alerts: [],
    matchedTopics: [],
    recommendedActions: [],
    provenance: { lastSyncedAt: '2026-06-19T06:00:00.000Z', sources: [] },
  };
}

function mockDrawerApi(flags: Record<string, boolean>) {
  apiGetMock.mockImplementation(async (url: string) => {
    if (url === '/intel-api/feature-flags') return { data: flags };
    if (url.includes('/dossier')) return { data: billDossierFixture() };
    if (url.includes('/hearings')) return { data: { count: 0, hearings: [] } };
    return { data: [] };
  });
}

function renderBillDrawer(props: Record<string, unknown> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AntApp>
        <MemoryRouter initialEntries={['/legiwatch']}>
          <BillDrawer
            open
            billId={B360_BILL}
            clientId={B360_CLIENT}
            clientName="Acme Aerospace"
            onClose={vi.fn()}
            {...props}
          />
        </MemoryRouter>
      </AntApp>
    </QueryClientProvider>,
  );
}

/** jsdom defaults to 1024px; set an explicit width per case. */
function setViewport(px: number) {
  Object.defineProperty(window, 'innerWidth', { value: px, writable: true, configurable: true });
}

describe('bill360DrawerWidth — §2.3 responsive contract', () => {
  test('desktop clamps into the 960–1,100px band', () => {
    expect(bill360DrawerWidth(1920)).toBe(1100);
    expect(bill360DrawerWidth(1440)).toBe(1100);
  });

  test('a mid-size viewport keeps the panel inside the window (48px gutter)', () => {
    expect(bill360DrawerWidth(1100)).toBe(1052);
    expect(bill360DrawerWidth(1000)).toBe(960);
  });

  test('never exceeds the viewport between the floor and the gutter', () => {
    for (const w of [760, 820, 900, 960, 1000, 1200, 1920]) {
      const width = bill360DrawerWidth(w);
      expect(typeof width === 'number' ? width : 0).toBeLessThanOrEqual(w);
    }
  });

  test('narrow viewports go full-screen', () => {
    expect(bill360DrawerWidth(720)).toBe('100%');
    expect(bill360DrawerWidth(480)).toBe('100%');
  });
});

describe('BillDrawer — Bill 360 flag ON', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    setupBrowserMocks();
    setViewport(1440);
  });

  test('renders the shared dossier body (Bill 360 chrome + Open full page)', async () => {
    mockDrawerApi({ bill_360: true });
    renderBillDrawer();

    expect(await screen.findByText('H.R. 8800')).toBeInTheDocument();
    expect(screen.getByText('Bill 360')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open full page/i })).toBeInTheDocument();
    // Drawer always has a client → the CLIENT-context dossier route is used.
    await waitFor(() =>
      expect(
        apiGetMock.mock.calls.some(
          (c) => String(c[0]) === `/intel-api/clients/${B360_CLIENT}/bills/${B360_BILL}/dossier`,
        ),
      ).toBe(true),
    );
  });

  test('shows all seven dossier tabs', async () => {
    mockDrawerApi({ bill_360: true });
    renderBillDrawer();
    await screen.findByText('H.R. 8800');
    for (const label of [
      'Overview',
      'Path & votes',
      'Funding',
      'Provisions',
      'Impact',
      'Hearings',
      'Evidence',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  test('preserves Track through the caller mutation', async () => {
    const onTrack = vi.fn();
    mockDrawerApi({ bill_360: true });
    renderBillDrawer({ isTracked: false, onTrack });

    fireEvent.click(await screen.findByRole('button', { name: /Track bill/i }));
    expect(onTrack).toHaveBeenCalledWith(B360_BILL);
  });

  test('an already-tracked bill reads "Tracked"', async () => {
    mockDrawerApi({ bill_360: true });
    renderBillDrawer({ isTracked: true, onTrack: vi.fn() });
    expect(await screen.findByRole('button', { name: /^Tracked$/ })).toBeInTheDocument();
  });

  test('narrow viewport renders the drawer full-screen', async () => {
    setViewport(600);
    mockDrawerApi({ bill_360: true });
    renderBillDrawer();
    await screen.findByText('H.R. 8800');

    const panel = document.querySelector('.ant-drawer-content-wrapper');
    expect(panel).toBeTruthy();
    expect((panel as HTMLElement).style.width).toBe('100%');
  });

  test('desktop viewport renders the clamped Bill 360 width', async () => {
    mockDrawerApi({ bill_360: true });
    renderBillDrawer();
    await screen.findByText('H.R. 8800');

    const panel = document.querySelector('.ant-drawer-content-wrapper');
    expect((panel as HTMLElement).style.width).toBe('1100px');
  });
});

describe('BillDrawer — Bill 360 flag OFF fails closed', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    setupBrowserMocks();
    setViewport(1440);
  });

  test('keeps the legacy drawer when the flag is disabled', async () => {
    mockDrawerApi({});
    renderBillDrawer();

    // Legacy chrome: the "Bill" eyebrow, no Bill 360 chrome, no dossier fetch.
    await waitFor(() => expect(screen.getByText('Bill')).toBeInTheDocument());
    expect(screen.queryByText('Bill 360')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open full page/i })).not.toBeInTheDocument();
    expect(apiGetMock.mock.calls.every((c) => !String(c[0]).includes('/dossier'))).toBe(true);
  });

  test('legacy drawer keeps the "Track for <client>" affordance', async () => {
    const onTrack = vi.fn();
    mockDrawerApi({});
    renderBillDrawer({ isTracked: false, onTrack });

    fireEvent.click(await screen.findByRole('button', { name: /Track for Acme Aerospace/i }));
    expect(onTrack).toHaveBeenCalledWith(B360_BILL);
  });

  test('a state bill key still uses the legacy state rail when the flag is off', async () => {
    mockDrawerApi({});
    renderBillDrawer({ billId: 'tx-2025-hb1234' });
    await waitFor(() => expect(screen.getByText('State bill')).toBeInTheDocument());
    expect(screen.queryByText('Bill 360')).not.toBeInTheDocument();
  });
});

/**
 * Gate D phase g (P2-03, g-7) — the client picker and the alert deep link.
 *
 * P2-03: the header picker rendered on EVERY tab, including two places it does
 * nothing. Hearings is not client-filtered (HearingWatchPanel takes no
 * clientId), and on a tab that requires a client the ClientGate renders its own
 * picker inside the empty state — two pickers for one decision.
 *
 * Counted by picker ROOT (`.ant-select`), scoped to the header vs the gate: one
 * antd Select carries its aria-label on two nodes, so getAllByLabelText would
 * report 2 for a single control.
 */
function pickerCounts() {
  return {
    header: document.querySelectorAll('.pg-top .ant-select').length,
    gate: document.querySelectorAll('.guide .ant-select').length,
  };
}

describe('P2-03 — the client picker appears exactly once, and only where it acts', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    window.sessionStorage.clear();
    window.localStorage.clear();
    setupBrowserMocks();
  });

  /** g-8 case 7, first half. */
  test('Hearings renders NO client picker', async () => {
    mockApi({ tracker_v2: true, hearing_watch: true });
    renderRadar('/radar?tab=hearings');
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    expect(pickerCounts()).toEqual({ header: 0, gate: 0 });
  });

  /** g-8 case 7, second half. */
  test('Feed with no client selected renders exactly ONE picker', async () => {
    mockApi({ tracker_v2: true });
    renderRadar('/radar?tab=feed');
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    const { header, gate } = pickerCounts();
    expect(header + gate).toBe(1);
  });

  test('a gated tab shows the GATE picker and hides the header one', async () => {
    // Watchlist always gates without a client. Bills does NOT when tracker_v2
    // is on — it renders the all-clients roll-up, so the header picker is the
    // way to scope down and correctly stays.
    mockApi({ tracker_v2: true });
    renderRadar('/radar?tab=watchlist');
    await screen.findByText('Choose a client');
    expect(pickerCounts()).toEqual({ header: 0, gate: 1 });
  });

  test('Feed WITH a client keeps the header picker, and only that one', async () => {
    mockApi({ tracker_v2: true });
    renderRadar('/radar?tab=feed&client=c1');
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    expect(pickerCounts()).toEqual({ header: 1, gate: 0 });
  });
});
