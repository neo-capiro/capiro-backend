import { act, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TrackerConfigPanel } from './TrackerConfigPanel.js';
import type { AlertPrefsPayload, WatchlistPayload, WatchlistTag } from './tracker-api.js';

/**
 * Gate B phase e (P1-02) — the shared-targeting save is legible: Saving… /
 * Saved at HH:MM (+ Undo) / Save failed + Retry / the conflict message, plus the
 * "Shared with your team" framing. Also covers the two autosave guards that make
 * versioning workable: never a second PUT while one is in flight, and never a
 * no-op PUT (which would bump the SHARED version for an edit that changed nothing).
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

function makePrefs(): AlertPrefsPayload {
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
  };
}

function makeTag(overrides: Partial<WatchlistTag> = {}): WatchlistTag {
  return {
    tag: 'grid load',
    priority: 'med',
    position: 'monitor',
    synonyms: [],
    relatedEntities: [],
    riskTerms: [],
    typedTerms: [],
    ...overrides,
  };
}

function makeWatchlist(overrides: Partial<WatchlistPayload> = {}): WatchlistPayload {
  return { issueAreas: [], tags: [], version: 3, updatedBy: null, updatedAt: null, ...overrides };
}

function renderPanel(props: Partial<ComponentProps<typeof TrackerConfigPanel>> = {}) {
  return render(
    <TrackerConfigPanel
      allIssueAreas={['Energy']}
      watchlist={makeWatchlist()}
      prefs={makePrefs()}
      onSaveWatchlist={() => {}}
      onSavePrefs={() => {}}
      onRequestVerify={() => {}}
      onTestAlert={() => {}}
      typedTermsEnabled
      {...props}
    />,
  );
}

describe('TrackerConfigPanel — save state + shared-targeting framing (P1-02)', () => {
  beforeEach(() => {
    setupBrowserMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('e-10.10 renders each of the five save states', () => {
    const { rerender } = renderPanel({ saveState: { kind: 'idle' } });
    const strip = () => document.querySelector('.wl-savestate')!;
    expect(strip().textContent).toBe('');
    // aria-live so the state is announced without stealing focus from the input.
    expect(strip()).toHaveAttribute('aria-live', 'polite');

    const props = {
      allIssueAreas: ['Energy'],
      watchlist: makeWatchlist(),
      prefs: makePrefs(),
      onSaveWatchlist: () => {},
      onSavePrefs: () => {},
      onRequestVerify: () => {},
      onTestAlert: () => {},
      typedTermsEnabled: true,
    } as ComponentProps<typeof TrackerConfigPanel>;

    rerender(<TrackerConfigPanel {...props} saveState={{ kind: 'saving' }} />);
    expect(strip().textContent).toContain('Saving');

    rerender(<TrackerConfigPanel {...props} saveState={{ kind: 'saved', at: '09:41' }} />);
    expect(strip().textContent).toContain('Saved at 09:41');

    rerender(
      <TrackerConfigPanel {...props} saveState={{ kind: 'error', message: 'Could not save targeting.' }} />,
    );
    expect(strip().textContent).toContain('Save failed');

    rerender(
      <TrackerConfigPanel
        {...props}
        saveState={{ kind: 'conflict', message: 'Someone else changed this client’s targeting.' }}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('Someone else changed');
  });

  test('e-10.10 the error state exposes a working Retry', () => {
    const onRetrySave = vi.fn();
    renderPanel({ saveState: { kind: 'error', message: 'Could not save targeting.' }, onRetrySave });

    screen.getByRole('button', { name: /Retry/i }).click();

    expect(onRetrySave).toHaveBeenCalledTimes(1);
  });

  test('e-9 Undo appears only on a saved state WITH an undoable payload, and calls back', () => {
    const onUndoSave = vi.fn();
    const { rerender } = renderPanel({ saveState: { kind: 'saved', at: '09:41' }, canUndo: false, onUndoSave });
    expect(screen.queryByRole('button', { name: /Undo last change/i })).toBeNull();

    rerender(
      <TrackerConfigPanel
        allIssueAreas={['Energy']}
        watchlist={makeWatchlist()}
        prefs={makePrefs()}
        onSaveWatchlist={() => {}}
        onSavePrefs={() => {}}
        onRequestVerify={() => {}}
        onTestAlert={() => {}}
        typedTermsEnabled
        saveState={{ kind: 'saved', at: '09:41' }}
        canUndo
        onUndoSave={onUndoSave}
      />,
    );
    screen.getByRole('button', { name: /Undo last change/i }).click();
    expect(onUndoSave).toHaveBeenCalledTimes(1);
  });

  test('e-10.11 says targeting is shared, shows the last-changed time, and never renders a raw user id', () => {
    renderPanel({
      watchlist: makeWatchlist({
        updatedBy: 'user_2abcDEFghiJKLmnoPQRstu',
        updatedAt: '2026-07-26T13:41:00.000Z',
      }),
    });

    expect(screen.getByText(/Shared with your team/i)).toBeInTheDocument();
    expect(screen.getByText(/last changed/i)).toBeInTheDocument();
    // A Clerk user id must never reach the DOM (e-8) — intel-api has no user
    // lookup on this route, and a raw id is worse than a timestamp.
    expect(document.body.textContent).not.toContain('user_2abcDEFghiJKLmnoPQRstu');
  });

  test('the per-user alerts card still contrasts with the shared targeting card', () => {
    renderPanel({ clientName: 'Acme Corp' });
    expect(screen.getByText(/per-user/i)).toBeInTheDocument();
    expect(screen.getByText(/Shared with your team/i)).toBeInTheDocument();
  });
});

describe('TrackerConfigPanel — autosave guards that make versioning workable (P1-02, §4.8)', () => {
  beforeEach(() => {
    setupBrowserMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('an edit sends the version it read, so the server can detect a stale write', () => {
    const onSaveWatchlist = vi.fn();
    renderPanel({
      watchlist: makeWatchlist({ version: 7, tags: [makeTag()] }),
      onSaveWatchlist,
    });

    act(() => screen.getByRole('button', { name: 'Energy' }).click());
    act(() => void vi.advanceTimersByTime(700));

    expect(onSaveWatchlist).toHaveBeenCalledTimes(1);
    expect(onSaveWatchlist.mock.calls[0]![0]).toMatchObject({ version: 7, issueAreas: ['Energy'] });
  });

  test('§4.8 no second PUT is scheduled while one is in flight; it lands once the save settles', () => {
    const onSaveWatchlist = vi.fn();
    const props = {
      allIssueAreas: ['Energy'],
      watchlist: makeWatchlist({ tags: [makeTag()] }),
      prefs: makePrefs(),
      onSaveWatchlist,
      onSavePrefs: () => {},
      onRequestVerify: () => {},
      onTestAlert: () => {},
      typedTermsEnabled: true,
    } as ComponentProps<typeof TrackerConfigPanel>;
    const { rerender } = render(<TrackerConfigPanel {...props} saving />);

    act(() => screen.getByRole('button', { name: 'Energy' }).click());
    act(() => void vi.advanceTimersByTime(2000));
    // Would have carried the SAME expectedVersion as the in-flight save and 409ed.
    expect(onSaveWatchlist).not.toHaveBeenCalled();

    act(() => rerender(<TrackerConfigPanel {...props} saving={false} />));
    act(() => void vi.advanceTimersByTime(700));
    expect(onSaveWatchlist).toHaveBeenCalledTimes(1);
  });

  test('a no-op change does not fire a PUT (it would bump the SHARED version for nothing)', () => {
    const onSaveWatchlist = vi.fn();
    renderPanel({
      watchlist: makeWatchlist({ issueAreas: ['Energy'], tags: [makeTag()] }),
      onSaveWatchlist,
    });

    // Toggle Energy off then on again — net zero against persisted truth.
    act(() => screen.getByRole('button', { name: 'Energy' }).click());
    act(() => screen.getByRole('button', { name: 'Energy' }).click());
    act(() => void vi.advanceTimersByTime(700));

    expect(onSaveWatchlist).not.toHaveBeenCalled();
  });
});
