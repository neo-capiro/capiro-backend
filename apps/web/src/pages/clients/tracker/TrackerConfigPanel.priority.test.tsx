import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TrackerConfigPanel } from './TrackerConfigPanel.js';
import type { AlertPrefsPayload, WatchlistPayload, WatchlistTag } from './tracker-api.js';

/**
 * Live-smoke follow-up (2026-07-26): after Gate B shipped, clicking a tag's
 * priority pill in production produced NO PUT — three saves landed for tag names
 * and terms, but `intel_watchlist_topic.priority` stayed 'med' and the watchlist
 * version never bumped past 3. These tests isolate the pill's save path from the
 * rest of the editor.
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

const prefs = (): AlertPrefsPayload => ({
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
});

const tag = (over: Partial<WatchlistTag> = {}): WatchlistTag => ({
  tag: 'defense authorization',
  priority: 'med',
  position: 'monitor',
  synonyms: [],
  relatedEntities: [],
  riskTerms: [],
  typedTerms: [],
  ...over,
});

/** Mirrors L3 Harris in prod: three named tags, one carrying a synonym. */
const watchlist = (over: Partial<WatchlistPayload> = {}): WatchlistPayload => ({
  issueAreas: ['Defense'],
  jurisdictions: [],
  version: 3,
  updatedBy: 'user_x',
  updatedAt: '2026-07-26T16:21:51.240Z',
  tags: [
    tag({ tag: 'defense authorization', synonyms: ['defense authorization'] }),
    tag({ tag: 'manufacturing' }),
    tag({ tag: 'space' }),
  ],
  ...over,
});

function renderPanel(onSaveWatchlist: () => void, over: Partial<WatchlistPayload> = {}) {
  return render(
    <TrackerConfigPanel
      allIssueAreas={['Defense', 'Energy']}
      watchlist={watchlist(over)}
      prefs={prefs()}
      onSaveWatchlist={onSaveWatchlist}
      onSavePrefs={() => {}}
      onRequestVerify={() => {}}
      onTestAlert={() => {}}
      typedTermsEnabled
    />,
  );
}

describe('TrackerConfigPanel — priority pill must persist (live-smoke regression)', () => {
  beforeEach(() => {
    setupBrowserMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('clicking the priority pill once fires a save carrying priority=high', () => {
    const onSaveWatchlist = vi.fn();
    renderPanel(onSaveWatchlist);

    const pill = screen.getAllByTitle('Priority — click to change')[0]!;
    expect(pill.textContent).toBe('Med priority');

    act(() => pill.click());
    act(() => void vi.advanceTimersByTime(700));

    expect(onSaveWatchlist).toHaveBeenCalledTimes(1);
    const sent = onSaveWatchlist.mock.calls[0]![0] as WatchlistPayload;
    expect(sent.tags.find((t) => t.tag === 'defense authorization')?.priority).toBe('high');
    expect(sent.version).toBe(3);
  });

  test('the pill reflects the new priority in the DOM immediately', () => {
    renderPanel(() => {});
    const pill = screen.getAllByTitle('Priority — click to change')[0]!;
    act(() => pill.click());
    expect(screen.getAllByTitle('Priority — click to change')[0]!.textContent).toBe('High priority');
  });

  test('an UNNAMED sibling tag blocks the priority save (phase c, by design)', () => {
    const onSaveWatchlist = vi.fn();
    renderPanel(onSaveWatchlist, {
      tags: [tag({ tag: 'defense authorization' }), tag({ tag: '' })],
    });

    const pill = screen.getAllByTitle('Priority — click to change')[0]!;
    act(() => pill.click());
    act(() => void vi.advanceTimersByTime(700));

    // This is the production-plausible trap: the change is visible but unsaved.
    expect(onSaveWatchlist).not.toHaveBeenCalled();
    expect(screen.getByText(/Targeting is not being saved/i)).toBeInTheDocument();
  });

  test('a blocked save OUTRANKS a stale "Saved at" in the status strip', () => {
    // The trap this closes: the strip kept reporting the LAST successful save
    // while hasTagNameError silently swallowed every edit after it, so the card
    // said saved and not-saved at once. That is why a live priority change looked
    // applied and never persisted.
    render(
      <TrackerConfigPanel
        allIssueAreas={['Defense']}
        watchlist={watchlist({ tags: [tag({ tag: 'defense authorization' }), tag({ tag: '' })] })}
        prefs={prefs()}
        onSaveWatchlist={() => {}}
        onSavePrefs={() => {}}
        onRequestVerify={() => {}}
        onTestAlert={() => {}}
        typedTermsEnabled
        saveState={{ kind: 'saved', at: '16:21' }}
      />,
    );

    const strip = document.querySelector('.wl-savestate')!;
    expect(strip.textContent).toContain('Not saved');
    expect(strip.textContent).not.toContain('Saved at 16:21');
  });

  test('a clean editor still shows the successful save state', () => {
    render(
      <TrackerConfigPanel
        allIssueAreas={['Defense']}
        watchlist={watchlist()}
        prefs={prefs()}
        onSaveWatchlist={() => {}}
        onSavePrefs={() => {}}
        onRequestVerify={() => {}}
        onTestAlert={() => {}}
        typedTermsEnabled
        saveState={{ kind: 'saved', at: '16:21' }}
      />,
    );

    const strip = document.querySelector('.wl-savestate')!;
    expect(strip.textContent).toContain('Saved at 16:21');
    expect(strip.textContent).not.toContain('Not saved');
  });

  test('the position pill persists too (same code path)', () => {
    const onSaveWatchlist = vi.fn();
    renderPanel(onSaveWatchlist);

    const pos = screen.getAllByTitle('Position — click to change')[0]!;
    act(() => pos.click());
    act(() => void vi.advanceTimersByTime(700));

    expect(onSaveWatchlist).toHaveBeenCalledTimes(1);
    const sent = onSaveWatchlist.mock.calls[0]![0] as WatchlistPayload;
    expect(sent.tags.find((t) => t.tag === 'defense authorization')?.position).not.toBe('monitor');
  });
});
