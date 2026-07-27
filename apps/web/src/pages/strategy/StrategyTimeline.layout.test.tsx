/*
 * Phase 1 §4.10, §4.12, §4.13 — the timeline's frozen-column / scroll contract.
 *
 * What broke before: the label cells were `position: sticky` children INSIDE the
 * horizontally scrolling composition, and the only horizontal scroller was the
 * editor's own container — so grid content bled to the left of the labels and the
 * document itself grew a horizontal scrollbar. The structure asserted here is the
 * fix: two sibling regions, one shared set of row heights, and the grid viewport
 * owning overflow-x.
 *
 * jsdom has no layout engine, so §4.13 is asserted STRUCTURALLY (the invariants
 * that make document-level overflow impossible). The rendered 1440px
 * scrollWidth === clientWidth check is done in the browser parity pass.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { StrategyTimeline } from './StrategyTimeline.js';
import { todayScrollLeft } from './timeline-scroll.js';
import { buildCalendar } from './fiscal.js';
import type { ReferenceRow, StrategyNode } from './types.js';

const calendar = buildCalendar(new Date('2026-07-27T12:00:00Z'));
const COLW = 100;
const RAIL = 176;

const congress: ReferenceRow[] = [
  {
    id: 'c1',
    kind: 'congress_milestone',
    label: 'Committee markups',
    fy: 2027,
    startsOn: '2027-05-01',
    endsOn: '2027-06-30',
    tone: null,
    position: 0,
  },
];

const node: StrategyNode = {
  id: 'n1',
  kind: 'action',
  subject: 'deliverable',
  title: 'Submit the ask',
  status: 'draft',
  startsOn: '2026-11-01',
  endsOn: null,
} as unknown as StrategyNode;

function renderTimeline(over: Record<string, unknown> = {}) {
  return render(
    <StrategyTimeline
      strategyId="strat-1"
      calendar={calendar}
      nodes={[node]}
      congress={congress}
      ppbeLanes={[]}
      ppbeCurrentPhases={[]}
      firmPhases={[]}
      layers={{ ppbe: true, congress: true }}
      selectedId={null}
      onSelectNode={() => {}}
      {...over}
    />,
  );
}

const labels = () => screen.getByTestId('sp-timeline-labels');
const clip = () => screen.getByTestId('sp-timeline-clip');
const scroller = () => screen.getByTestId('sp-timeline-grid-scroller');
/** The single width-W column inside the scroller. */
const gridColumn = () => scroller().firstElementChild as HTMLElement;

/** jsdom reports 0 for every box; hand the scroller real numbers. */
function measure(el: HTMLElement, clientWidth: number, scrollWidth: number) {
  Object.defineProperty(el, 'clientWidth', { value: clientWidth, configurable: true });
  Object.defineProperty(el, 'scrollWidth', { value: scrollWidth, configurable: true });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('frozen column and grid are SIBLING regions (§4.12)', () => {
  test('the label column and the clip region share a parent, in that order', () => {
    renderTimeline();
    expect(labels().parentElement).toBe(clip().parentElement);
    expect(labels().nextElementSibling).toBe(clip());
  });

  test('the horizontal scroller lives inside the clip region', () => {
    renderTimeline();
    expect(clip().contains(scroller())).toBe(true);
    // …and the labels are NOT inside it, which is the whole point.
    expect(scroller().contains(labels())).toBe(false);
  });

  test('the label column is opaque, RAIL-wide, and paints above the grid', () => {
    renderTimeline();
    const col = labels();
    expect(col.style.width).toBe(`${RAIL}px`);
    expect(col.style.flexShrink).toBe('0');
    expect(col.style.position).toBe('relative');
    expect(col.style.zIndex).toBe('2');
    expect(col.style.isolation).toBe('isolate');
    expect(col.style.background).toBe('var(--bg-surface)');
    expect(col.style.borderRight).toBe('1px solid var(--border-strong)');
    // above the clip region, which carries the bars, grid cells and today marker
    expect(clip().style.zIndex).toBe('1');
  });

  test('no label row is transparent and none uses a negative offset', () => {
    renderTimeline();
    for (const row of [...labels().children] as HTMLElement[]) {
      expect(row.style.background).not.toBe('');
      expect(row.style.background).not.toContain('transparent');
      expect(row.style.left).toBe('');
      expect(row.style.marginLeft).toBe('');
    }
  });

  test('label rows and grid rows come from ONE descriptor, so heights cannot drift', () => {
    renderTimeline();
    const labelRows = [...labels().children] as HTMLElement[];
    const gridRows = [...gridColumn().children] as HTMLElement[];
    expect(labelRows).toHaveLength(gridRows.length);
    expect(labelRows.length).toBeGreaterThan(3);
    labelRows.forEach((lr, i) => {
      const gr = gridRows[i]!;
      expect(lr.style.height).toBe(gr.style.height);
      expect(lr.style.minHeight).toBe(gr.style.minHeight);
      expect(lr.style.flex).toBe(gr.style.flex);
      expect(lr.style.borderTop).toBe(gr.style.borderTop);
      expect(lr.style.borderBottom).toBe(gr.style.borderBottom);
      expect(lr.style.boxSizing).toBe('content-box');
    });
    // exactly one flexible row — the last — so the column paints to the bottom
    const flexible = labelRows.filter((r) => r.style.height === '');
    expect(flexible).toHaveLength(1);
    expect(flexible[0]).toBe(labelRows[labelRows.length - 1]);
    expect(flexible[0]!.style.minHeight).toContain('72vh');
  });

  test('the row set follows the enabled layers', () => {
    const { unmount } = renderTimeline({ layers: { ppbe: false, congress: false } });
    const withoutLayers = labels().children.length;
    unmount();
    renderTimeline({ layers: { ppbe: true, congress: true } });
    expect(labels().children.length).toBeGreaterThan(withoutLayers);
  });
});

describe('only the grid scrolls horizontally (§4.13)', () => {
  test('the grid viewport owns overflow-x and never overflows vertically', () => {
    renderTimeline();
    expect(scroller().style.overflowX).toBe('auto');
    expect(scroller().style.overflowY).toBe('hidden');
  });

  test('the clip region hides anything that escapes, and can shrink', () => {
    renderTimeline();
    expect(clip().style.overflow).toBe('hidden');
    expect(clip().style.minWidth).toBe('0px');
  });

  test('the frame can shrink below its content and clips', () => {
    renderTimeline();
    const frame = screen.getByTestId('sp-timeline-frame');
    expect(frame.style.minWidth).toBe('0px');
    expect(frame.style.maxWidth).toBe('100%');
    expect(frame.style.overflow).toBe('hidden');
    expect(frame.style.isolation).toBe('isolate');
  });

  test('the grid content is exactly one month-column wide per rendered month', () => {
    renderTimeline();
    expect(gridColumn().style.width).toBe(`${calendar.months.length * COLW}px`);
  });

  test('strategy-ds.css does NOT hide overflow on body or html', () => {
    const raw = readFileSync(resolve('src/pages/strategy/strategy-ds.css'), 'utf8');
    // Comments explain WHY the body hack was rejected, so assert on declarations only.
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
    // no global escape hatch anywhere in the feature's stylesheet…
    expect(css).not.toMatch(/overflow-x/i);
    // …and no unscoped body/html selector that could reach outside .sp-root
    expect(css).not.toMatch(/^\s*(body|html)\b/m);
    // the containment is min-width:0 on the ancestor chain instead
    expect(css).toMatch(/min-width:\s*0/);
  });
});

describe('today is centred after the final measurement (§4.10)', () => {
  /** Stubs rAF so frames can be flushed deliberately, after measuring. */
  function captureFrames() {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    return {
      flush: () => {
        // each frame may schedule the next, so drain the queue
        for (let guard = 0; guard < 10 && frames.length; guard++) {
          const pending = frames.splice(0, frames.length);
          pending.forEach((cb) => cb(0));
        }
      },
    };
  }

  const expected = (clientWidth: number, scrollWidth: number) =>
    todayScrollLeft({
      todayX: calendar.todayQ * 3 * COLW,
      rangeStartX: 0,
      rangeEndX: calendar.months.length * COLW,
      viewportWidth: clientWidth,
      contentWidth: scrollWidth,
    });

  test('scrollLeft is set only once the grid has a measured width', () => {
    const { flush } = captureFrames();
    renderTimeline();
    const el = scroller();
    expect(el.scrollLeft).toBe(0);

    measure(el, 1200, 3600);
    flush();

    expect(el.scrollLeft).toBe(expected(1200, 3600));
    expect(el.scrollLeft).toBeGreaterThan(0);
  });

  test('an unmeasured grid is left alone until a mocked resize reports width', () => {
    const observers: Array<() => void> = [];
    class RO {
      constructor(private cb: () => void) {
        observers.push(() => this.cb());
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', RO as unknown as typeof ResizeObserver);
    const { flush } = captureFrames();

    renderTimeline();
    const el = scroller();
    // width still 0 on both frames → nothing written
    flush();
    expect(el.scrollLeft).toBe(0);

    // the panel/zoom settles and the observer fires with real numbers
    measure(el, 900, 3600);
    observers.forEach((fire) => fire());
    expect(el.scrollLeft).toBe(expected(900, 3600));
  });

  test('a node edit does NOT re-centre, but opening another strategy does', () => {
    const { flush } = captureFrames();
    const { rerender } = renderTimeline();
    const el = scroller();
    measure(el, 1200, 3600);
    flush();
    const centred = el.scrollLeft;
    expect(centred).toBeGreaterThan(0);

    // the user scrolls away, then edits a step (same strategy, same range)
    el.scrollLeft = 42;
    rerender(
      <StrategyTimeline
        strategyId="strat-1"
        calendar={calendar}
        nodes={[{ ...node, title: 'Submit the ask (edited)' }]}
        congress={congress}
        ppbeLanes={[]}
        ppbeCurrentPhases={[]}
        firmPhases={[]}
        layers={{ ppbe: true, congress: true }}
        selectedId={null}
        onSelectNode={() => {}}
      />,
    );
    flush();
    expect(el.scrollLeft).toBe(42);

    // …opening a DIFFERENT strategy re-arms the one-shot centring
    rerender(
      <StrategyTimeline
        strategyId="strat-2"
        calendar={calendar}
        nodes={[node]}
        congress={congress}
        ppbeLanes={[]}
        ppbeCurrentPhases={[]}
        firmPhases={[]}
        layers={{ ppbe: true, congress: true }}
        selectedId={null}
        onSelectNode={() => {}}
      />,
    );
    measure(scroller(), 1200, 3600);
    flush();
    expect(scroller().scrollLeft).toBe(centred);
  });

  test('a mid-layout scrollWidth === clientWidth does NOT claim the one-shot', () => {
    // The trap: mid-layout the scroller can report scrollWidth === clientWidth,
    // which looks like "this plan is too narrow to scroll". Writing 0 and
    // claiming the key there left today permanently off-screen once the grid
    // reached its real width. The guard waits for the grid's declared width.
    const observers: Array<() => void> = [];
    class RO {
      constructor(private cb: () => void) {
        observers.push(() => this.cb());
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', RO as unknown as typeof ResizeObserver);
    const { flush } = captureFrames();

    renderTimeline();
    const el = scroller();
    // looks unscrollable, but the grid has not reached its declared width yet
    measure(el, 1200, 1200);
    flush();
    expect(el.scrollLeft).toBe(0);

    // the grid finishes laying out and the observer fires
    measure(el, 1200, 3600);
    observers.forEach((fire) => fire());
    expect(el.scrollLeft).toBe(expected(1200, 3600));
    expect(el.scrollLeft).toBeGreaterThan(0);
  });

  test('a manual scroll before the measurement cancels the pending centring', () => {
    const { flush } = captureFrames();
    renderTimeline();
    const el = scroller();
    measure(el, 1200, 3600);
    el.dispatchEvent(new WheelEvent('wheel', { deltaX: 120 }));
    el.scrollLeft = 77;
    flush();
    expect(el.scrollLeft).toBe(77);
  });
});

describe('export mode renders unclipped at natural width', () => {
  test('no clip region or scroller, so html2canvas measures RAIL + W', () => {
    renderTimeline({ staticHeader: true });
    expect(screen.queryByTestId('sp-timeline-clip')).toBeNull();
    expect(screen.queryByTestId('sp-timeline-grid-scroller')).toBeNull();
    const frame = screen.getByTestId('sp-timeline-frame');
    expect(frame.style.maxWidth).toBe('');
    expect(frame.style.overflow).toBe('visible');
    // the label column is still the first child, grid column immediately after
    expect(labels().nextElementSibling).not.toBeNull();
    expect((labels().nextElementSibling as HTMLElement).style.width).toBe(
      `${calendar.months.length * COLW}px`,
    );
  });
});
