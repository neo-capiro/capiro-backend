import { describe, expect, it } from 'vitest';
import {
  assignColumnLanes,
  axisPosition,
  buildFiscalAxis,
  columnLaneCount,
  columnSpan,
  currentFiscalYear,
  monthEndIso,
  monthIndexOf,
  monthStartIso,
  shiftIsoMonths,
  toDateOnly,
} from './timeline.js';

const axis = buildFiscalAxis(2027, 2029);

describe('buildFiscalAxis', () => {
  it('spans inclusive fiscal years with 12 months each', () => {
    expect(axis.cells).toHaveLength(36);
    expect(axis.startFy).toBe(2027);
    expect(axis.endFy).toBe(2029);
  });

  it('starts FY27 in October 2026 (federal fiscal convention)', () => {
    const first = axis.cells[0]!;
    expect(first.year).toBe(2026);
    expect(first.month).toBe(10);
    expect(first.label).toBe('OCT');
    expect(first.fy).toBe(2027);
  });

  it('marks a fiscal-year boundary at each October', () => {
    const boundaries = axis.cells.filter((c) => c.fiscalYearStart);
    expect(boundaries).toHaveLength(3);
    expect(boundaries.every((c) => c.month === 10)).toBe(true);
  });
});

describe('currentFiscalYear', () => {
  it('rolls to the next FY on October 1', () => {
    expect(currentFiscalYear(new Date('2026-09-30T00:00:00Z'))).toBe(2026);
    expect(currentFiscalYear(new Date('2026-10-01T00:00:00Z'))).toBe(2027);
  });

  it('matches the api-strategy fiscal rule for a mid-year date', () => {
    // 2026-08-19 sits in FY2026 — the window api-strategy generates its
    // reference calendars against, and the window the editor must draw.
    expect(currentFiscalYear(new Date('2026-08-19T00:00:00Z'))).toBe(2026);
  });
});

describe('axisPosition', () => {
  it('clamps to [0,1]', () => {
    expect(axisPosition(axis, new Date('2000-01-01'))).toBe(0);
    expect(axisPosition(axis, new Date('2099-01-01'))).toBe(1);
  });

  it('puts a date inside the window strictly between the ends', () => {
    // The TODAY marker only draws when this is a real interior position; a
    // window that excludes today is what used to hide it entirely.
    const inWindow = buildFiscalAxis(2026, 2028);
    const p = axisPosition(inWindow, new Date('2026-08-19T00:00:00Z'));
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
  });
});

describe('monthIndexOf', () => {
  it('is 0 for the first month and 35 for the last', () => {
    expect(monthIndexOf(axis, new Date('2026-10-15T00:00:00Z'))).toBe(0);
    expect(monthIndexOf(axis, new Date('2029-09-01T00:00:00Z'))).toBe(35);
  });

  it('goes negative before the axis starts', () => {
    expect(monthIndexOf(axis, new Date('2026-08-15T00:00:00Z'))).toBe(-2);
  });
});

describe('columnSpan', () => {
  it('covers every month the bar touches', () => {
    // Jan 29 -> Feb 19 occupies two month columns, not one.
    const s = columnSpan(axis, '2027-01-29', '2027-02-19');
    expect(s).toEqual({ start: 3, span: 2, clippedStart: false, clippedEnd: false, trueSpan: 2 });
  });

  it('clips a bar that starts before the axis instead of dropping it', () => {
    const s = columnSpan(axis, '2025-01-01', '2027-06-01')!;
    expect(s.start).toBe(0);
    expect(s.clippedStart).toBe(true);
    expect(s.clippedEnd).toBe(false);
  });

  it('returns null only when fully outside', () => {
    expect(columnSpan(axis, '2035-01-01', '2036-01-01')).toBeNull();
    expect(columnSpan(axis, '2020-01-01', '2020-06-01')).toBeNull();
  });

  it('gives a point-in-time bar one column, and pads it only when asked', () => {
    const exact = columnSpan(axis, '2027-03-14', null)!;
    expect(exact.span).toBe(1);
    expect(exact.trueSpan).toBe(1);

    const padded = columnSpan(axis, '2027-03-14', null, 3)!;
    expect(padded.span).toBe(3);
    // The padding grows rightward so the bar still begins on its real month.
    expect(padded.start).toBe(exact.start);
    // trueSpan still reports what the dates actually cover.
    expect(padded.trueSpan).toBe(1);
  });

  it('pads leftward when there is no room on the right', () => {
    const padded = columnSpan(axis, '2029-09-01', null, 3)!;
    expect(padded.span).toBe(3);
    expect(padded.start).toBe(33);
  });
});

describe('assignColumnLanes', () => {
  it('separates bars that share a month column even when their dates do not overlap', () => {
    // "Floor & amendments" ends Aug 17 and "Conference" starts Aug 17: disjoint
    // as instants, same August cell on the grid. Laning by date put them in one
    // cell and one covered the other.
    const laned = assignColumnLanes([
      { id: 'floor', start: 9, span: 2 },
      { id: 'conference', start: 10, span: 2 },
    ]);
    expect(columnLaneCount(laned)).toBe(2);
  });

  it('reuses a lane for bars in disjoint columns', () => {
    const laned = assignColumnLanes([
      { id: 'a', start: 0, span: 3 },
      { id: 'b', start: 3, span: 3 },
    ]);
    expect(columnLaneCount(laned)).toBe(1);
  });

  it('is stable regardless of input order', () => {
    const a = { id: 'a', start: 0, span: 4 };
    const b = { id: 'b', start: 2, span: 4 };
    const first = assignColumnLanes([a, b]).map((l) => `${l.item.id}:${l.lane}`);
    const second = assignColumnLanes([b, a]).map((l) => `${l.item.id}:${l.lane}`);
    expect(first).toEqual(second);
  });
});

describe('date edits', () => {
  it('shifts by whole months keeping the day of month', () => {
    expect(shiftIsoMonths('2027-01-29', 1)).toBe('2027-02-28');
    expect(shiftIsoMonths('2027-03-14', 2)).toBe('2027-05-14');
    expect(shiftIsoMonths('2027-01-15', -3)).toBe('2026-10-15');
  });

  it('clamps into a shorter month rather than rolling into the next one', () => {
    // Jan 31 + 1 month is Feb 28, never Mar 3.
    expect(shiftIsoMonths('2027-01-31', 1)).toBe('2027-02-28');
    expect(shiftIsoMonths('2028-01-31', 1)).toBe('2028-02-29');
  });

  it('crosses a year boundary in both directions', () => {
    expect(shiftIsoMonths('2027-11-10', 3)).toBe('2028-02-10');
    expect(shiftIsoMonths('2027-02-10', -3)).toBe('2026-11-10');
  });

  it('brackets a month column with a start and end the service will accept', () => {
    const start = monthStartIso(axis, 0);
    const end = monthEndIso(axis, 0);
    expect(start).toBe('2026-10-01');
    expect(end).toBe('2026-10-31');
    // ReferenceService.fork rejects endsOn <= startsOn.
    expect(new Date(end).getTime()).toBeGreaterThan(new Date(start).getTime());
  });

  it('formats a UTC date as the YYYY-MM-DD the fork DTO requires', () => {
    expect(toDateOnly(new Date('2026-01-29T00:00:00.000Z'))).toBe('2026-01-29');
  });
});
