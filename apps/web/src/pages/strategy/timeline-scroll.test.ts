/*
 * Phase 1 §4.9 — the pure today-centering helper.
 *
 * The behaviour this pins down is exactly what the old mount-time approximation
 * got wrong: it scrolled to `todayX - COLW * 1.5` (an arbitrary 1.5 columns)
 * with a single `Math.max(0, …)` guard, so today landed off-centre at every
 * viewport width and an out-of-range today produced a nonsense offset.
 */
import { describe, expect, test } from 'vitest';
import { todayScrollLeft } from './timeline-scroll.js';

// A 36-month window at 100px per month, viewed through 1,200px.
const base = { rangeStartX: 0, rangeEndX: 3600, viewportWidth: 1200, contentWidth: 3600 };
const maxScroll = base.contentWidth - base.viewportWidth; // 2400

describe('todayScrollLeft', () => {
  test('centres today when it is inside the rendered range', () => {
    // today at 1,800px ⇒ 1800 - 1200/2 = 1200
    expect(todayScrollLeft({ ...base, todayX: 1800 })).toBe(1200);
  });

  test('clamps to 0 when centring would scroll past the content start', () => {
    // today at 400px would want -200
    expect(todayScrollLeft({ ...base, todayX: 400 })).toBe(0);
  });

  test('clamps to maxScrollLeft when centring would scroll past the end', () => {
    // today at 3,500px would want 2,900
    expect(todayScrollLeft({ ...base, todayX: 3500 })).toBe(maxScroll);
  });

  test('returns 0 when today is before the rendered range', () => {
    expect(todayScrollLeft({ ...base, rangeStartX: 900, todayX: 300 })).toBe(0);
  });

  test('returns maxScrollLeft when today is after the rendered range', () => {
    expect(todayScrollLeft({ ...base, rangeEndX: 2000, todayX: 2600 })).toBe(maxScroll);
  });

  test('returns 0 when there is nothing to scroll (content <= viewport)', () => {
    expect(todayScrollLeft({ ...base, contentWidth: 1200, todayX: 600 })).toBe(0);
    expect(todayScrollLeft({ ...base, contentWidth: 800, todayX: 600 })).toBe(0);
  });

  test('returns 0 on a zero scroll width', () => {
    expect(
      todayScrollLeft({ todayX: 0, rangeStartX: 0, rangeEndX: 0, viewportWidth: 0, contentWidth: 0 }),
    ).toBe(0);
  });

  test('a very narrow viewport still centres, never overshoots', () => {
    const narrow = { ...base, viewportWidth: 60, contentWidth: 3600 };
    // 1800 - 30 = 1770, well inside [0, 3540]
    expect(todayScrollLeft({ ...narrow, todayX: 1800 })).toBe(1770);
    // and the tail still clamps
    expect(todayScrollLeft({ ...narrow, todayX: 3600 })).toBe(3540);
  });

  test('never returns a value outside [0, maxScrollLeft] across the whole range', () => {
    for (let todayX = -500; todayX <= 4100; todayX += 50) {
      const v = todayScrollLeft({ ...base, todayX });
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(maxScroll);
    }
  });

  test('non-finite input degrades to 0 rather than writing NaN to scrollLeft', () => {
    expect(todayScrollLeft({ ...base, todayX: Number.NaN })).toBe(0);
    expect(
      todayScrollLeft({ ...base, contentWidth: Number.POSITIVE_INFINITY, todayX: 1800 }),
    ).toBe(0);
  });
});
