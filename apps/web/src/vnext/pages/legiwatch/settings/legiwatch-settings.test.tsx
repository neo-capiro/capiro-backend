/**
 * PR D / LW-QA-013 settings half — LegiWatch Settings tab.
 *
 * Positive: route reachable as a real module tab (deep link + refresh-safe),
 * preference read + write over the REAL per-user contract (PATCH /api/me),
 * unsupported preferences render honestly disabled.
 * NEGATIVE (§13): NO operational controls may ever appear — no phase, CANARY,
 * CUTOVER, kill switch, capture_all_public_events, production_default, Phase 9
 * rules, readiness counters. A stray rollout label fails this test.
 */
import { createElement } from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.fn<(url: string) => Promise<{ data: unknown }>>();
const apiPatch = vi.fn<(url: string, body: unknown) => Promise<{ data: unknown }>>();
const apiPut = vi.fn<(url: string, body: unknown) => Promise<{ data: unknown }>>();
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({
    get: (url: string) => apiGet(url),
    patch: (url: string, body: unknown) => apiPatch(url, body),
    put: (url: string, body: unknown) => apiPut(url, body),
  }),
}));
vi.mock('@clerk/clerk-react', () => ({
  useAuth: () => ({ getToken: async () => 't', orgId: null, userId: 'u-1' }),
  useUser: () => ({ user: { id: 'u-1' } }),
}));

import { LegiWatchSettingsTab } from './LegiWatchSettingsTab.js';

const STORED_PREFS = { timezone: 'America/Los_Angeles', defaultView: 'list' };

/** The fake user row. Reset in beforeEach so a test that writes prefs cannot
 *  leak its state into the next one. */
const ME: { user: { id: string; legiwatchPrefs: Record<string, unknown> } } = {
  user: { id: 'u-1', legiwatchPrefs: { ...STORED_PREFS } },
};

/** Callers get their own copy — React Query must never be handed the mutable row. */
const meDoc = () => ({ user: { ...ME.user, legiwatchPrefs: { ...ME.user.legiwatchPrefs } } });

beforeEach(() => {
  apiGet.mockReset();
  apiPatch.mockReset();
  apiPut.mockReset();
  apiPut.mockImplementation((url: string) => Promise.reject(new Error(`unexpected PUT ${url}`)));
  ME.user.legiwatchPrefs = { ...STORED_PREFS };
  apiGet.mockImplementation((url: string) => {
    if (url.startsWith('/api/me')) return Promise.resolve({ data: meDoc() });
    // Committee email opt-in (committee-follow-alerts) — disabled preference.
    if (url === '/api/legiwatch/live-hearings/notification-preferences') {
      return Promise.resolve({
        data: { committeeEmailEnabled: false, emailAddress: 'u1@example.com' },
      });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  apiPatch.mockImplementation(((url: string, body?: unknown) => {
    if (url === '/api/me') {
      const prefs = ((body ?? {}) as { legiwatchPrefs?: Record<string, unknown> }).legiwatchPrefs ?? {};
      // LW-QA-022: PATCH /api/me replaces `legiwatch_prefs` WHOLESALE
      // (users.controller.ts writes `data.legiwatchPrefs = body.legiwatchPrefs`).
      // The fake must replace too — a merging fake hides the stale-snapshot
      // clobber this suite exists to catch.
      ME.user.legiwatchPrefs = { ...prefs };
      return Promise.resolve({ data: meDoc() });
    }
    return Promise.reject(new Error(`unexpected PATCH ${url}`));
  }) as typeof apiPatch);
});

afterEach(() => {
  cleanup();
});

function SettingsLocation() {
  const location = useLocation();
  return createElement('output', { 'data-testid': 'settings-location' }, `${location.pathname}${location.search}`);
}

function renderSettings(initial = '/legiwatch?tab=settings') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(MemoryRouter, { initialEntries: [initial] }, createElement(LegiWatchSettingsTab), createElement(SettingsLocation)),
    ),
  );
}

describe('LW-QA-013 — LegiWatch Settings (read/write over real per-user storage)', () => {
  it('opens real watchlist setup with the current client scope', async () => {
    renderSettings('/legiwatch?tab=settings&client=client-A');
    fireEvent.click(await screen.findByRole('button', { name: 'Open watchlist / monitoring setup' }));
    // The destination must be the canonical targeting subview, not this same page.
    expect(screen.getByTestId('settings-location')).toHaveTextContent('/legiwatch?tab=settings&sub=watchlist&client=client-A');
  });

  it('renders the display preferences from the stored prefs doc', async () => {
    renderSettings();
    await screen.findByLabelText('LegiWatch settings');
    const tz = await screen.findByLabelText('Preferred timezone');
    expect(tz).toBeTruthy();
    // Stored Pacific + list view render as the selected segments.
    expect(tz.textContent).toContain('Pacific');
    const view = screen.getByLabelText('Default hearings view');
    expect(view.textContent).toContain('List');
  });

  it('writes through PATCH /api/me with the merged prefs doc', async () => {
    renderSettings();
    await screen.findByLabelText('LegiWatch settings');
    const view = screen.getByLabelText('Default hearings view');
    // Click the Calendar segment (currently stored = list).
    fireEvent.click(within(view).getByText('Calendar'));
    await waitFor(() => expect(apiPatch).toHaveBeenCalled());
    const call = apiPatch.mock.calls[0];
    const body = (call?.[1] ?? {}) as { legiwatchPrefs: Record<string, unknown> };
    expect(body.legiwatchPrefs.defaultView).toBe('calendar');
    // Unrelated stored keys survive the merge (round-trip).
    expect(body.legiwatchPrefs.timezone).toBe('America/Los_Angeles');
    await waitFor(() => expect(screen.getByText('SAVED')).toBeTruthy());
  });

  /**
   * LW-QA-022. The tab reads ['lw-vnext','settings-me'] but the save used to
   * invalidate only ['me'], so the write landed in the database while the
   * controlled segmented control snapped back to the old value — and every
   * subsequent change was rebuilt from that same stale snapshot, reverting the
   * one before it (PATCH /api/me is a whole-document replace).
   */
  it('the chosen timezone STAYS selected after the save (not just PATCHed)', async () => {
    renderSettings();
    await screen.findByLabelText('LegiWatch settings');
    const tz = screen.getByLabelText('Preferred timezone');
    expect(within(tz).getByText('Pacific').getAttribute('aria-selected')).toBe('true');

    fireEvent.click(within(tz).getByText('Eastern'));

    await waitFor(() =>
      expect(within(tz).getByText('Eastern').getAttribute('aria-selected')).toBe('true'),
    );
    expect(within(tz).getByText('Pacific').getAttribute('aria-selected')).toBe('false');
  });

  it('rapid successive changes do not overwrite one another with a stale document', async () => {
    renderSettings();
    await screen.findByLabelText('LegiWatch settings');

    fireEvent.click(within(screen.getByLabelText('Preferred timezone')).getByText('Eastern'));
    fireEvent.click(within(screen.getByLabelText('Default hearings view')).getByText('Calendar'));
    fireEvent.click(within(screen.getByLabelText('Default chamber filter')).getByText('Senate'));

    await waitFor(() => expect(apiPatch).toHaveBeenCalledTimes(3));

    // All three survive on the server — the later writes carried the earlier
    // ones forward instead of resending the pre-save snapshot.
    expect(ME.user.legiwatchPrefs).toMatchObject({
      timezone: 'America/New_York',
      defaultView: 'calendar',
      defaultChamber: 'Senate',
    });
  });

  it('all three preferences survive a hard refresh (remount against the stored row)', async () => {
    renderSettings();
    await screen.findByLabelText('LegiWatch settings');
    fireEvent.click(within(screen.getByLabelText('Preferred timezone')).getByText('Eastern'));
    fireEvent.click(within(screen.getByLabelText('Default hearings view')).getByText('Calendar'));
    fireEvent.click(within(screen.getByLabelText('Default chamber filter')).getByText('Senate'));
    await waitFor(() => expect(apiPatch).toHaveBeenCalledTimes(3));

    cleanup();
    renderSettings();
    await screen.findByLabelText('LegiWatch settings');

    const tz = screen.getByLabelText('Preferred timezone');
    const view = screen.getByLabelText('Default hearings view');
    const chamber = screen.getByLabelText('Default chamber filter');
    await waitFor(() =>
      expect(within(tz).getByText('Eastern').getAttribute('aria-selected')).toBe('true'),
    );
    expect(within(view).getByText('Calendar').getAttribute('aria-selected')).toBe('true');
    expect(within(chamber).getByText('Senate').getAttribute('aria-selected')).toBe('true');
  });

  it('unsupported preferences render "Not available yet" and are never fake-enabled', async () => {
    renderSettings();
    await screen.findByLabelText('LegiWatch settings');
    const notifications = screen.getByLabelText('Notifications');
    expect(notifications.textContent).toMatch(/Not available yet/);
    // No interactive control pretends to toggle them.
    expect(within(notifications).queryAllByRole('checkbox').length).toBe(0);
  });


  it('the official-timezone caveat is stated (preference never edits canonical truth)', async () => {
    renderSettings();
    await screen.findByLabelText('LegiWatch settings');
    expect(screen.getByText(/OFFICIAL time and zone/i)).toBeTruthy();
  });

  it('the Saved Views feature is gone from settings (W2-2 removed)', async () => {
    renderSettings();
    await screen.findByLabelText('LegiWatch settings');
    expect(screen.queryByLabelText('Saved views')).toBeNull();
    expect(screen.queryByRole('button', { name: /Manage saved views/i })).toBeNull();
  });

});

import { within } from '@testing-library/react';

describe('LW-QA-013 NEGATIVE contract — no rollout/operations controls (§13)', () => {
  const source = `
    placeholder`;

  it('the settings tab source contains NO operational control labels', async () => {
    renderSettings();
    await screen.findByLabelText('LegiWatch settings');
    const body = document.body.textContent ?? '';
    for (const forbidden of [
      'CANARY',
      'CUTOVER',
      'kill switch',
      'capture_all_public_events',
      'production_default',
      'Phase 9',
      'consecutive_passes',
      'SHADOW',
    ]) {
      expect(body, `forbidden operations label: ${forbidden}`).not.toContain(forbidden);
    }
    void source;
  });
});
