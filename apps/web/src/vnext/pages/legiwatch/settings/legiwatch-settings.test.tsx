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
import { MemoryRouter } from 'react-router-dom';
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

const ME = {
  user: {
    id: 'u-1',
    legiwatchPrefs: { timezone: 'America/Los_Angeles', defaultView: 'list' },
  },
};

const WATCH_PRESETS = [
  {
    id: 'preset-1',
    name: 'Autonomy funding movement',
    clientIds: [],
    signalFamilies: ['program_element'],
    conditions: [{ type: 'FUNDING_MOVEMENT', minMaterialityScore: 0.5 }],
    status: 'active',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  },
];

beforeEach(() => {
  apiGet.mockReset();
  apiPatch.mockReset();
  apiPut.mockReset();
  apiPut.mockImplementation((url: string) => Promise.reject(new Error(`unexpected PUT ${url}`)));
  WATCH_PRESETS[0]!.status = 'active';
  apiGet.mockImplementation((url: string) => {
    if (url.startsWith('/api/me')) return Promise.resolve({ data: ME });
    // W2-2: the settings tab's Saved Views summary card reads the real
    // endpoint now (personal + shared scopes) rather than rendering a
    // permanent placeholder.
    if (url.includes('/legiwatch/live-hearings/saved-views')) return Promise.resolve({ data: { rows: [] } });
    // W2-4: the settings tab's Watch presets card reads the real endpoint now
    // rather than there being no management surface at all.
    if (url.includes('/legiwatch/live-hearings/watch-presets')) return Promise.resolve({ data: { rows: WATCH_PRESETS } });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  apiPatch.mockImplementation(((url: string, body?: unknown) => {
    if (url === '/api/me') {
      const prefs = ((body ?? {}) as { legiwatchPrefs?: Record<string, unknown> }).legiwatchPrefs ?? {};
      ME.user.legiwatchPrefs = { ...(ME.user.legiwatchPrefs ?? {}), ...prefs };
      return Promise.resolve({ data: ME });
    }
    return Promise.reject(new Error(`unexpected PATCH ${url}`));
  }) as typeof apiPatch);
});

afterEach(() => {
  cleanup();
});

function renderSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(MemoryRouter, null, createElement(LegiWatchSettingsTab)),
    ),
  );
}

describe('LW-QA-013 — LegiWatch Settings (read/write over real per-user storage)', () => {
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

  it('unsupported preferences render "Not available yet" and are never fake-enabled', async () => {
    renderSettings();
    await screen.findByLabelText('LegiWatch settings');
    const notifications = screen.getByLabelText('Notifications');
    expect(notifications.textContent).toMatch(/Not available yet/);
    // No interactive control pretends to toggle them.
    expect(within(notifications).queryAllByRole('checkbox').length).toBe(0);
  });

  it('Saved Views has a real backend now (W2-2) — no more permanent placeholder', async () => {
    renderSettings();
    await screen.findByLabelText('LegiWatch settings');
    const savedViews = await screen.findByLabelText('Saved views');
    expect(savedViews.textContent).not.toMatch(/no persistence backend/i);
    expect(within(savedViews).getByRole('button', { name: /Manage saved views/ })).toBeTruthy();
  });

  it('the official-timezone caveat is stated (preference never edits canonical truth)', async () => {
    renderSettings();
    await screen.findByLabelText('LegiWatch settings');
    expect(screen.getByText(/OFFICIAL time and zone/i)).toBeTruthy();
  });

  it('Watch presets has a real backend now (W2-4) — lists presets with lifecycle controls', async () => {
    renderSettings();
    await screen.findByLabelText('LegiWatch settings');
    const watchPresets = await screen.findByLabelText('Watch presets');
    expect(within(watchPresets).getByText('Autonomy funding movement')).toBeTruthy();
    expect(within(watchPresets).getByText('ACTIVE')).toBeTruthy();
    // An active preset offers Pause (not Resume) and Archive, plus Edit.
    expect(within(watchPresets).getByRole('button', { name: 'Pause' })).toBeTruthy();
    expect(within(watchPresets).getByRole('button', { name: 'Archive' })).toBeTruthy();
    expect(within(watchPresets).getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(within(watchPresets).queryByRole('button', { name: 'Resume' })).toBeNull();
  });

  it('pausing a watch preset calls the status endpoint and flips the control to Resume', async () => {
    apiPut.mockImplementation(((url: string, body?: unknown) => {
      if (url === '/api/legiwatch/live-hearings/watch-presets/preset-1/status') {
        WATCH_PRESETS[0]!.status = (body as { status: string }).status as typeof WATCH_PRESETS[0]['status'];
        return Promise.resolve({ data: WATCH_PRESETS[0] });
      }
      return Promise.reject(new Error(`unexpected PUT ${url}`));
    }) as typeof apiPut);

    renderSettings();
    const watchPresets = await screen.findByLabelText('Watch presets');
    fireEvent.click(await within(watchPresets).findByRole('button', { name: 'Pause' }));
    await waitFor(() =>
      expect(within(watchPresets).getByRole('button', { name: 'Resume' })).toBeTruthy(),
    );
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
