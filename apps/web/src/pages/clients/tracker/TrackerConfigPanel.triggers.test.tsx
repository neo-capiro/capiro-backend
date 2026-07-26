import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { TrackerConfigPanel } from './TrackerConfigPanel.js';
import type { AlertPrefsPayload, WatchlistPayload } from './tracker-api.js';

/**
 * P1-01 (Gate A phase e) — the blocking "No alert events selected" warning.
 */

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

const WATCHLIST: WatchlistPayload = { issueAreas: [], tags: [] };

function makePrefs(overrides: Partial<AlertPrefsPayload> = {}): AlertPrefsPayload {
  return {
    triggers: [],
    materiality: 'medium',
    emailEnabled: false,
    emailAddress: null,
    emailCadence: 'realtime',
    smsEnabled: false,
    smsPhone: null,
    smsPhoneVerified: false,
    smsCadence: 'realtime',
    quietHoursStart: null,
    quietHoursEnd: null,
    jurisdictions: [],
    ...overrides,
  };
}

function renderPanel(prefs: AlertPrefsPayload) {
  setupBrowserMocks();
  return render(
    <TrackerConfigPanel
      allIssueAreas={[]}
      watchlist={WATCHLIST}
      prefs={prefs}
      onSaveWatchlist={() => {}}
      onSavePrefs={() => {}}
      onRequestVerify={() => {}}
      onTestAlert={() => {}}
    />,
  );
}

describe('TrackerConfigPanel — P1-01 zero-triggers warning', () => {
  test('prefs.triggers = [] renders the "No alert events selected" warning', () => {
    renderPanel(makePrefs({ triggers: [] }));
    expect(screen.getByRole('alert')).toHaveTextContent(/No alert events selected/i);
  });

  test('one trigger selected does not render the warning', () => {
    renderPanel(makePrefs({ triggers: ['newMatch'] }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
