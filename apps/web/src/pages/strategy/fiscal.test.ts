import { describe, expect, it } from 'vitest';
import {
  buildCalendar,
  fyOf,
  qOfDate,
  fyQuarterToQ,
  qToDate,
  addMonths,
  formatDbDate,
  parseDbDate,
  shiftNodeMonths,
} from './fiscal.js';

describe('strategy fiscal calendar', () => {
  const now = new Date(2027, 0, 15); // Jan 15 2027 → FY2027
  const cal = buildCalendar(now);

  it('fyOf: Oct 1 rolls into next FY; Sep 30 stays', () => {
    expect(fyOf(new Date(2026, 8, 30))).toBe(2026);
    expect(fyOf(new Date(2026, 9, 1))).toBe(2027);
    expect(fyOf(now)).toBe(2027);
  });

  it('buildCalendar: rolling 3-FY window + 12 quarters + 36 months', () => {
    expect(cal.fys).toEqual([2027, 2028, 2029]);
    expect(cal.fyLabels).toEqual(['FY27', 'FY28', 'FY29']);
    expect(cal.focalFy).toBe('FY28');
    expect(cal.quarters).toHaveLength(12);
    expect(cal.months).toHaveLength(36);
    // axis origin = Oct 1 of the calendar year before the first shown FY
    expect(cal.axisStart.getFullYear()).toBe(2026);
    expect(cal.axisStart.getMonth()).toBe(9);
  });

  it('qOfDate: axis origin is q=0; +1 year ≈ q=4', () => {
    expect(qOfDate(cal.axisStart, cal)).toBeCloseTo(0, 5);
    const oneYear = qOfDate(new Date(2027, 9, 1), cal); // Oct 1 2027
    expect(oneYear).toBeCloseTo(4, 1);
  });

  it('fyQuarterToQ: firm-phase FY+quarter → quarter index in the window', () => {
    expect(fyQuarterToQ(2027, 1, cal)).toBe(0); // FY27 Q1 = first column
    expect(fyQuarterToQ(2027, 4, cal)).toBe(3);
    expect(fyQuarterToQ(2028, 1, cal)).toBe(4);
    expect(fyQuarterToQ(2029, 4, cal)).toBe(11); // last column
  });

  it('qToDate round-trips through the axis origin', () => {
    const d = qToDate(0, cal.axisStart);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(9); // October
  });

  it('a Feb 6 2027 submission maps into FY27 Q2 territory (q≈1.2–1.5)', () => {
    const q = qOfDate(new Date(2027, 1, 6), cal);
    expect(q).toBeGreaterThan(1);
    expect(q).toBeLessThan(2);
  });

  it('formatDbDate round-trips through parseDbDate', () => {
    expect(formatDbDate(parseDbDate('2027-02-06'))).toBe('2027-02-06');
  });

  it('addMonths clamps the day to the target month length', () => {
    expect(formatDbDate(addMonths(new Date(2027, 0, 31), 1))).toBe('2027-02-28'); // Jan 31 → Feb
  });

  it('shiftNodeMonths shifts start+end by the same delta (duration preserved)', () => {
    const r = shiftNodeMonths('2027-02-06', '2027-04-06', 3, cal);
    expect(r.applied).toBe(3);
    expect(r.startsOn).toBe('2027-05-06');
    expect(r.endsOn).toBe('2027-07-06');
  });

  it('shiftNodeMonths clamps at the window end (no shift past the last month)', () => {
    // Sep 2029 is the last shown month; +3 clamps to a no-op.
    const r = shiftNodeMonths('2029-09-15', null, 3, cal);
    expect(r.applied).toBe(0);
    expect(r.startsOn).toBe('2029-09-15');
  });

  it('shiftNodeMonths handles a null end (point event)', () => {
    const r = shiftNodeMonths('2027-02-06', null, -1, cal);
    expect(r.applied).toBe(-1);
    expect(r.startsOn).toBe('2027-01-06');
    expect(r.endsOn).toBeNull();
  });
});
