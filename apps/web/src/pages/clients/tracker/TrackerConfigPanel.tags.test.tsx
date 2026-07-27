import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TrackerConfigPanel } from './TrackerConfigPanel.js';
import type { AlertPrefsPayload, WatchlistPayload, WatchlistTag } from './tracker-api.js';

/**
 * Gate B phase c (P0-03 items 1-4, P0-05 UI) — nameable/renameable tags with
 * inline validation and the editor's resync-from-server behavior.
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

function makeWatchlist(overrides: Partial<WatchlistPayload> = {}): WatchlistPayload {
  return { issueAreas: [], tags: [], ...overrides };
}

function makeTag(overrides: Partial<WatchlistTag> = {}): WatchlistTag {
  return {
    tag: '',
    priority: 'med',
    position: 'monitor',
    synonyms: [],
    relatedEntities: [],
    riskTerms: [],
    typedTerms: [],
    ...overrides,
  };
}

function renderPanel(props: Partial<ComponentProps<typeof TrackerConfigPanel>> = {}) {
  return render(
    <TrackerConfigPanel
      allIssueAreas={[]}
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

describe('TrackerConfigPanel — tag naming + inline validation + resync (P0-03, P0-05)', () => {
  beforeEach(() => {
    setupBrowserMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('1. Add tag opens a focused, unnamed row', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /Add tag/i }));
    expect(screen.getByText(/Unnamed — add a name/i)).toBeInTheDocument();
    const input = screen.getByLabelText('Tag name') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
  });

  test('2. a blank tag blocks autosave and shows the banner', () => {
    const onSave = vi.fn();
    renderPanel({ onSaveWatchlist: onSave });
    fireEvent.click(screen.getByRole('button', { name: /Add tag/i }));
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(/Targeting is not being saved/i)).toBeInTheDocument();
  });

  test('3. typing a name saves once with the typed name', () => {
    const onSave = vi.fn();
    renderPanel({ onSaveWatchlist: onSave });
    fireEvent.click(screen.getByRole('button', { name: /Add tag/i }));
    fireEvent.change(screen.getByLabelText('Tag name'), {
      target: { value: 'Data Center Load' },
    });
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    const payload = onSave.mock.calls[0]![0] as WatchlistPayload;
    expect(payload.tags.map((t) => t.tag)).toEqual(['Data Center Load']);
  });

  test('4. renaming an existing tag sends the new name', () => {
    const onSave = vi.fn();
    renderPanel({
      watchlist: makeWatchlist({ tags: [makeTag({ tag: 'Old Name' })] }),
      onSaveWatchlist: onSave,
    });
    fireEvent.click(screen.getByText('Old Name'));
    fireEvent.change(screen.getByLabelText('Tag name'), { target: { value: 'New Name' } });
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    const payload = onSave.mock.calls[0]![0] as WatchlistPayload;
    expect(payload.tags[0]!.tag).toBe('New Name');
  });

  test('5. a case-insensitive duplicate name blocks the save', () => {
    const onSave = vi.fn();
    renderPanel({ onSaveWatchlist: onSave });
    fireEvent.click(screen.getByRole('button', { name: /Add tag/i }));
    fireEvent.change(screen.getAllByLabelText('Tag name')[0]!, {
      target: { value: 'Data Center' },
    });
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    onSave.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /Add tag/i }));
    const inputs = screen.getAllByLabelText('Tag name');
    fireEvent.change(inputs[1]!, { target: { value: 'data center' } });
    act(() => {
      vi.advanceTimersByTime(700);
    });
    // Both rows share the normalized name, so both show the duplicate reason.
    expect(screen.getAllByText(/is already a tag for this client/i).length).toBe(2);
    expect(onSave).not.toHaveBeenCalled();
  });

  test('6. a rejected synonym shows an inline reason and stays unadded; an accepted one is added', () => {
    renderPanel({ watchlist: makeWatchlist({ tags: [makeTag({ tag: 'Existing' })] }) });
    fireEvent.click(screen.getByText('Existing'));
    const synInput = screen.getByPlaceholderText('add synonym…') as HTMLInputElement;

    fireEvent.change(synInput, { target: { value: 'of' } });
    fireEvent.blur(synInput);
    expect(screen.getByText(/too short to match safely/i)).toBeInTheDocument();
    expect(synInput.value).toBe('of');
    expect(document.querySelectorAll('.ci-chip').length).toBe(0);

    fireEvent.change(synInput, { target: { value: 'AI' } });
    fireEvent.blur(synInput);
    expect(screen.queryByText(/too short to match safely/i)).not.toBeInTheDocument();
    const chips = document.querySelectorAll('.ci-chip');
    expect(chips.length).toBe(1);
    expect(chips[0]!.textContent).toContain('AI');
  });

  test('7. resync is suppressed while a save is in flight, and adopts once it clears', () => {
    const v1 = makeWatchlist({ tags: [makeTag({ tag: 'Alpha' })] });
    const v2 = makeWatchlist({ tags: [makeTag({ tag: 'Beta' })] });
    const { rerender } = renderPanel({ watchlist: v1, saving: true });
    expect(screen.getByText('Alpha')).toBeInTheDocument();

    rerender(
      <TrackerConfigPanel
        allIssueAreas={[]}
        watchlist={v2}
        prefs={makePrefs()}
        onSaveWatchlist={() => {}}
        onSavePrefs={() => {}}
        onRequestVerify={() => {}}
        onTestAlert={() => {}}
        typedTermsEnabled
        saving
      />,
    );
    // Still Alpha — a save in flight must not clobber the editor with a
    // (soon-to-be-stale) server value.
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Beta')).not.toBeInTheDocument();

    rerender(
      <TrackerConfigPanel
        allIssueAreas={[]}
        watchlist={v2}
        prefs={makePrefs()}
        onSaveWatchlist={() => {}}
        onSavePrefs={() => {}}
        onRequestVerify={() => {}}
        onTestAlert={() => {}}
        typedTermsEnabled
        saving={false}
      />,
    );
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
  });

  test('8. server-rejected terms render a "Not saved" line', () => {
    renderPanel({
      watchlist: makeWatchlist({
        rejected: {
          topics: [],
          terms: [{ topicLabel: 'Alpha', termType: 'synonym', value: 'of', reason: 'too short to match safely' }],
        },
      }),
    });
    const line = screen.getByText(/Not saved:/i);
    expect(line).toHaveTextContent('"of"');
    expect(line).toHaveTextContent(/too short to match safely/i);
  });

  test('9. typedTermsEnabled=false hides the typed-term editor but naming still works', () => {
    const onSave = vi.fn();
    renderPanel({ typedTermsEnabled: false, onSaveWatchlist: onSave });
    fireEvent.click(screen.getByRole('button', { name: /Add tag/i }));
    // P2-15 (Gate E phase e) added source-aware help copy that itself
    // mentions "typed terms" in prose, so a loose /Typed terms/i text match
    // now also hits that (unrelated, always-rendered) help text. Target the
    // editor's own control instead — unique to the actual editor mounting.
    expect(screen.queryByLabelText('Term type')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Tag name'), { target: { value: 'X-Ray' } });
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  test('10. a resync that reorders tags keeps the SAME tag open, tracked by stable id (Gate K, MP-08)', () => {
    const v1 = makeWatchlist({
      tags: [makeTag({ id: 't-alpha', tag: 'Alpha' }), makeTag({ id: 't-beta', tag: 'Beta' })],
    });
    const { rerender } = renderPanel({ watchlist: v1 });
    // Open Beta — the second row, index 1.
    fireEvent.click(screen.getByText('Beta'));
    expect((screen.getByLabelText('Tag name') as HTMLInputElement).value).toBe('Beta');

    // A save round-trip can return topics in a different order than the local
    // array had them (e.g. a just-touched topic sorts first) — index 1 now
    // holds Alpha, not Beta. `openTags` is keyed by the topic's server id
    // (t-beta), which is unchanged by the reorder, so identity survives
    // without needing to infer anything from label or position.
    const v2 = makeWatchlist({
      tags: [makeTag({ id: 't-beta', tag: 'Beta' }), makeTag({ id: 't-alpha', tag: 'Alpha' })],
    });
    rerender(
      <TrackerConfigPanel
        allIssueAreas={[]}
        watchlist={v2}
        prefs={makePrefs()}
        onSaveWatchlist={() => {}}
        onSavePrefs={() => {}}
        onRequestVerify={() => {}}
        onTestAlert={() => {}}
        typedTermsEnabled
      />,
    );
    expect((screen.getByLabelText('Tag name') as HTMLInputElement).value).toBe('Beta');
  });

  test('10b. a resync that reorders tags with NO id (legacy/pre-Gate-K shape) still bridges the open row by label', () => {
    // Historical safety net: some watchlist reads may carry no id at all (a
    // synthetic fold-back topic before its first save). The id-based fast
    // path cannot apply, so the resync must still fall back to a label
    // bridge rather than silently losing track of which row was open.
    const v1 = makeWatchlist({ tags: [makeTag({ tag: 'Alpha' }), makeTag({ tag: 'Beta' })] });
    const { rerender } = renderPanel({ watchlist: v1 });
    fireEvent.click(screen.getByText('Beta'));
    expect((screen.getByLabelText('Tag name') as HTMLInputElement).value).toBe('Beta');

    const v2 = makeWatchlist({ tags: [makeTag({ tag: 'Beta' }), makeTag({ tag: 'Alpha' })] });
    rerender(
      <TrackerConfigPanel
        allIssueAreas={[]}
        watchlist={v2}
        prefs={makePrefs()}
        onSaveWatchlist={() => {}}
        onSavePrefs={() => {}}
        onRequestVerify={() => {}}
        onTestAlert={() => {}}
        typedTermsEnabled
      />,
    );
    expect((screen.getByLabelText('Tag name') as HTMLInputElement).value).toBe('Beta');
  });

  test('11. a resync that reorders tags does NOT migrate in-progress draft text to a different tag (Gate K, b-7 — data confusion, not a cosmetic quirk)', () => {
    const v1 = makeWatchlist({
      tags: [makeTag({ id: 't-alpha', tag: 'Alpha' }), makeTag({ id: 't-beta', tag: 'Beta' })],
    });
    const { rerender } = renderPanel({ watchlist: v1, saving: true });
    // Open Beta (index 1) and start typing an in-progress synonym — never
    // committed (no blur/Enter), so it lives only in ChipInput's local state.
    fireEvent.click(screen.getByText('Beta'));
    const synInput = screen.getByPlaceholderText('add synonym…') as HTMLInputElement;
    fireEvent.change(synInput, { target: { value: 'draft-in-progress' } });
    expect(synInput.value).toBe('draft-in-progress');

    // The server responds with Beta now sorted FIRST (index 0). `saving` was
    // true during the edit (a save was in flight for an unrelated reason);
    // clearing it now lets the resync adopt the reordered response — the
    // exact moment the old index-keyed `key=` would swap React's component
    // instance for this slot, carrying the draft text to whatever tag now
    // sits at index 1 (Alpha) instead of leaving it with Beta.
    const v2 = makeWatchlist({
      tags: [makeTag({ id: 't-beta', tag: 'Beta' }), makeTag({ id: 't-alpha', tag: 'Alpha' })],
    });
    rerender(
      <TrackerConfigPanel
        allIssueAreas={[]}
        watchlist={v2}
        prefs={makePrefs()}
        onSaveWatchlist={() => {}}
        onSavePrefs={() => {}}
        onRequestVerify={() => {}}
        onTestAlert={() => {}}
        typedTermsEnabled
        saving={false}
      />,
    );

    // Still Beta's editor open, and the draft text is still there — keyed by
    // id, React reused the SAME component instance for the SAME topic.
    expect((screen.getByLabelText('Tag name') as HTMLInputElement).value).toBe('Beta');
    expect((screen.getByPlaceholderText('add synonym…') as HTMLInputElement).value).toBe(
      'draft-in-progress',
    );
  });
});
