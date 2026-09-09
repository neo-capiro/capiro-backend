/**
 * PR D / LW-QA-011 — responsive hearings (768px agenda mode).
 *
 * QA failure: at 768px the seven-day calendar compressed to ~90px columns.
 * Fix: below 900px the schedule renders agenda/list layout TEMPORARILY — the
 * view control is disabled with the reason named, and the override is never
 * persisted as the user's preference (§9: desktop preference survives).
 *
 * jsdom cannot resize, so this test pins the PURE decision + the rendered
 * behavior at the hook's boundary: the effective-view logic is exercised via
 * the real component with matchMedia stubbed to the narrow state.
 */
import { createElement } from 'react';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.fn<(url: string) => Promise<{ data: unknown }>>();
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: (url: string) => apiGet(url) }),
}));
vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ isLoaded: true, getToken: async () => 't', orgId: null, userId: 'u-1' }),
  useUser: () => ({ user: { id: 'u-1' } }),
}));

import { HearingsTab } from './HearingsTab.js';

let narrow = false;
// jsdom has no real matchMedia; setup.ts installs a static one on `window`
// itself. Override THAT (window.matchMedia shadows globalThis in the component)
// with a LIVE stub: retained per-query MQLs whose listeners fire when the test
// flips `narrow`, mirroring a real browser resize.
const mqListeners = new Map<string, Set<(ev: { matches: boolean }) => void>>();
function liveMatchMedia(query: string): MediaQueryList {
  return {
    get matches() {
      return narrow && query.includes('max-width: 899px');
    },
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: (_: string, cb: (ev: { matches: boolean }) => void) => {
      const set = mqListeners.get(query) ?? new Set();
      set.add(cb);
      mqListeners.set(query, set);
    },
    removeEventListener: (_: string, cb: (ev: { matches: boolean }) => void) => {
      mqListeners.get(query)?.delete(cb);
    },
    dispatchEvent: () => false,
  } as unknown as MediaQueryList;
}
window.matchMedia = liveMatchMedia;
function flipNarrow(next: boolean): void {
  narrow = next;
  const set = mqListeners.get('(max-width: 899px)');
  if (set) for (const cb of [...set]) cb({ matches: next });
}

function calRow(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'cm-119-9001',
    title: 'Shipbuilding industrial base oversight',
    chamber: 'House',
    eventType: 'hearing',
    eventStatus: 'completed',
    visibility: 'public',
    date: new Date().toISOString().slice(0, 10),
    scheduledStart: `${new Date().toISOString().slice(0, 10)}T14:00:00Z`,
    time: '10:00 AM',
    timezone: 'America/New_York',
    committeeName: 'Armed Services Committee (detail test)',
    committeeSystemCode: 'hs00-lwdt',
    witnesses: [],
    streamAvailability: 'archived',
    coverageStatus: 'captured',
    sourceRevision: 1,
    capture: null,
    subscription: null,
    ...partial,
  };
}

beforeEach(() => {
  narrow = false;
  apiGet.mockReset();
  apiGet.mockImplementation(((url: string) => {
    if (url.startsWith('/api/legiwatch/live-hearings/calendar?')) {
      return {
        data: {
          items: [calRow({})],
          total: 1,
        },
      };
    }
    if (url.startsWith('/intel-api/hearings/history?')) {
      return { data: { items: [], total: 0, nextCursor: null, hasMore: false } };
    }
    if (url.startsWith('/intel-api/clients/_all/feed?')) {
      return { data: { items: [], counts: {}, total: 0, hasMore: false, nextCursor: null } };
    }
    if (url.includes('/alerts/work-state')) return { data: {} };
    return Promise.reject(new Error(`unexpected GET ${url}`));
  }) as unknown as typeof apiGet);
});

afterEach(() => {
  cleanup();
});

function renderHearings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } } });
  render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        MemoryRouter,
        { initialEntries: ['/legiwatch/hearings'] },
        createElement(
          Routes,
          null,
          createElement(Route, { path: '/legiwatch/hearings', element: <HearingsTab scope="" /> }),
        ),
      ),
    ),
  );
}

describe('LW-QA-011 — responsive hearings view-mode', () => {
  it('desktop (>=900): the user-selected Calendar view renders the seven-day grid', async () => {
    narrow = false;
    renderHearings();
    await screen.findByLabelText('Week calendar');
    const seg = screen.getByLabelText('Schedule view');
    expect(seg.getAttribute('aria-disabled')).toBeNull();
    // The user can switch to Agenda on desktop.
    fireEvent.click(within(seg).getByText('Agenda'));
    await waitFor(() => expect(screen.queryByLabelText('Week calendar')).toBeNull());
  });

  it('narrow (<900): agenda/list mode renders instead of the compressed grid; control disabled with reason', async () => {
    flipNarrow(true);
    renderHearings();
    await screen.findByLabelText('Schedule list');
    expect(screen.queryByLabelText('Week calendar')).toBeNull();
    const seg = screen.getByLabelText('Schedule view');
    expect(seg.getAttribute('aria-disabled')).toBe('true');
    // Honest reason is visible; the saved choice is never overwritten.
    expect(screen.getByText(/Agenda layout at this width/)).toBeTruthy();
  });

  it('§9 preference preservation: switching narrow→wide restores Calendar without the user re-choosing', async () => {
    // The saved desktop preference is component state seeded from settings;
    // the responsive override only changes effectiveView. Pin the contract:
    // returning wide renders calendar again with the control re-enabled.
    flipNarrow(true);
    renderHearings();
    await screen.findByLabelText('Schedule list');
    flipNarrow(false);
    await waitFor(() => expect(screen.getByLabelText('Week calendar')).toBeTruthy(), { timeout: 3000 });
    expect(screen.getByLabelText('Schedule view').getAttribute('aria-disabled')).toBeNull();
  });
});