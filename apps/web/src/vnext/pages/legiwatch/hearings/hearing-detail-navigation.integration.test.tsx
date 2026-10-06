/**
 * PR B §6 — REAL route/component integration for the navigation graph.
 * Renders the ACTUAL surfaces (HearingsTab / FeedTab / CommitteeRoomRoute /
 * HearingDetailRoute) inside react-router so every §6 edge is a real
 * navigation (mouse + keyboard), not a source-text assertion:
 *
 *   calendar chip            → Hearing Detail
 *   list row                 → Hearing Detail
 *   detail committee link    → Committee Room
 *   My Sessions history row  → Hearing Detail (mouse AND keyboard Enter)
 *   feed hearing row         → Hearing Detail (hearingId present)
 *   feed row without id      → packet drawer (honest non-linkable)
 *   committee room row       → Hearing Detail
 *   back affordance / browser back (BrowserRouter variant)
 *
 * The API layer is stubbed at useApi (axios-shaped get) with URL-PREFIX
 * routing so week-relative calendar URLs and cursor params need no dates
 * hardcoded here.
 */
import { createElement } from 'react';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { MemoryRouter, BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ isLoaded: true, orgId: 'org-test', userId: 'user-test' }),
}));

const apiGet = vi.fn<(url: string) => Promise<{ data: unknown }>>();
const apiPost = vi.fn<(url: string, body?: unknown) => Promise<{ data: unknown }>>();
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: (url: string) => apiGet(url), post: (url: string, body?: unknown) => apiPost(url, body) }),
}));
vi.mock('../../../../lib/me.js', () => ({ useMe: () => ({ isLoading: false, data: undefined }) }));

import { HearingDetailRoute } from './HearingDetailRoute.js';
import { CommitteeRoomRoute } from './CommitteeRoomRoute.js';
import { HearingsTab } from './HearingsTab.js';
import { FeedTab } from '../feed/FeedTab.js';
import type { FeedItem } from '../../../../pages/clients/tracker/intel-feed-api.js';

// ── wire fixtures ────────────────────────────────────────────────────────────
// These are the shapes `LiveHearingsService` ACTUALLY serves, field-for-field
// (see apps/api/src/live-hearings/live-hearings.service.ts — `CalendarEvent`
// and its row mapper): `date`, `startsAt`, `time`, `timezone`, `eventStatus`,
// `committeeName`/`committeeSystemCode`. It never emits `calendarDate`,
// `scheduledStart` or `timeZone`; those are names the CLIENT normalizer
// produces. Writing the canonical names here — as this file used to — makes a
// surface that skips the normalizer look correct in tests while rendering a
// blank date and "Time not announced" in production (LW-QA-018).

function calRow(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'cm-119-9001',
    title: 'Shipbuilding industrial base oversight',
    chamber: 'House',
    eventType: 'hearing',
    eventStatus: 'completed',
    visibility: 'public',
    date: '2026-09-02',
    startsAt: '2026-09-02T14:00:00Z',
    time: '10:00 AM',
    timezone: 'America/New_York',
    location: '2167 Rayburn',
    committeeName: 'Armed Services Committee (detail test)',
    committeeSystemCode: 'hs00-lwdt',
    witnesses: [],
    streamAvailability: 'archived',
    coverageStatus: 'captured',
    sourceRevision: 1,
    capture: { status: 'ended', capturedSeconds: 3600, gapSeconds: 0, reconnectCount: 0, failureCode: null },
    subscription: null,
    ...partial,
  };
}

const HISTORY_SESSION = {
  id: 'sess-1',
  title: 'Shipbuilding industrial base oversight',
  status: 'completed',
  hearingId: 'cm-119-9001',
  watchlistMatchCount: 2,
  recapSaved: true,
};

/**
 * `/events/:id` returns the SAME `CalendarEvent` shape `/calendar` does
 * (LiveHearingsService.event → hydrate → the one row mapper), so the detail
 * fixture is a calendar row — flat root-level `committeeName` /
 * `committeeSystemCode` and NO nested `committee` object, which is exactly
 * what the real wire sends. The shared normalizer now carries that root code
 * into the event's committee ref (LW-QA-025 fixed there), so the committee-
 * link regression below exercises the actual API shape end-to-end rather
 * than a nested workaround the service never emits.
 */
const DETAIL_EVENT = {
  ...calRow({}),
  streamState: 'READY_FOR_SERVER_CAPTURE',
  capture: { id: 'cap-1', status: 'ended', failureReason: null, gapSeconds: 0 },
};

const TRANSCRIPT_PAGE = {
  items: [
    { id: 'seg-1', sequence: 1, startMs: 0, endMs: 40000, text: 'The committee will come to order.', speakerLabel: 'Chair', isFinal: true, hasGapBefore: false },
    { id: 'seg-2', sequence: 2, startMs: 41000, endMs: 90000, text: 'We must reaffirm our commitment to the skilled trades workforce.', speakerLabel: 'Witness', isFinal: true, hasGapBefore: true },
  ],
  total: 2,
  nextCursor: null,
  hasMore: false,
  capture: { captureId: 'cap-1', status: 'COMPLETE' },
};

const INTEL_READY = {
  status: 'READY',
  items: [
    {
      id: 'ins-1',
      insightType: 'COMMITMENT',
      title: 'Workforce commitment',
      summary: 'The witness committed to expanding the pipeline.',
      evidenceText: 'We must reaffirm our commitment to the skilled trades workforce.',
      segmentId: 'seg-2',
      startMs: 41000,
      endMs: 90000,
      speakerName: 'Witness',
      preliminary: false,
    },
  ],
  jobs: { public: {} },
};

/**
 * `CommitteeDirectoryService.committee()` returns `{ ...committeeDirectoryRow,
 * parent, subcommittees, ..., upcomingEvents, recentEvents, updates }` — the
 * row is spread FLAT, so source-health metadata sits at the OUTER level (there
 * is no `raw.committee` envelope), and the event lists are the very same
 * `CalendarEvent` rows `/calendar` serves.
 */
const ROOM_WIRE = {
  systemCode: 'hs00-lwdt',
  name: 'Armed Services Committee (detail test)',
  chamber: 'house',
  isSubcommittee: false,
  parent: null,
  subcommittees: [{ systemCode: 'hs16-lwdt', name: 'Seapower and Projection Forces' }],
  officialUrl: 'https://armedservices.house.gov',
  jurisdiction: 'Armed services',
  lastSyncedAt: '2026-09-04T11:00:00Z',
  sourceHealth: 'healthy',
  sourceHealthInheritedFrom: null,
  lastSourceSuccessAt: '2026-09-04T10:30:00Z',
  sourceId: 'source-hs00',
  sourceUrl: 'https://armedservices.house.gov/hearings',
  members: [
    { id: 'm1', name: 'Rep. Alice Smith', party: 'R', side: 'majority', role: 'Chair' },
    { id: 'm2', name: 'Rep. Bob Jones', party: 'D', side: 'minority', role: 'Ranking Member' },
  ],
  chair: { id: 'm1', name: 'Rep. Alice Smith', party: 'R', side: 'majority', role: 'Chair' },
  rankingMember: { id: 'm2', name: 'Rep. Bob Jones', party: 'D', side: 'minority', role: 'Ranking Member' },
  upcomingEvents: [],
  // The SAME wire row the detail endpoint serves — the parity fixture.
  recentEvents: [calRow({})],
  // `CommitteeSiteUpdate` rows publish their link as `sourceUrl`, and a row can
  // reach the client without an `id`.
  updates: [
    {
      id: 'u1',
      title: 'Witness list updated',
      sourceUrl: 'https://armedservices.house.gov/news',
      publishedAt: '2026-09-01T12:00:00Z',
      lastSeenAt: '2026-09-01T12:05:00Z',
      contentHash: 'hash-u1',
    },
    {
      title: 'Room change posted',
      sourceUrl: 'https://armedservices.house.gov/room',
      publishedAt: '2026-08-31T12:00:00Z',
      lastSeenAt: '2026-08-31T12:05:00Z',
      contentHash: null,
    },
  ],
};

/** ROOM_WIRE with the named outer-level fields replaced. */
function roomWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...ROOM_WIRE, ...overrides };
}

/** Today's Eastern civil day (en-CA gives YYYY-MM-DD). */
function easternDayOfNow(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

function wireGet(url: string): { data: unknown } | null {
  // Canonical week calendar — rows are derived from the REQUESTED range so they
  // always land inside the week HearingsTab is currently viewing (the grid
  // buckets by Eastern day against the visible week, so "today's" week wins).
  if (url.startsWith('/api/legiwatch/live-hearings/calendar?')) {
    const params = new URLSearchParams(url.split('?')[1]);
    const from = params.get('from') ?? easternDayOfNow();
    const to = params.get('to') ?? from;
    // Completed row: the FROM day (inside any Mon–Sun window); upcoming +3d,
    // clamped into the window.
    const base = new Date(`${from}T00:00:00Z`);
    const inWindow = (offset: number): string => {
      const d = new Date(base.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
      return d <= to ? d : from;
    };
    const day2 = inWindow(2);
    const day4 = inWindow(4);
    return {
      data: {
        items: [
          calRow({ date: day2, startsAt: `${day2}T14:00:00Z` }),
          calRow({ id: 'cm-119-9002', title: 'Future posture hearing', eventStatus: 'scheduled', date: day4, startsAt: `${day4}T18:00:00Z`, time: '2:00 PM' }),
        ],
        total: 2,
      },
    };
  }
  if (url.startsWith('/intel-api/hearings/history?')) {
    return { data: { items: [HISTORY_SESSION], total: 1, nextCursor: null, hasMore: false } };
  }
  // Durable server captures rail — empty by default; individual tests override.
  if (url.startsWith('/api/legiwatch/live-hearings/server-sessions')) {
    return { data: { rows: [], total: 0, page: 1, pageSize: 50 } };
  }
  if (url === '/api/legiwatch/live-hearings/events/cm-119-9001') return { data: DETAIL_EVENT };
  if (url.startsWith('/api/legiwatch/live-hearings/events/cm-119-9001/transcript')) return { data: TRANSCRIPT_PAGE };
  if (url.startsWith('/api/legiwatch/live-hearings/events/cm-119-9001/intelligence')) return { data: INTEL_READY };
  // EXACT room path only. `/committees/:code/follow` and
  // `/committees/:code/intelligence-history` are different Wave 1 contracts —
  // a prefix match served them the ROOM envelope, so the history section read
  // `history.data.rows` off a committee record and threw while the suite still
  // reported green.
  if (url === '/api/legiwatch/live-hearings/committees/hs00-lwdt') return { data: ROOM_WIRE };
  if (url.startsWith('/intel-api/clients/_all/feed?')) {
    return {
      data: {
        items: [
          {
            id: 'alert-1',
            clientId: 'c1',
            clientName: 'Alpha Gov Relations',
            title: 'Hearing alert: shipbuilding oversight',
            sourceType: 'hearing',
            sourceRef: 'src-1',
            severity: 'medium',
            status: 'new',
            score: 0.7,
            createdAt: '2026-09-02T00:00:00Z',
            evidence: { hearing: { sessionId: 'sess-1', hearingId: 'cm-119-9001', title: null, committeeId: null, occurredAt: null, mentions: [] } },
          },
          {
            id: 'alert-2',
            clientId: 'c1',
            clientName: 'Alpha Gov Relations',
            title: 'Hearing alert: legacy row without anchors',
            sourceType: 'hearing',
            sourceRef: 'src-2',
            severity: 'low',
            status: 'new',
            score: 0.4,
            createdAt: '2026-09-01T00:00:00Z',
            evidence: { hearing: { sessionId: 'sess-legacy', hearingId: null, title: 'A title that must never resolve', committeeId: null, occurredAt: null, mentions: [] } },
          },
        ] as unknown as FeedItem[],
        counts: { default: 2 },
        total: 2,
        hasMore: false,
        nextCursor: null,
      },
    };
  }
  if (url.startsWith('/intel-api/clients/_all/alerts/work-state')) return { data: {} };
  // Tab panels now stay MOUNTED (hidden) when inactive, so their queries fire
  // even when the test never opens the tab. Give those incidental reads a
  // benign empty payload instead of an unhandled rejection: feature flags
  // fail closed ({}), list endpoints return empty pages.
  if (url === '/intel-api/feature-flags') return { data: {} };
  if (url === '/api/clients') return { data: [] };
  if (url === '/intel-api/legiwatch/folders') return { data: [] };
  if (url.startsWith('/api/legiwatch/live-hearings/events/cm-119-9001/follow-config'))
    return { data: { following: false, clients: [] } };
  if (url.startsWith('/api/legiwatch/live-hearings/events/cm-119-9001/attendance'))
    return { data: { scheduled: false, canRequest: false, state: 'UNAVAILABLE', message: 'No capture mode is available.' } };
  if (url.startsWith('/api/legiwatch/live-hearings/events/cm-119-9001/updates'))
    return { data: { updates: [] } };
  if (url.startsWith('/api/legiwatch/live-hearings/events/cm-119-9001/client-relevance'))
    return { data: { hearingId: 'cm-119-9001', scope: 'all-clients', transcriptAvailable: true, clients: [], counts: { HIGH: 0, MEDIUM: 0, LOW: 0 } } };
  if (url.startsWith('/intel-api/hearings/')) return { data: { items: [], records: [], runs: [] } };
  return null;
}

beforeEach(() => {
  apiGet.mockReset();
  apiGet.mockImplementation((url: string) => {
    const hit = wireGet(url);
    if (!hit) return Promise.reject(new Error(`unexpected GET ${url}`));
    return Promise.resolve(hit);
  });
  apiPost.mockReset();
  apiPost.mockRejectedValue(new Error('unexpected POST'));
});

afterEach(() => {
  cleanup();
});

function LocationProbe({ onLocation }: { onLocation: (l: { pathname: string; search: string; state: unknown }) => void }) {
  const loc = useLocation();
  onLocation({ pathname: loc.pathname, search: loc.search, state: loc.state });
  return null;
}

function renderRoutes(Router: typeof MemoryRouter | typeof BrowserRouter, initialPath: string, initialEntries?: unknown[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  const location = { current: { pathname: '', search: '', state: null as unknown } };
  // Every rendered location, in order — lets a test observe an intermediate
  // history entry that a later same-tick write replaced.
  const history: Array<{ pathname: string; search: string; state: unknown }> = [];
  const routerProps = Router === MemoryRouter ? { initialEntries: (initialEntries ?? [initialPath]) as string[] } : {};
  render(
    <QueryClientProvider client={queryClient}>
      <Router {...routerProps}>
        <LocationProbe onLocation={(l) => { location.current = l; history.push(l); }} />
        <Routes>
          <Route path="/legiwatch" element={<div data-testid="module-landing">LegiWatch module landing</div>} />
          <Route path="/legiwatch/hearings" element={<HearingsTab scope="" />} />
          <Route path="/legiwatch/feed" element={<FeedTab scope="" clients={[]} />} />
          <Route path="/legiwatch/hearings/:hearingId" element={<HearingDetailRoute />} />
          <Route path="/legiwatch/committees/:systemCode" element={<CommitteeRoomRoute />} />
          <Route path="/directory/state-committees/:id" element={<div data-testid="state-committee-profile">State committee profile</div>} />
          <Route path="/intelligence/hearing-watch/:sessionId" element={<div data-testid="browser-hearing-room">Browser hearing room</div>} />
        </Routes>
      </Router>
    </QueryClientProvider>,
  );
  return { location, queryClient, history };
}

describe('PR B §6 — every entry surface reaches Hearing Detail (real navigation)', () => {
  it('shows a browser-only source restriction instead of promising scheduled server capture', async () => {
    apiGet.mockImplementation((url: string) => {
      if (url === '/api/legiwatch/live-hearings/events/cm-119-9001')
        return Promise.resolve({ data: calRow({
          eventStatus: 'scheduled', capturePolicy: 'BROWSER_CAPTURE_ONLY',
          streamAvailability: 'BROWSER_CAPTURE_ONLY',
          capture: { id: 'pending', status: 'SCHEDULED', capturePolicy: 'BROWSER_CAPTURE_ONLY' },
        }) });
      const hit = wireGet(url);
      return hit ? Promise.resolve(hit) : Promise.reject(new Error(`unexpected GET ${url}`));
    });
    renderRoutes(MemoryRouter, '/legiwatch/hearings/cm-119-9001?detailTab=live-capture');
    expect(await screen.findByText('BROWSER RECORDING ONLY')).toBeInTheDocument();
    expect(screen.queryByText('CAPTURE SCHEDULED')).not.toBeInTheDocument();
    const panel = screen.getByRole('tabpanel', { name: 'Live and capture panel' });
    expect(within(panel).getByText('Browser recording only')).toBeInTheDocument();
  });

  it.each(['calendar chip', 'live room button'])('live %s opens the canonical hearing instead of an unhandled route', async (entry) => {
    apiGet.mockImplementation((url: string) => {
      const hit = wireGet(url);
      if (hit && url.startsWith('/api/legiwatch/live-hearings/calendar?')) {
        const page = hit.data as { items: Record<string, unknown>[] };
        return Promise.resolve({ data: { ...page, items: page.items.map((row, index) => index === 0 ? { ...row, eventStatus: 'in_progress', capture: { status: 'capturing' } } : row) } });
      }
      return hit ? Promise.resolve(hit) : Promise.reject(new Error(`unexpected GET ${url}`));
    });
    const { location } = renderRoutes(MemoryRouter, '/legiwatch/hearings');
    const control = entry === 'calendar chip'
      ? await within(await screen.findByLabelText('Week calendar')).findByRole('button', { name: /Shipbuilding industrial base oversight/i })
      : (fireEvent.click(await screen.findByRole('tab', { name: 'Recordings' })),
        await screen.findByRole('button', { name: /Open live room/i }));
    fireEvent.click(control);
    await waitFor(() => expect(location.current.pathname).toBe('/legiwatch/hearings/cm-119-9001'));
    await screen.findByRole('heading', { name: /Shipbuilding industrial base oversight/i });
  });

  it('browser session history opens the actual session even when linked to a canonical hearing', async () => {
    apiGet.mockImplementation((url: string) => {
      if (url.startsWith('/intel-api/hearings/history?')) {
        return Promise.resolve({ data: { items: [{ ...HISTORY_SESSION, audioSource: 'browser_mic' }], total: 1, hasMore: false } });
      }
      const hit = wireGet(url);
      return hit ? Promise.resolve(hit) : Promise.reject(new Error(`unexpected GET ${url}`));
    });
    const { location } = renderRoutes(MemoryRouter, '/legiwatch/hearings');
    fireEvent.click(await screen.findByRole('tab', { name: 'Recordings' }));
    fireEvent.click(await screen.findByRole('button', { name: /Open Shipbuilding industrial base oversight/i }));
    await waitFor(() => expect(location.current.pathname).toBe('/intelligence/hearing-watch/sess-1'));
    expect(screen.getByTestId('browser-hearing-room')).toBeTruthy();
  });

  it('shows a real scheduled subscription in the durable server captures rail', async () => {
    apiGet.mockImplementation((url: string) => {
      if (url.startsWith('/api/legiwatch/live-hearings/server-sessions')) {
        return Promise.resolve({
          data: {
            rows: [{
              id: 'cm-119-9001',
              title: 'Shipbuilding industrial base oversight',
              committeeName: 'Armed Services',
              chamber: 'House',
              eventStatus: 'scheduled',
              visibility: 'public',
              date: '2026-02-24',
              startsAt: '2026-02-24T15:00:00Z',
              time: null,
              timeZone: 'America/New_York',
              location: null,
              officialPageUrl: null,
              capture: null,
              capturePending: true,
              scheduleSource: { byUser: true, byRule: false, ruleId: null },
            }],
            total: 1,
            page: 1,
            pageSize: 50,
          },
        });
      }
      const hit = wireGet(url);
      return hit ? Promise.resolve(hit) : Promise.reject(new Error(`unexpected GET ${url}`));
    });
    const { location } = renderRoutes(MemoryRouter, '/legiwatch/hearings');
    fireEvent.click(await screen.findByRole('tab', { name: 'Recordings' }));
    const rail = await screen.findByLabelText('Recordings');
    await within(rail).findByText('Shipbuilding industrial base oversight');
    expect(rail.textContent).not.toMatch(/isn't available on this backend/i);
    fireEvent.click(within(rail).getByRole('button', { name: /Shipbuilding industrial base oversight/i }));
    await waitFor(() => expect(location.current.pathname).toBe('/legiwatch/hearings/cm-119-9001'));
  });

  it('calendar chip click → detail route renders the hearing', async () => {
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    const { location } = renderRoutes(MemoryRouter, '/legiwatch/hearings?calendarDate=2026-02-24&calendarQ=Shipbuilding');
    const grid = await screen.findByLabelText('Week calendar');
    const chip = await within(grid).findByRole('button', { name: /Shipbuilding industrial base oversight/i });
    fireEvent.click(chip);
    await waitFor(() => expect(location.current.pathname).toBe('/legiwatch/hearings/cm-119-9001'));
    await waitFor(() => expect(screen.getByRole('heading', { name: /Shipbuilding industrial base oversight/i })).toBeTruthy());
    expect(screen.getByText('Stream ready')).toBeInTheDocument();
    expect(screen.queryByText('READY_FOR_SERVER_CAPTURE')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('← Back to LegiWatch'));
    await waitFor(() => expect(location.current.pathname).toBe('/legiwatch/hearings'));
    expect(new URLSearchParams(location.current.search).get('calendarDate')).toBe('2026-02-24');
    expect(new URLSearchParams(location.current.search).get('calendarQ')).toBe('Shipbuilding');
    await screen.findByLabelText('Week calendar');
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    scroll.mockRestore();
  });

  it('My Sessions history row → detail via mouse AND keyboard Enter', async () => {
    const { location } = renderRoutes(MemoryRouter, '/legiwatch/hearings');
    fireEvent.click(await screen.findByRole('tab', { name: 'Recordings' }));
    // The history panel renders after the recordings tab loads; scope to its label.
    await screen.findByText(/Recent session history/);
    const hrow = await screen.findByRole('button', { name: /Open Shipbuilding industrial base oversight/i });
    expect(hrow).toBeTruthy();

    // Keyboard first: Enter on the focused row navigates to detail.
    hrow.focus();
    expect(hrow).toHaveFocus();
    fireEvent.keyDown(hrow, { key: 'Enter' });
    await waitFor(() => expect(location.current.pathname).toBe('/legiwatch/hearings/cm-119-9001'));
  });

  it('My Sessions history row → detail via mouse click', async () => {
    const { location } = renderRoutes(MemoryRouter, '/legiwatch/hearings');
    fireEvent.click(await screen.findByRole('tab', { name: 'Recordings' }));
    const hrow = await screen.findByRole('button', { name: /Open Shipbuilding industrial base oversight/i });
    fireEvent.click(hrow);
    await waitFor(() => expect(location.current.pathname).toBe('/legiwatch/hearings/cm-119-9001'));
    void historyLabelUnused;
    void historyCardUnused;
    void historySessionUnused;
  });

  it('feed hearing row with hearingId → detail route', async () => {
    const { location } = renderRoutes(MemoryRouter, '/legiwatch/feed');
    const linked = await screen.findByText(/Hearing alert: shipbuilding oversight/i);
    const linkedRow = linked.closest('.lw-prow')?.querySelector<HTMLButtonElement>('.lw-prow__title--action');
    expect(linkedRow).toBeTruthy();
    fireEvent.click(linkedRow!);
    await waitFor(() => expect(location.current.pathname).toBe('/legiwatch/hearings/cm-119-9001'));
    await waitFor(() => expect(screen.getByRole('heading', { name: /Shipbuilding industrial base oversight/i })).toBeTruthy());
  });

  it('feed row without any stable anchor stays on the feed and opens the packet drawer (honest non-linkable)', async () => {
    apiGet.mockImplementation((url: string) => {
      if (url.startsWith('/intel-api/clients/_all/feed?')) {
        const base = wireGet(url)!;
        const baseData = base.data as Record<string, unknown>;
        const items = (baseData as { items: FeedItem[] }).items;
        return Promise.resolve({ data: { ...baseData, items: items.slice(1) } }); // only the anchorless row
      }
      const hit = wireGet(url);
      if (!hit) return Promise.reject(new Error(`unexpected GET ${url}`));
      return Promise.resolve(hit);
    });
    const { location } = renderRoutes(MemoryRouter, '/legiwatch/feed');
    const legacy = await screen.findByText(/A title that must never resolve/i);
    const legacyRow = legacy.closest('.lw-prow')?.querySelector<HTMLButtonElement>('.lw-prow__title--action');
    expect(legacyRow).toBeTruthy();
    fireEvent.click(legacyRow!);
    // Stays on the feed (packet drawer opens in place) — never navigates to detail.
    await waitFor(() => expect(location.current.pathname).toBe('/legiwatch/feed'));
    // The drawer mounts as the packet surface for the alert.
    await waitFor(() => expect(document.querySelector('[role="dialog"], .lw-drawer, [aria-label*="Packet"], [aria-label*="packet"]')).toBeTruthy());
  });

  it('committee room hearing row → detail; detail back affordance leaves the detail route', async () => {
    const { location } = renderRoutes(MemoryRouter, '/legiwatch/committees/hs00-lwdt');
    const room = await screen.findByLabelText('Committee room: Armed Services Committee (detail test)');
    expect(within(room).getAllByText(/Seapower and Projection Forces/i).length).toBeGreaterThan(0);
    const recent = within(room).getByLabelText('Past hearings');
    const row = within(recent).getByRole('button', { name: /Shipbuilding industrial base oversight/i });
    fireEvent.click(row);
    await waitFor(() => expect(location.current.pathname).toBe('/legiwatch/hearings/cm-119-9001'));
    // Wait for detail content before using its back affordance.
    await screen.findByRole('heading', { name: /Shipbuilding industrial base oversight/i });
    fireEvent.click(screen.getByText('← Back to LegiWatch'));
    await waitFor(() => expect(location.current.pathname).toBe('/legiwatch'));
  });

  it('browser back returns from detail to the prior surface (real history)', async () => {
    window.history.replaceState(null, '', '/legiwatch/hearings');
    const { location } = renderRoutes(BrowserRouter, '/legiwatch/hearings');
    const grid = await screen.findByLabelText('Week calendar');
    const chip = await within(grid).findByRole('button', { name: /Shipbuilding industrial base oversight/i });
    fireEvent.click(chip);
    await waitFor(() => expect(location.current.pathname).toBe('/legiwatch/hearings/cm-119-9001'));
    window.history.back();
    await waitFor(() => expect(location.current.pathname).toBe('/legiwatch/hearings'));
    window.history.replaceState(null, '', '/');
  });

  // LW-QA-025 primary regression: DETAIL_EVENT is the flat wire shape (root
  // `committeeSystemCode`, NO nested `committee` object). The shared normalizer
  // must carry that code through so the existing detail-page committee link
  // renders and navigates to the Committee Room. Against the old normalizer
  // this rendered plain text with no button.
  it('detail committee link → Committee Room, from the FLAT wire shape (no nested committee object)', async () => {
    const { location } = renderRoutes(MemoryRouter, '/legiwatch/hearings/cm-119-9001');
    const facts = await screen.findByLabelText('Hearing facts');
    const link = await within(facts).findByRole('button', {
      name: /Armed Services Committee \(detail test\)/i,
    });
    fireEvent.click(link);
    await waitFor(() => expect(location.current.pathname).toBe('/legiwatch/committees/hs00-lwdt'));
    await screen.findByLabelText('Committee room: Armed Services Committee (detail test)');
  });
});

describe('PR B §6 — detail surface honesty (rendered component)', () => {
  it('shows a live transcript while the canonical capture is still capturing', async () => {
    apiGet.mockImplementation((url: string) => {
      if (url === '/api/legiwatch/live-hearings/events/cm-119-9001') {
        return Promise.resolve({ data: { ...DETAIL_EVENT, eventStatus: 'in_progress', capture: { id: 'cap-1', status: 'capturing' } } });
      }
      const hit = wireGet(url);
      return hit ? Promise.resolve(hit) : Promise.reject(new Error(`unexpected GET ${url}`));
    });
    renderRoutes(MemoryRouter, '/legiwatch/hearings/cm-119-9001');
    // Click the Transcript tab to reveal the transcript panel
    fireEvent.click(await screen.findByRole('tab', { name: 'Transcript' }));
    const transcript = await screen.findByLabelText('Transcript');
    expect(await within(transcript).findByText('The committee will come to order.')).toBeTruthy();
    expect(within(transcript).getByText(/Capture is in progress/i)).toBeTruthy();
  });

  it('loads archive evidence beyond 500 segments and honors its router fragment', async () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    const segments = Array.from({ length: 501 }, (_, index) => ({
      id: `long-seg-${index + 1}`, sequence: index + 1, text: `Archive segment ${index + 1}`,
      startMs: index * 20_000, endMs: (index + 1) * 20_000, isFinal: true,
    }));
    apiGet.mockImplementation((url: string) => {
      if (url.startsWith('/api/legiwatch/live-hearings/events/cm-119-9001/transcript')) {
        const cursor = new URL(url, 'https://example.test').searchParams.get('cursor');
        return Promise.resolve({ data: { items: cursor ? segments.slice(500) : segments.slice(0, 500), total: 501, nextCursor: cursor ? null : 'page-2', hasMore: !cursor, resumeCursor: cursor ? 'end' : 'page-2' } });
      }
      const hit = wireGet(url);
      return hit ? Promise.resolve(hit) : Promise.reject(new Error(`unexpected GET ${url}`));
    });
    renderRoutes(MemoryRouter, '/legiwatch/hearings/cm-119-9001#seg-long-seg-501');
    // The #seg- deep link auto-activates the Transcript tab
    await screen.findByText('Archive segment 501');
    await waitFor(() => expect(scroll.mock.instances).toContain(document.getElementById('lw-seg-long-seg-501')));
    expect(screen.getByText('501 segments from automatic capture')).toBeTruthy();
    scroll.mockRestore();
  });

  it('does not describe an intelligence fetch failure as no extracted intelligence', async () => {
    apiGet.mockImplementation((url: string) => {
      if (url.endsWith('/intelligence')) return Promise.reject(new Error('Network unavailable'));
      const hit = wireGet(url);
      return hit ? Promise.resolve(hit) : Promise.reject(new Error(`unexpected GET ${url}`));
    });
    renderRoutes(MemoryRouter, '/legiwatch/hearings/cm-119-9001');
    fireEvent.click(await screen.findByRole('tab', { name: 'Intelligence' }));
    const intelligence = await screen.findByLabelText('Intelligence');
    await within(intelligence).findByText('Intelligence could not be loaded.');
    expect(intelligence.textContent).not.toMatch(/No intelligence was extracted/i);
  });

  it('keeps partial transcripts visible when capture failed after recording began', async () => {
    apiGet.mockImplementation((url: string) => {
      if (url === '/api/legiwatch/live-hearings/events/cm-119-9001') {
        return Promise.resolve({ data: { ...DETAIL_EVENT, capture: { id: 'cap-1', status: 'FAILED', failureReason: 'STREAM_INTERRUPTED' } } });
      }
      const hit = wireGet(url);
      return hit ? Promise.resolve(hit) : Promise.reject(new Error(`unexpected GET ${url}`));
    });
    renderRoutes(MemoryRouter, '/legiwatch/hearings/cm-119-9001');
    fireEvent.click(await screen.findByRole('tab', { name: 'Transcript' }));
    const transcript = await screen.findByLabelText('Transcript');
    await within(transcript).findByText('The committee will come to order.');
    expect(transcript.textContent).toMatch(/recorded before the failure remains available/i);
    expect(transcript.textContent).not.toMatch(/no transcript was produced/i);
  });

  it('§9 intelligence grounding: evidence button jumps to and highlights the supporting segment', async () => {
    renderRoutes(MemoryRouter, '/legiwatch/hearings/cm-119-9001');
    fireEvent.click(await screen.findByRole('tab', { name: 'Intelligence' }));
    const intel = await screen.findByLabelText('Intelligence');
    const evidenceButton = await within(intel).findByRole('button', { name: /Jump to transcript evidence/i });
    expect(within(intel).getAllByText(/Witness/).length).toBeGreaterThan(0);
    expect(evidenceButton.textContent).toContain('skilled trades');

    fireEvent.click(evidenceButton);
    // jumpToSegment activates the Transcript tab and reveals the segment
    await waitFor(() => expect(document.getElementById('lw-seg-seg-2')).toBeTruthy());
    const seg = document.getElementById('lw-seg-seg-2');
    await waitFor(() => expect(seg!.style.background).not.toBe(''));
  });

  it('clears a transcript search when jumping to evidence hidden by the filter', async () => {
    renderRoutes(MemoryRouter, '/legiwatch/hearings/cm-119-9001');
    fireEvent.click(await screen.findByRole('tab', { name: 'Transcript' }));
    await screen.findByText('The committee will come to order.');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search transcript' }), { target: { value: 'come to order' } });
    expect(document.getElementById('lw-seg-seg-2')).toBeNull();
    fireEvent.click(await screen.findByRole('tab', { name: 'Intelligence' }));
    fireEvent.click(await screen.findByRole('button', { name: /Jump to transcript evidence/i }));
    await waitFor(() => expect(document.getElementById('lw-seg-seg-2')).toBeTruthy());
    expect(screen.getByRole('textbox', { name: 'Search transcript' })).toHaveValue('');
    expect(document.getElementById('lw-seg-seg-2')!.style.background).not.toBe('');
  });

  it('§8 PROCESSING extraction never renders as "no intelligence was extracted"', async () => {
    apiGet.mockImplementation((url: string) => {
      if (url === '/api/legiwatch/live-hearings/events/cm-119-9001/intelligence') {
        return Promise.resolve({ data: { status: 'PROCESSING', items: [], jobs: { public: { pending: 1 } } } });
      }
      if (url.startsWith('/api/legiwatch/live-hearings/events/cm-119-9001/transcript')) {
        return Promise.resolve({ data: { items: [{ id: 'seg-1', sequence: 1, startMs: 0, endMs: 1000, text: 'Opening.', speakerLabel: 'Chair', isFinal: true, hasGapBefore: false }], total: 1, nextCursor: null, hasMore: false } });
      }
      const hit = wireGet(url);
      if (!hit) return Promise.reject(new Error(`unexpected GET ${url}`));
      return Promise.resolve(hit);
    });
    renderRoutes(MemoryRouter, '/legiwatch/hearings/cm-119-9001');
    fireEvent.click(await screen.findByRole('tab', { name: 'Intelligence' }));
    const intel = await screen.findByLabelText('Intelligence');
    await waitFor(() => expect(intel.textContent).toMatch(/extraction is in progress/i));
    expect(intel.textContent).not.toMatch(/No intelligence was extracted/i);
  });

  it('UNKNOWN access never renders CLOSED SESSION (LW-QA-002 at the component level)', async () => {
    apiGet.mockImplementation((url: string) => {
      if (url === '/api/legiwatch/live-hearings/events/cm-119-9001') {
        return Promise.resolve({
          data: { ...DETAIL_EVENT, publicAccessStatus: 'UNKNOWN', eventStatus: 'COMPLETED' },
        });
      }
      const hit = wireGet(url);
      if (!hit) return Promise.reject(new Error(`unexpected GET ${url}`));
      return Promise.resolve(hit);
    });
    renderRoutes(MemoryRouter, '/legiwatch/hearings/cm-119-9001');
    await waitFor(() => expect(screen.getByText('ACCESS UNVERIFIED')).toBeTruthy());
    expect(screen.queryByText('CLOSED SESSION')).toBeNull();
  });
});

// ── LW-QA-018 ───────────────────────────────────────────────────────────────

/** The Committee Room row's "when · status" line, read from the redesigned
 *  TimelineRow: the when-stamp and the status label, joined the way the
 *  parity assertion compares against Hearing Detail. */
async function roomRowMeta(): Promise<string> {
  const room = await screen.findByLabelText('Committee room: Armed Services Committee (detail test)');
  const past = within(room).getByLabelText('Past hearings');
  const row = within(past).getByRole('button', { name: /Shipbuilding industrial base oversight/i });
  const when = (row.querySelector('.lwcr-event__when')?.textContent ?? '').trim();
  const status = (row.querySelector('.lwcr-event__meta .lwcr-update__type')?.textContent ?? '').trim();
  return `${when} · ${status}`;
}

describe('LW-QA-018 — one hearing, one rendering, on every surface', () => {
  it('counts recent proceedings in the tab when nothing is upcoming', async () => {
    apiGet.mockImplementation((url: string) => {
      if (url === '/api/legiwatch/live-hearings/committees/hs00-lwdt') {
        return Promise.resolve({ data: roomWith({
          upcomingEvents: [], upcomingEventCount: 0, recentEventCount: 10,
        }) });
      }
      const hit = wireGet(url);
      return hit ? Promise.resolve(hit) : Promise.reject(new Error(`unexpected GET ${url}`));
    });
    renderRoutes(MemoryRouter, '/legiwatch/committees/hs00-lwdt');
    expect(await screen.findByRole('tab', { name: /^Proceedings\s*10$/ })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /^Proceedings\s*0$/ })).toBeNull();
    expect(await roomRowMeta()).toBe('Wed, Sep 2, 2026 · 10:00 AM ET · Completed');
  });

  it('Committee Room renders the same day, time and status as Hearing Detail for the SAME wire row', async () => {
    renderRoutes(MemoryRouter, '/legiwatch/committees/hs00-lwdt');
    const roomMeta = await roomRowMeta();

    // The real day and time, not the blank-date / "Time not announced" pair an
    // unnormalized row produced.
    expect(roomMeta).toBe('Wed, Sep 2, 2026 · 10:00 AM ET · Completed');

    cleanup();
    renderRoutes(MemoryRouter, '/legiwatch/hearings/cm-119-9001');
    await screen.findByRole('heading', { name: /Shipbuilding industrial base oversight/i });
    const detailWhen = (document.querySelector('.lw-detail__when')?.textContent ?? '').trim();
    const detailPills = [...document.querySelectorAll('.lw-pill')].map((p) => (p.textContent ?? '').trim());
    expect(`${detailWhen} · ${detailPills.find((p) => p === 'Completed')}`).toBe(roomMeta);
  });

  it('labels a past scheduled source record as outcome unconfirmed rather than completed', async () => {
    apiGet.mockImplementation((url: string) => {
      if (url === '/api/legiwatch/live-hearings/committees/hs00-lwdt') {
        return Promise.resolve({ data: roomWith({ recentEvents: [calRow({ eventStatus: 'scheduled' })] }) });
      }
      const hit = wireGet(url);
      if (!hit) return Promise.reject(new Error(`unexpected GET ${url}`));
      return Promise.resolve(hit);
    });
    renderRoutes(MemoryRouter, '/legiwatch/committees/hs00-lwdt');
    expect(await roomRowMeta()).toBe('Wed, Sep 2, 2026 · 10:00 AM ET · Past · outcome unconfirmed');
    // The bucket is a date window, so its heading must not assert completion.
    expect(screen.queryByLabelText('Recent & completed hearings')).toBeNull();
  });

  it('a date-only hearing shows its official day and never a fabricated time', async () => {
    apiGet.mockImplementation((url: string) => {
      if (url === '/api/legiwatch/live-hearings/committees/hs00-lwdt') {
        return Promise.resolve({ data: roomWith({ recentEvents: [calRow({ startsAt: null, time: null })] }) });
      }
      const hit = wireGet(url);
      if (!hit) return Promise.reject(new Error(`unexpected GET ${url}`));
      return Promise.resolve(hit);
    });
    renderRoutes(MemoryRouter, '/legiwatch/committees/hs00-lwdt');
    expect(await roomRowMeta()).toBe('Wed, Sep 2, 2026 · Time not announced · Completed');
  });
});

describe('LW-QA-018 — Committee Room provenance strip (redesigned)', () => {
  async function renderRoom(overrides: Record<string, unknown>): Promise<HTMLElement> {
    apiGet.mockImplementation((url: string) => {
      if (url === '/api/legiwatch/live-hearings/committees/hs00-lwdt') {
        return Promise.resolve({ data: roomWith(overrides) });
      }
      const hit = wireGet(url);
      if (!hit) return Promise.reject(new Error(`unexpected GET ${url}`));
      return Promise.resolve(hit);
    });
    renderRoutes(MemoryRouter, '/legiwatch/committees/hs00-lwdt');
    return screen.findByLabelText('Committee room: Armed Services Committee (detail test)');
  }

  it('reports empty inherited child coverage as unverified, not verified absence', async () => {
    const room = await renderRoom({
      isSubcommittee: true, sourceHealth: 'healthy', sourceHealthInheritedFrom: 'ssas00',
      parentSystemCode: 'ssas00', recentEvents: [], upcomingEvents: [],
    });
    expect(within(room).getByText('No proceedings are available in Capiro for these windows.')).toBeTruthy();
    expect(within(room).getByText(/Subcommittee coverage is incomplete or unverified/)).toBeTruthy();
    expect(within(room).getByText('Parent monitored source only')).toBeTruthy();
    expect(within(room).queryByText(/has published no/)).toBeNull();
    expect(within(room).queryByText(/Calendar page and Congress.gov/)).toBeNull();
    expect(within(room).getAllByText('in Capiro')).toHaveLength(2);
  });

  it.each(['healthy', 'failing', 'degraded', 'unknown'])('never turns empty %s source results into a complete-coverage assertion', async (sourceHealth) => {
    const room = await renderRoom({ sourceHealth, recentEvents: [], upcomingEvents: [] });
    expect(within(room).getByText('No proceedings are available in Capiro for these windows.')).toBeTruthy();
    expect(within(room).queryByText(/has published no/)).toBeNull();
    expect(within(room).queryByText(/not a gap in coverage/)).toBeNull();
    if (sourceHealth === 'failing' || sourceHealth === 'degraded') {
      expect(within(room).getByText(/monitored source needs attention/)).toBeTruthy();
    }
  });

  it('maps health from the OUTER response level and reads the four real fields', async () => {
    const room = await renderRoom({});
    // The redesigned strip: a "Healthy" word next to its dot (never colour-only),
    // and the two distinct timestamps as their own cells.
    expect(within(room).getByText('Source health')).toBeTruthy();
    expect(within(room).getByText('Healthy')).toBeTruthy();
    expect(within(room).getByText('Last source success')).toBeTruthy();
    expect(within(room).getByText('Committee record')).toBeTruthy();
    expect(within(room).getByText('Next refresh')).toBeTruthy();
    expect(within(room).getByText('Monitored source')).toBeTruthy();
  });

  it.each([
    ['degraded', 'Degraded'],
    ['failing', 'Failing'],
    ['unknown', 'Not yet read'],
  ])('renders %s as %s', async (health, label) => {
    const room = await renderRoom({ sourceHealth: health });
    const cell = within(room).getByText('Source health').closest('.lwcr-ledger__cell') as HTMLElement;
    expect(within(cell).getByText(label)).toBeTruthy();
  });

  it('an absent or unrecognised health value still renders "Not yet read", never nothing', async () => {
    const room = await renderRoom({ sourceHealth: undefined });
    const cell = within(room).getByText('Source health').closest('.lwcr-ledger__cell') as HTMLElement;
    expect(within(cell).getByText('Not yet read')).toBeTruthy();
    cleanup();
    const room2 = await renderRoom({ sourceHealth: 'wedged' });
    const cell2 = within(room2).getByText('Source health').closest('.lwcr-ledger__cell') as HTMLElement;
    expect(within(cell2).getByText('Not yet read')).toBeTruthy();
  });

  it('inherited health names the parent it was inherited from', async () => {
    const room = await renderRoom({ sourceHealth: 'healthy', sourceHealthInheritedFrom: 'hs00-parent' });
    const cell = within(room).getByText('Source health').closest('.lwcr-ledger__cell') as HTMLElement;
    expect(within(cell).getByText('Inherited from HS00-PARENT')).toBeTruthy();
  });

  it('says "Never read" when no official sync has ever succeeded, instead of hiding the row', async () => {
    const room = await renderRoom({ lastSourceSuccessAt: null });
    const cell = within(room).getByText('Last source success').closest('.lwcr-ledger__cell') as HTMLElement;
    expect(within(cell).getByText('Never read')).toBeTruthy();
  });

  it('a full committee renders Own source and no inherited marker', async () => {
    const room = await renderRoom({ sourceHealthInheritedFrom: null });
    const cell = within(room).getByText('Source health').closest('.lwcr-ledger__cell') as HTMLElement;
    expect(within(cell).getByText('Own source')).toBeTruthy();
  });
});

describe('LW-QA-018/024 — Committee Room official updates', () => {
  it('links an update through its sourceUrl (the only link field on the wire)', async () => {
    renderRoutes(MemoryRouter, '/legiwatch/committees/hs00-lwdt');
    const room = await screen.findByLabelText('Committee room: Armed Services Committee (detail test)');
    const link = within(room).getByRole('link', { name: 'Witness list updated' });
    expect(link.getAttribute('href')).toBe('https://armedservices.house.gov/news');
  });

  it('an update row without a server id keeps the SAME DOM node across a refetch (deterministic key)', async () => {
    const { queryClient } = renderRoutes(MemoryRouter, '/legiwatch/committees/hs00-lwdt');
    const room = await screen.findByLabelText('Committee room: Armed Services Committee (detail test)');
    const updates = within(room).getByLabelText('Official updates');
    const before = within(updates).getByText('Room change posted').closest('li');
    expect(before).toBeTruthy();

    await queryClient.invalidateQueries({ queryKey: ['lw', 'committee-room', 'hs00-lwdt'] });
    await waitFor(() => expect(apiGet.mock.calls.filter(([u]) => u.includes('/committees/hs00-lwdt')).length).toBeGreaterThan(1));

    const after = within(updates).getByText('Room change posted').closest('li');
    // A Math.random() key remounts the row: the node identity changes.
    expect(after).toBe(before);
  });
});

function historySessionUnused(): boolean {
  return true;
}
const historyLabelUnused = historySessionUnused;
const historyCardUnused = historySessionUnused;

// ── Session 53 — tab lifecycle regressions ─────────────────────────────────
// Root review of session 48 found the tab strip (a) cast any URL string into
// a tab id (unknown value → every panel blank), (b) conditionally mounted
// panels so a tab switch destroyed the audio player, the review workspace
// draft and the transcript filter, and (c) gave `#public-audio` deep links no
// tab activation. These tests exercise the REAL route inside the router with
// the retained-audio feature flag served on.

/** wireGet + the retained-audio flag and an audio manifest with one epoch. */
function wireWithRetainedAudio(url: string): { data: unknown } | null {
  if (url === '/intel-api/feature-flags') {
    return { data: { legiwatch_hearing_recording_v1: true } };
  }
  if (url === '/api/clients') {
    return { data: [{ id: 'c1', name: 'Alpha Gov Relations', status: 'active' }] };
  }
  if (url.startsWith('/intel-api/public-hearings/') && url.endsWith('/audio')) {
    return {
      data: {
        epochs: [
          {
            id: 'epoch-1',
            startMs: 0,
            durableEndMs: 120000,
            durableBytes: 640000,
            state: 'ready',
            transcriptState: 'final',
            expiresAt: '2099-01-01',
            reason: null,
          },
        ],
      },
    };
  }
  return wireGet(url);
}

describe('session 53 — tab lifecycle regressions', () => {
  beforeEach(() => {
    apiGet.mockImplementation((url: string) => {
      const hit = wireWithRetainedAudio(url);
      return hit ? Promise.resolve(hit) : Promise.reject(new Error(`unexpected GET ${url}`));
    });
  });

  it('an unknown detailTab query value falls back to Overview, not a blank page', async () => {
    renderRoutes(MemoryRouter, '/legiwatch/hearings/cm-119-9001?detailTab=garbage');
    await screen.findByRole('heading', { name: /Shipbuilding industrial base oversight/i });
    // Overview content is rendered…
    expect(await screen.findByLabelText('Hearing facts')).toBeTruthy();
    // …and the Overview tab is the selected one while the bogus id selects nothing.
    expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true');
    for (const name of ['Live & Capture', 'Transcript', 'Intelligence', 'Client Relevance', 'Sources & Documents']) {
      expect(screen.getByRole('tab', { name }).getAttribute('aria-selected')).toBe('false');
    }
    // Global query context survives alongside the fallback.
    cleanup();
    renderRoutes(MemoryRouter, '/legiwatch/hearings/cm-119-9001?detailTab=bogus&client=acme');
    await screen.findByRole('heading', { name: /Shipbuilding industrial base oversight/i });
    expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true');
  });

  it('every tab control exposes an accessible selected state with the real labels', async () => {
    renderRoutes(MemoryRouter, '/legiwatch/hearings/cm-119-9001');
    await screen.findByRole('heading', { name: /Shipbuilding industrial base oversight/i });
    expect(screen.getByText(/Follow sends updates/i)).toBeTruthy();
    expect(screen.getByText(/Automatic recording runs on the server when the source permits it/i)).toBeTruthy();
    const labels = ['Overview', 'Live & Capture', 'Transcript', 'Intelligence', 'Client Relevance', 'Sources & Documents'];
    for (const name of labels) {
      const tab = screen.getByRole('tab', { name });
      expect(tab.getAttribute('aria-selected')).toBe(name === 'Overview' ? 'true' : 'false');
    }
    fireEvent.click(screen.getByRole('tab', { name: 'Transcript' }));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Transcript' }).getAttribute('aria-selected')).toBe('true'),
    );
    expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('false');
  });

  it('incoming #public-audio activates Live & Capture and scrolls to the existing player anchor — once, without trapping later tab switches', async () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    renderRoutes(MemoryRouter, '/legiwatch/hearings/cm-119-9001#public-audio');
    // The player anchor exists (panel stays mounted) and the tab activates.
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Live & Capture' }).getAttribute('aria-selected')).toBe('true'),
    );
    const anchor = document.getElementById('public-audio');
    expect(anchor).toBeTruthy();
    // The spy records the receiver (`this`) of each invocation: the effect
    // calls `anchor.scrollIntoView(...)` on the anchor element itself.
    await waitFor(() => expect(scroll.mock.contexts).toContain(anchor));

    // A later manual tab switch must STICK — the stale hash does not pull the
    // user back to Live & Capture.
    fireEvent.click(screen.getByRole('tab', { name: 'Transcript' }));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Transcript' }).getAttribute('aria-selected')).toBe('true'),
    );
    // Give any stray effect a chance to fire, then assert we're still on Transcript.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole('tab', { name: 'Transcript' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Live & Capture' }).getAttribute('aria-selected')).toBe('false');
    scroll.mockRestore();
  });

  it('incoming #public-audio on a COLD load (deferred event response) still reveals and scrolls once the anchor renders', async () => {
    // Hold the event response until the test releases it: the route renders
    // its loading skeleton first, with no panels and no #public-audio anchor.
    let releaseEvent: (() => void) | null = null;
    const eventGate = new Promise<void>((resolve) => { releaseEvent = resolve; });
    apiGet.mockImplementation((url: string) => {
      if (url === '/api/legiwatch/live-hearings/events/cm-119-9001') {
        return eventGate.then(() => ({ data: DETAIL_EVENT }));
      }
      const hit = wireWithRetainedAudio(url);
      return hit ? Promise.resolve(hit) : Promise.reject(new Error(`unexpected GET ${url}`));
    });
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    renderRoutes(MemoryRouter, '/legiwatch/hearings/cm-119-9001#public-audio');
    // Loading skeleton: no anchor yet, no scroll attempted.
    expect(document.getElementById('public-audio')).toBeNull();

    releaseEvent!();
    // After the event lands the reveal completes: Live & Capture selected and
    // the actual anchor scrolled to, exactly once.
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Live & Capture' }).getAttribute('aria-selected')).toBe('true'),
    );
    const anchor = await waitFor(() => {
      const el = document.getElementById('public-audio');
      expect(el).toBeTruthy();
      return el!;
    });
    await waitFor(() => expect(scroll.mock.contexts).toContain(anchor));
    expect(scroll.mock.contexts.filter((ctx) => ctx === anchor)).toHaveLength(1);
    scroll.mockRestore();
  });

  it('transcript Play audio reveals the Live & Capture tab with the SAME player instance and seeks it', async () => {
    renderRoutes(MemoryRouter, '/legiwatch/hearings/cm-119-9001');
    fireEvent.click(await screen.findByRole('tab', { name: 'Transcript' }));
    const transcript = await screen.findByLabelText('Transcript');
    const playButtons = await within(transcript).findAllByRole('button', { name: 'Play audio' });
    const playerBefore = document.querySelector('#public-audio audio');
    expect(playerBefore).toBeTruthy();

    fireEvent.click(playButtons[1]!); // seg-2 @ 41000ms
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Live & Capture' }).getAttribute('aria-selected')).toBe('true'),
    );
    // Same DOM node — no remount — and the seek posted to the playback endpoint.
    expect(document.querySelector('#public-audio audio')).toBe(playerBefore);
    await waitFor(() =>
      expect(
        apiGet.mock.calls.filter(([u]) => u.includes('/intel-api/public-hearings/')).length,
      ).toBeGreaterThan(0),
    );
    // A second seek from the review panel path (same shared callback) keeps the instance.
    fireEvent.click(screen.getByRole('tab', { name: 'Transcript' }));
    const playButtonsAgain = await within(transcript).findAllByRole('button', { name: 'Play audio' });
    fireEvent.click(playButtonsAgain[0]!); // seg-1 @ 0ms
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Live & Capture' }).getAttribute('aria-selected')).toBe('true'),
    );
    expect(document.querySelector('#public-audio audio')).toBe(playerBefore);
  });

  it('player DOM identity and position survive Capture → Transcript → Capture', async () => {
    // The player posts to the playback endpoint when loading a position.
    apiPost.mockImplementation(async (_url: string, body: unknown) => ({
      data: {
        partId: 'part-0',
        startMs: 0,
        endMs: 120000,
        url: 'https://private.example/part-0',
        expiresAt: '2099-01-01',
      },
    }));
    renderRoutes(MemoryRouter, '/legiwatch/hearings/cm-119-9001?detailTab=live-capture');
    const audio = (await waitFor(() => {
      const el = document.querySelector('#public-audio audio');
      expect(el).toBeTruthy();
      return el as HTMLAudioElement;
    })) as HTMLAudioElement;
    // Drive a real load so the player has a part, then simulate playback progress.
    fireEvent.click(await screen.findByRole('button', { name: 'Play from position' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    fireEvent.timeUpdate(audio, { target: { currentTime: 12.5 } });

    fireEvent.click(screen.getByRole('tab', { name: 'Transcript' }));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Transcript' }).getAttribute('aria-selected')).toBe('true'),
    );
    // Still the SAME node, now behind the hidden panel.
    expect(document.querySelector('#public-audio audio')).toBe(audio);

    fireEvent.click(screen.getByRole('tab', { name: 'Live & Capture' }));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Live & Capture' }).getAttribute('aria-selected')).toBe('true'),
    );
    expect(document.querySelector('#public-audio audio')).toBe(audio);
    // The position slider kept its value (12500ms) across the round trip.
    const slider = screen.getByRole('slider', { name: 'Seek saved server audio' }) as HTMLInputElement;
    expect(slider.value).toBe('12500');
  });

  it('transcript search filter survives a tab switch and back (panels stay mounted)', async () => {
    renderRoutes(MemoryRouter, '/legiwatch/hearings/cm-119-9001');
    fireEvent.click(await screen.findByRole('tab', { name: 'Transcript' }));
    await screen.findByText('The committee will come to order.');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search transcript' }), { target: { value: 'come to order' } });
    expect(document.getElementById('lw-seg-seg-2')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Intelligence' }));
    await screen.findByLabelText('Intelligence');
    fireEvent.click(screen.getByRole('tab', { name: 'Transcript' }));
    // The filter text is still there after the round trip — not reset.
    expect(screen.getByRole('textbox', { name: 'Search transcript' })).toHaveValue('come to order');
  });

  it('inactive panels are actually display:none even with the author flex/grid panel CSS', async () => {
    renderRoutes(MemoryRouter, '/legiwatch/hearings/cm-119-9001');
    await screen.findByRole('heading', { name: /Shipbuilding industrial base oversight/i });
    const panel = (id: string) => document.getElementById(`lw-detail-panel-${id}`)!;
    // Overview active: every other panel computes to display:none…
    expect(window.getComputedStyle(panel('overview')).display).not.toBe('none');
    for (const id of ['live-capture', 'transcript', 'intelligence', 'client-relevance', 'sources-documents']) {
      expect(window.getComputedStyle(panel(id)).display).toBe('none');
    }
    // …and the hidden panel carries the hidden attribute as well.
    expect(panel('transcript').hasAttribute('hidden')).toBe(true);
    fireEvent.click(screen.getByRole('tab', { name: 'Transcript' }));
    await waitFor(() => expect(window.getComputedStyle(panel('transcript')).display).not.toBe('none'));
    expect(window.getComputedStyle(panel('overview')).display).toBe('none');
  });

  it('tab and client-lens changes preserve the incoming Back location state (return URL + scroll)', async () => {
    const returnTo = '/legiwatch/hearings?calendarDate=2026-02-24&calendarQ=Shipbuilding';
    const { location } = renderRoutes(MemoryRouter, '', [
      { pathname: '/legiwatch/hearings/cm-119-9001', state: { legiwatchReturnTo: returnTo, legiwatchScrollY: 432 } },
    ]);
    await screen.findByRole('heading', { name: /Shipbuilding industrial base oversight/i });

    // Switch tabs — the search param write must carry the location state along.
    fireEvent.click(screen.getByRole('tab', { name: 'Transcript' }));
    await waitFor(() => expect(new URLSearchParams(location.current.search).get('detailTab')).toBe('transcript'));
    expect((location.current.state as { legiwatchReturnTo?: string })?.legiwatchReturnTo).toBe(returnTo);
    expect((location.current.state as { legiwatchScrollY?: number })?.legiwatchScrollY).toBe(432);

    // Change the client lens — same contract.
    fireEvent.change(screen.getByLabelText('Client'), { target: { value: 'c1' } });
    await waitFor(() => expect(new URLSearchParams(location.current.search).get('client')).toBe('c1'));
    expect((location.current.state as { legiwatchReturnTo?: string })?.legiwatchReturnTo).toBe(returnTo);

    // Back navigates to the ORIGINAL calendar-filter URL, and the navigate
    // carries the scroll offset in location state. HearingsTab's
    // calendar-param normalization write (its effect runs BEFORE the calendar
    // query resolves) must forward that state, and once the calendar loads
    // the scroll-restore effect fires window.scrollTo with the offset.
    const scrollToSpy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    fireEvent.click(screen.getByText('← Back to LegiWatch'));
    await waitFor(() => expect(location.current.pathname).toBe('/legiwatch/hearings'));
    const backParams = new URLSearchParams(location.current.search);
    expect(backParams.get('calendarDate')).toBe('2026-02-24');
    expect(backParams.get('calendarQ')).toBe('Shipbuilding');
    // The state survived HearingsTab's normalization write…
    expect((location.current.state as { legiwatchScrollY?: number } | null)?.legiwatchScrollY).toBe(432);
    // …and the REAL scroll restore fired once the calendar rendered.
    await waitFor(() => expect(scrollToSpy).toHaveBeenCalledWith(0, 432));
    scrollToSpy.mockRestore();
  });

  it('Florida hearing detail links to the state committee profile by stable identity', async () => {
    apiGet.mockImplementation((url: string) => {
      if (url === '/api/legiwatch/live-hearings/events/cm-119-9001')
        return Promise.resolve({
          data: calRow({
            geographicJurisdiction: 'FL',
            legislativeSession: '2026',
            stateCommitteeId: 'FL-upper-criminal-justice',
            committeeName: 'Criminal Justice',
            committeeSystemCode: null,
          }),
        });
      const hit = wireGet(url);
      return hit ? Promise.resolve(hit) : Promise.reject(new Error(`unexpected GET ${url}`));
    });
    const { location } = renderRoutes(MemoryRouter, '/legiwatch/hearings/cm-119-9001');
    await screen.findByRole('heading', { name: /Shipbuilding industrial base oversight/i });
    fireEvent.click(screen.getByRole('button', { name: 'Criminal Justice' }));
    await waitFor(() =>
      expect(location.current.pathname).toBe('/directory/state-committees/FL-upper-criminal-justice'),
    );
    expect(screen.getByTestId('state-committee-profile')).toBeInTheDocument();
  });

  it('Florida hearing detail uses the same Live & Capture room contract as federal', async () => {
    apiGet.mockImplementation((url: string) => {
      if (url === '/api/legiwatch/live-hearings/events/cm-119-9001')
        return Promise.resolve({ data: calRow({
          geographicJurisdiction: 'FL', legislativeSession: '2026',
          stateCommitteeId: 'official-criminal-justice', committeeName: 'Criminal Justice',
          committeeSystemCode: null, capture: null,
          streamAvailability: 'live_only', coverageStatus: 'stream_ready',
        }) });
      const hit = wireGet(url);
      return hit ? Promise.resolve(hit) : Promise.reject(new Error(`unexpected GET ${url}`));
    });
    renderRoutes(MemoryRouter, '/legiwatch/hearings/cm-119-9001?detailTab=live-capture');
    await screen.findByRole('heading', { name: /Shipbuilding industrial base oversight/i });
    expect(screen.getByRole('tab', { name: 'Live & Capture' })).toHaveAttribute('aria-selected', 'true');
    const panel = screen.getByRole('tabpanel', { name: 'Live and capture panel' });
    expect(within(panel).getByRole('heading', { name: 'Live & Capture' })).toBeInTheDocument();
    expect(within(panel).getByText('No automatic capture requested')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Follow' })).toBeInTheDocument();
    expect(within(panel).getByText(/No capture mode is available/)).toBeInTheDocument();
  });

  it('Florida hearing detail accepts a state committee profile as its safe Back target', async () => {
    const returnTo = '/directory/state-committees/official-criminal-justice';
    const { location } = renderRoutes(MemoryRouter, '', [
      {
        pathname: '/legiwatch/hearings/cm-119-9001',
        state: { legiwatchReturnTo: returnTo },
      },
    ]);
    await screen.findByRole('heading', { name: /Shipbuilding industrial base oversight/i });
    fireEvent.click(screen.getByText('← Back to LegiWatch'));
    await waitFor(() => expect(location.current.pathname).toBe(returnTo));
  });
});

describe('UI audit hearing evidence and recording affordances', () => {
  it('does not offer transcript playback when the recording manifest contains no retained audio', async () => {
    apiGet.mockImplementation(async (url) => {
      if (url.startsWith('/intel-api/public-hearings/') && url.endsWith('/audio')) return { data: { epochs: [] } };
      const hit = wireWithRetainedAudio(url);
      if (!hit) throw new Error(`unexpected GET ${url}`);
      return hit;
    });
    renderRoutes(MemoryRouter, '/legiwatch/hearings/cm-119-9001?detailTab=transcript');
    const transcript = await screen.findByLabelText('Transcript');
    await within(transcript).findByText('The committee will come to order.');
    await waitFor(() => expect(apiGet.mock.calls.some(([url]) => url.endsWith('/audio'))).toBe(true));
    expect(within(transcript).queryByRole('button', { name: 'Play audio' })).toBeNull();
  });

  it('exposes collected source documents and labels the timeline observation date honestly', async () => {
    apiGet.mockImplementation(async (url) => {
      if (url === '/api/legiwatch/live-hearings/events/cm-119-9001') return { data: { ...DETAIL_EVENT,
        officialPageUrl: 'https://armed-services.senate.gov/hearings/source',
        documents: [{ id: 'testimony', title: 'Witness prepared testimony', sourceUrl: 'https://www.senate.gov/testimony.pdf', documentType: 'testimony' }],
        agenda: [{ key: 'agenda', position: 0, kind: 'agenda', title: 'Published agenda', sourceUrl: 'https://www.senate.gov/agenda.pdf' }],
      } };
      if (url.endsWith('/updates')) return { data: { updates: [{ id: 'observed', title: 'Hearing announced', firstSeenAt: '2026-10-05T10:00:00Z' }] } };
      const hit = wireGet(url); if (!hit) throw new Error(`unexpected GET ${url}`); return hit;
    });
    renderRoutes(MemoryRouter, '/legiwatch/hearings/cm-119-9001?detailTab=sources-documents');
    const sources = await screen.findByLabelText('Sources and documents');
    expect((await within(sources).findByRole('link', { name: 'Witness prepared testimony' })).getAttribute('href')).toBe('https://www.senate.gov/testimony.pdf');
    expect(within(sources).getByRole('link', { name: 'Published agenda' })).toBeTruthy();
    expect(await within(sources).findByText(/2026 · Observed/)).toBeTruthy();
  });

  it('shows attempt dates and lets the user exclude explicitly labeled QA sessions', async () => {
    apiGet.mockImplementation(async (url) => {
      if (url.startsWith('/intel-api/hearings/history?')) return { data: { items: [
        { ...HISTORY_SESSION, startedAt: '2025-02-09T14:00:00Z', audioSource: 'browser_tab', recordingPolicy: 'transcript_only' },
        { ...HISTORY_SESSION, id: 'qa-attempt', title: 'QA test recording', audioSource: 'browser_tab' },
      ], total: 2, hasMore: false, nextCursor: null } };
      const hit = wireGet(url); if (!hit) throw new Error(`unexpected GET ${url}`); return hit;
    });
    renderRoutes(MemoryRouter, '/legiwatch/hearings?sub=sessions');
    await screen.findByRole('button', { name: 'Open QA test recording' });
    expect(screen.getByText(/Feb 9, 2025/)).toBeTruthy();
    expect(screen.getByText(/Transcript only; audio not retained/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hide titles marked test or QA' }));
    expect(screen.queryByRole('button', { name: 'Open QA test recording' })).toBeNull();
    expect(screen.getByRole('button', { name: `Open ${HISTORY_SESSION.title}` })).toBeTruthy();
  });
});
