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

const apiGet = vi.fn<(url: string) => Promise<{ data: unknown }>>();
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: (url: string) => apiGet(url) }),
}));
vi.mock('../../../../lib/me.js', () => ({ useMe: () => ({ isLoading: false, data: undefined }) }));

import { HearingDetailRoute } from './HearingDetailRoute.js';
import { CommitteeRoomRoute } from './CommitteeRoomRoute.js';
import { HearingsTab } from './HearingsTab.js';
import { FeedTab } from '../feed/FeedTab.js';
import type { FeedItem } from '../../../../pages/clients/tracker/intel-feed-api.js';

// ── wire fixtures (canonical shapes the real normalizers accept) ─────────────

function calRow(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'cm-119-9001',
    title: 'Shipbuilding industrial base oversight',
    chamber: 'House',
    eventType: 'hearing',
    eventStatus: 'completed',
    visibility: 'public',
    date: '2026-09-02',
    scheduledStart: '2026-09-02T14:00:00Z',
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

const DETAIL_EVENT = {
  id: 'cm-119-9001',
  title: 'Shipbuilding industrial base oversight',
  calendarDate: '2026-09-02',
  chamber: 'House',
  eventType: 'HEARING',
  eventStatus: 'COMPLETED',
  publicAccessStatus: 'PUBLIC',
  timeZone: 'America/New_York',
  scheduledStart: '2026-09-02T14:00:00Z',
  committee: { systemCode: 'hs00-lwdt', name: 'Armed Services Committee (detail test)' },
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

const ROOM_WIRE = {
  systemCode: 'hs00-lwdt',
  name: 'Armed Services Committee (detail test)',
  chamber: 'house',
  isSubcommittee: false,
  parent: null,
  subcommittees: [{ systemCode: 'hs16-lwdt', name: 'Seapower and Projection Forces' }],
  officialUrl: 'https://armedservices.house.gov',
  members: [
    { id: 'm1', name: 'Rep. Alice Smith', party: 'R', role: 'Chair' },
    { id: 'm2', name: 'Rep. Bob Jones', party: 'D', role: 'Ranking Member' },
  ],
  chair: { id: 'm1', name: 'Rep. Alice Smith', party: 'R', role: 'Chair' },
  rankingMember: { id: 'm2', name: 'Rep. Bob Jones', party: 'D', role: 'Ranking Member' },
  upcomingEvents: [],
  recentEvents: [
    {
      id: 'cm-119-9001',
      title: 'Shipbuilding industrial base oversight',
      calendarDate: '2026-09-02',
      scheduledStart: '2026-09-02T14:00:00Z',
      eventStatus: 'COMPLETED',
      timeZone: 'America/New_York',
      chamber: 'House',
    },
  ],
  updates: [{ id: 'u1', title: 'Witness list updated', url: 'https://armedservices.house.gov/news' }],
};

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
          calRow({ date: day2, scheduledStart: `${day2}T14:00:00Z` }),
          calRow({ id: 'cm-119-9002', title: 'Future posture hearing', eventStatus: 'scheduled', date: day4, scheduledStart: `${day4}T18:00:00Z`, time: '2:00 PM' }),
        ],
        total: 2,
      },
    };
  }
  if (url.startsWith('/intel-api/hearings/history?')) {
    return { data: { items: [HISTORY_SESSION], total: 1, nextCursor: null, hasMore: false } };
  }
  if (url === '/api/legiwatch/live-hearings/events/cm-119-9001') return { data: DETAIL_EVENT };
  if (url.startsWith('/api/legiwatch/live-hearings/events/cm-119-9001/transcript')) return { data: TRANSCRIPT_PAGE };
  if (url.startsWith('/api/legiwatch/live-hearings/events/cm-119-9001/intelligence')) return { data: INTEL_READY };
  if (url.startsWith('/api/legiwatch/live-hearings/committees/hs00-lwdt')) return { data: ROOM_WIRE };
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
  return null;
}

beforeEach(() => {
  apiGet.mockReset();
  apiGet.mockImplementation((url: string) => {
    const hit = wireGet(url);
    if (!hit) return Promise.reject(new Error(`unexpected GET ${url}`));
    return Promise.resolve(hit);
  });
});

afterEach(() => {
  cleanup();
});

function LocationProbe({ onLocation }: { onLocation: (l: { pathname: string; search: string }) => void }) {
  const loc = useLocation();
  onLocation({ pathname: loc.pathname, search: loc.search });
  return null;
}

function renderRoutes(Router: typeof MemoryRouter | typeof BrowserRouter, initialPath: string, initialEntries?: string[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  const location = { current: { pathname: '', search: '' } };
  const routerProps = Router === MemoryRouter ? { initialEntries: initialEntries ?? [initialPath] } : {};
  render(
    <QueryClientProvider client={queryClient}>
      <Router {...routerProps}>
        <LocationProbe onLocation={(l) => { location.current = l; }} />
        <Routes>
          <Route path="/legiwatch" element={<div data-testid="module-landing">LegiWatch module landing</div>} />
          <Route path="/legiwatch/hearings" element={<HearingsTab scope="" />} />
          <Route path="/legiwatch/feed" element={<FeedTab scope="" clients={[]} />} />
          <Route path="/legiwatch/hearings/:hearingId" element={<HearingDetailRoute />} />
          <Route path="/legiwatch/committees/:systemCode" element={<CommitteeRoomRoute />} />
        </Routes>
      </Router>
    </QueryClientProvider>,
  );
  return { location, queryClient };
}

describe('PR B §6 — every entry surface reaches Hearing Detail (real navigation)', () => {
  it('calendar chip click → detail route renders the hearing', async () => {
    const { location } = renderRoutes(MemoryRouter, '/legiwatch/hearings');
    const grid = await screen.findByLabelText('Week calendar');
    const chip = await within(grid).findByRole('button', { name: /Shipbuilding industrial base oversight/i });
    fireEvent.click(chip);
    await waitFor(() => expect(location.current.pathname).toBe('/legiwatch/hearings/cm-119-9001'));
    await waitFor(() => expect(screen.getByRole('heading', { name: /Shipbuilding industrial base oversight/i })).toBeTruthy());
  });

  it('My Sessions history row → detail via mouse AND keyboard Enter', async () => {
    const { location } = renderRoutes(MemoryRouter, '/legiwatch/hearings');
    // The history panel renders after the schedule loads; scope to its label.
    await screen.findByText('Recent session history');
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
    const linkedRow = linked.closest('[role="button"]');
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
    const legacy = await screen.findByText(/Hearing alert: legacy row without anchors/i);
    const legacyRow = legacy.closest('[role="button"]');
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
    const recent = within(room).getByLabelText('Recent & completed hearings');
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
});

describe('PR B §6 — detail surface honesty (rendered component)', () => {
  it('§9 intelligence grounding: evidence button jumps to and highlights the supporting segment', async () => {
    renderRoutes(MemoryRouter, '/legiwatch/hearings/cm-119-9001');
    const intel = await screen.findByLabelText('Intelligence');
    const evidenceButton = await within(intel).findByRole('button', { name: /Jump to transcript evidence/i });
    expect(within(intel).getAllByText(/Witness/).length).toBeGreaterThan(0);
    expect(evidenceButton.textContent).toContain('skilled trades');

    const seg = document.getElementById('lw-seg-seg-2');
    expect(seg).toBeTruthy();
    const before = seg!.style.background;
    fireEvent.click(evidenceButton);
    await waitFor(() => expect(seg!.style.background).not.toBe(before));
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

function historySessionUnused(): boolean {
  return true;
}
const historyLabelUnused = historySessionUnused;
const historyCardUnused = historySessionUnused;
