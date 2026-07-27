import { act, fireEvent, render, screen } from '@testing-library/react';
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
  updatedByName: 'Neo Martinez',
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

  /**
   * P2-08 (Gate D g-3): this control WAS a cycling pill — one click advanced
   * low→med→high→low. It is an explicit menu now, so the test selects a value
   * rather than clicking N times. The save path it guards is unchanged.
   */
  test('selecting High fires a save carrying priority=high', () => {
    const onSaveWatchlist = vi.fn();
    renderPanel(onSaveWatchlist);

    const select = screen.getAllByLabelText('Priority')[0]! as HTMLSelectElement;
    expect(select.value).toBe('med');

    act(() => {
      fireEvent.change(select, { target: { value: 'high' } });
    });
    act(() => void vi.advanceTimersByTime(700));

    expect(onSaveWatchlist).toHaveBeenCalledTimes(1);
    const sent = onSaveWatchlist.mock.calls[0]![0] as WatchlistPayload;
    expect(sent.tags.find((t) => t.tag === 'defense authorization')?.priority).toBe('high');
    expect(sent.version).toBe(3);
  });

  test('the control reflects the new priority in the DOM immediately', () => {
    renderPanel(() => {});
    const select = screen.getAllByLabelText('Priority')[0]! as HTMLSelectElement;
    act(() => {
      fireEvent.change(select, { target: { value: 'high' } });
    });
    expect((screen.getAllByLabelText('Priority')[0]! as HTMLSelectElement).value).toBe('high');
  });

  /** g-8 case 4 — THE P2-08 lock: clicking must no longer change the value. */
  test('CLICKING the control does not change the value (no cycling)', () => {
    const onSaveWatchlist = vi.fn();
    renderPanel(onSaveWatchlist);

    const select = screen.getAllByLabelText('Priority')[0]! as HTMLSelectElement;
    act(() => select.click());
    act(() => void vi.advanceTimersByTime(700));

    expect(select.value).toBe('med');
    expect(onSaveWatchlist).not.toHaveBeenCalled();
  });

  test('priority and position are listboxes with three DEFINED options each', () => {
    renderPanel(() => {});
    const priority = screen.getAllByLabelText('Priority')[0]! as HTMLSelectElement;
    const position = screen.getAllByLabelText('Position')[0]! as HTMLSelectElement;

    expect(priority.tagName).toBe('SELECT');
    expect(position.tagName).toBe('SELECT');
    expect([...priority.options].map((o) => o.textContent)).toEqual([
      'Low — monitor only',
      'Med — worth a look',
      'High — drives alert ranking',
    ]);
    expect([...position.options].map((o) => o.textContent)).toEqual([
      'Support — we want this to advance',
      'Monitor — no stated stance',
      'Oppose — we want this stopped',
    ]);
  });

  test('selecting a position fires one save with that exact value', () => {
    const onSaveWatchlist = vi.fn();
    renderPanel(onSaveWatchlist);
    const position = screen.getAllByLabelText('Position')[0]!;
    act(() => {
      fireEvent.change(position, { target: { value: 'oppose' } });
    });
    act(() => void vi.advanceTimersByTime(700));
    expect(onSaveWatchlist).toHaveBeenCalledTimes(1);
    const sent = onSaveWatchlist.mock.calls[0]![0] as WatchlistPayload;
    expect(sent.tags.find((t) => t.tag === 'defense authorization')?.position).toBe('oppose');
  });

  test('an UNNAMED sibling tag blocks the priority save (phase c, by design)', () => {
    const onSaveWatchlist = vi.fn();
    renderPanel(onSaveWatchlist, {
      tags: [tag({ tag: 'defense authorization' }), tag({ tag: '' })],
    });

    const select = screen.getAllByLabelText('Priority')[0]!;
    act(() => {
      fireEvent.change(select, { target: { value: 'high' } });
    });
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

  test('P1-02: a non-admin gets a read-only card and fires no save', () => {
    const onSaveWatchlist = vi.fn();
    render(
      <TrackerConfigPanel
        allIssueAreas={['Defense']}
        watchlist={watchlist()}
        prefs={prefs()}
        onSaveWatchlist={onSaveWatchlist}
        onSavePrefs={() => {}}
        onRequestVerify={() => {}}
        onTestAlert={() => {}}
        typedTermsEnabled
        canEditTargeting={false}
      />,
    );

    // A native <fieldset disabled> makes every descendant inert AND announces it.
    // NB: `button.disabled` reflects only the element's OWN attribute — inherited
    // disabling is observable via the enclosing fieldset (and `:disabled` in a real
    // browser), which is what actually stops the click there.
    const select = screen.getAllByLabelText('Priority')[0]!;
    expect(select.closest('fieldset')?.disabled).toBe(true);
    act(() => {
      fireEvent.change(select, { target: { value: 'high' } });
    });
    act(() => void vi.advanceTimersByTime(700));
    expect(onSaveWatchlist).not.toHaveBeenCalled();
    expect(screen.getByText(/view only/i)).toBeInTheDocument();
  });

  test('§4.3: TYPING the reserved tag name is refused and blocks the save', () => {
    const onSaveWatchlist = vi.fn();
    renderPanel(onSaveWatchlist, { tags: [tag({ tag: 'grid' })] });

    // Expand the row to reach the name input, then rename it to the reserved label.
    act(() => screen.getByText('grid').click());
    const input = screen.getByLabelText('Tag name');
    act(() => void fireEvent.change(input, { target: { value: 'Hearing terms' } }));

    expect(screen.getByText(/reserved/i)).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(700));
    expect(onSaveWatchlist).not.toHaveBeenCalled();
  });

  test('§4.3: a reserved label the SERVER sent stays editable (the fold-back must round-trip)', () => {
    // getWatchlist folds legacy flat hearing terms under this exact label. If the
    // editor flagged it, saving would be blocked and those terms would be stranded.
    renderPanel(() => {}, { tags: [tag({ tag: 'Hearing terms' })] });
    expect(screen.queryByText(/reserved/i)).toBeNull();
    expect(screen.queryByText(/not being saved/i)).toBeNull();
  });

  test('the position control persists too (same code path)', () => {
    const onSaveWatchlist = vi.fn();
    renderPanel(onSaveWatchlist);

    // P2-08: was a cycling pill; now an explicit menu. Same save path.
    const pos = screen.getAllByLabelText('Position')[0]!;
    act(() => {
      fireEvent.change(pos, { target: { value: 'oppose' } });
    });
    act(() => void vi.advanceTimersByTime(700));

    expect(onSaveWatchlist).toHaveBeenCalledTimes(1);
    const sent = onSaveWatchlist.mock.calls[0]![0] as WatchlistPayload;
    expect(sent.tags.find((t) => t.tag === 'defense authorization')?.position).not.toBe('monitor');
  });
});
