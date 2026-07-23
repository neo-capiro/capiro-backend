import { describe, expect, it } from 'vitest';
import { buildCalendar, fyOf, qOfDate, fyQuarterToQ, qToDate } from './fiscal.js';

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
});
