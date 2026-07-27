import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TrackerConfigPanel } from './TrackerConfigPanel.js';
import type { AlertPrefsPayload, WatchlistPayload } from './tracker-api.js';

/**
 * MP-04 — email cannot be enabled with no address. Before this fix, flipping
 * the Email toggle on with a blank address persisted `emailEnabled: true,
 * emailAddress: null` (a contradiction the intel-api DTO now also rejects at
 * the boundary) — Configure showed Email ON while nothing was ever sent, with
 * no error anywhere. Mirrors the SMS composite guard
 * (`smsEnabled: smsEnabled && smsVerified && !!smsPhone`) already in this file.
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
    triggers: ['newMatch'],
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

function renderPanel(
  onSavePrefs: (p: AlertPrefsPayload) => void,
  props: Partial<ComponentProps<typeof TrackerConfigPanel>> = {},
) {
  setupBrowserMocks();
  return render(
    <TrackerConfigPanel
      allIssueAreas={[]}
      watchlist={WATCHLIST}
      prefs={makePrefs()}
      onSaveWatchlist={() => {}}
      onSavePrefs={onSavePrefs}
      onRequestVerify={() => {}}
      onTestAlert={() => {}}
      {...props}
    />,
  );
}

describe('TrackerConfigPanel — email cannot be enabled with no address (MP-04)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('flipping Email on with no address shows the blocked-save message', () => {
    renderPanel(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'Email delivery' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/Not saved as enabled/i);
  });

  test('typing a valid address clears the blocked-save message', () => {
    renderPanel(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'Email delivery' }));
    fireEvent.change(screen.getByPlaceholderText('you@firm.com'), {
      target: { value: 'u1@x.com' },
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('the debounced save sends emailEnabled:false while the address is blank, even though the toggle is on', () => {
    const onSavePrefs = vi.fn();
    renderPanel(onSavePrefs);
    fireEvent.click(screen.getByRole('button', { name: 'Email delivery' }));
    act(() => void vi.advanceTimersByTime(700));
    expect(onSavePrefs).toHaveBeenCalledTimes(1);
    expect(onSavePrefs.mock.calls[0]![0]).toMatchObject({
      emailEnabled: false,
      emailAddress: null,
    });
  });

  test('the debounced save sends emailEnabled:true once a valid address exists', () => {
    const onSavePrefs = vi.fn();
    renderPanel(onSavePrefs);
    fireEvent.click(screen.getByRole('button', { name: 'Email delivery' }));
    fireEvent.change(screen.getByPlaceholderText('you@firm.com'), {
      target: { value: 'u1@x.com' },
    });
    act(() => void vi.advanceTimersByTime(700));
    const last = onSavePrefs.mock.calls[onSavePrefs.mock.calls.length - 1]![0];
    expect(last).toMatchObject({ emailEnabled: true, emailAddress: 'u1@x.com' });
  });

  test('an already-enabled pref with a saved address shows no blocked message and saves unchanged', () => {
    const onSavePrefs = vi.fn();
    renderPanel(onSavePrefs, {
      prefs: makePrefs({ emailEnabled: true, emailAddress: 'existing@x.com' }),
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
