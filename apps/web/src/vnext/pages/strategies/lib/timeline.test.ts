import { describe, expect, it } from 'vitest';
import { buildCalendar, packSpans, qOfDate } from './timeline.js';

describe('buildCalendar (re-exported from pages/strategy/fiscal.ts)', () => {
  it('shows the rolling 3-FY window anchored on the given "now"', () => {
    const cal = buildCalendar(new Date(2026, 7, 19)); // Aug 19 2026 -> FY2026
    expect(cal.fys).toEqual([2026, 2027, 2028]);
    expect(cal.months).toHaveLength(36);
    expect(cal.months[0]!.m).toBe('Oct');
    expect(cal.months[0]!.fyStart).toBe(true);
  });

  it('rolls to the next FY on October 1 (federal fiscal convention)', () => {
    expect(buildCalendar(new Date(2026, 8, 30)).fys[0]).toBe(2026); // Sep 30 -> still FY26
    expect(buildCalendar(new Date(2026, 9, 1)).fys[0]).toBe(2027); // Oct 1 -> FY27
  });

  it('places "today" inside the window, never clamped to an edge', () => {
    const cal = buildCalendar(new Date(2026, 7, 19));
    // todayQ is in quarter-units from the axis origin; the window is always
    // 12 quarters (3 FYs), so an interior "today" must land strictly between.
    expect(cal.todayQ).toBeGreaterThan(0);
    expect(cal.todayQ).toBeLessThan(12);
  });
});

describe('qOfDate', () => {
  it('is 0 at the axis origin and increases by 1 per quarter', () => {
    const cal = buildCalendar(new Date(2026, 7, 19));
    expect(qOfDate(cal.axisStart, cal)).toBe(0);
    const threeMonthsLater = new Date(cal.axisStart.getFullYear(), cal.axisStart.getMonth() + 3, 1);
    expect(qOfDate(threeMonthsLater, cal)).toBeCloseTo(1, 5);
  });
});

describe('packSpans', () => {
  it('separates overlapping items into distinct lanes', () => {
    const { items, rows } = packSpans([
      { id: 'a', s: 0, e: 4 },
      { id: 'b', s: 2, e: 6 },
    ]);
    expect(rows).toBe(2);
    const byId = new Map(items.map((i) => [i.id, i._row]));
    expect(byId.get('a')).not.toBe(byId.get('b'));
  });

  it('reuses a lane for items that do not overlap', () => {
    const { rows } = packSpans([
      { id: 'a', s: 0, e: 3 },
      { id: 'b', s: 3, e: 6 },
    ]);
    expect(rows).toBe(1);
  });

  it('is stable regardless of input order (sorts by start internally)', () => {
    const a = { id: 'a', s: 0, e: 4 };
    const b = { id: 'b', s: 2, e: 6 };
    const first = packSpans([a, b]).items.map((i) => `${i.id}:${i._row}`);
    const second = packSpans([b, a]).items.map((i) => `${i.id}:${i._row}`);
    expect(first).toEqual(second);
  });

  it('pads a short item to minSpan for both packing and the rendered width', () => {
    const { items } = packSpans([{ id: 'a', s: 5, e: 5.2 }], 1.9);
    expect(items[0]!._packEnd).toBeCloseTo(5 + 1.9, 5);
  });

  it('uses the padded end (not the raw end) to decide lane collisions', () => {
    // Two items whose RAW spans don't overlap, but whose minSpan-1.9-padded
    // ends would — this is the legislative-band case (a short milestone
    // padded wide enough to read its label collides with its neighbor unless
    // the packer accounts for the padding, not just the true dates).
    const { rows } = packSpans(
      [
        { id: 'a', s: 0, e: 0.5 },
        { id: 'b', s: 1, e: 1.5 },
      ],
      1.9,
    );
    expect(rows).toBe(2);
  });

  it('does not pad an item that is already longer than minSpan', () => {
    const { items } = packSpans([{ id: 'a', s: 0, e: 5 }], 1.9);
    expect(items[0]!._packEnd).toBe(5);
  });
});
