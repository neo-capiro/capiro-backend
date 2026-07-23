import { describe, expect, it } from '@jest/globals';
import { axisStart, currentFyWindow, fyOf, qToDate } from './fiscal.js';

describe('fiscal calendar helpers', () => {
  it('fyOf: Oct 1 rolls into the next FY; Sep 30 stays', () => {
    expect(fyOf(new Date(2026, 8, 30))).toBe(2026); // Sep 30 2026 -> FY2026
    expect(fyOf(new Date(2026, 9, 1))).toBe(2027); // Oct 1 2026 -> FY2027
    expect(fyOf(new Date(2027, 0, 15))).toBe(2027); // Jan 15 2027 -> FY2027
  });

  it('currentFyWindow: rolling 3-FY window', () => {
    expect(currentFyWindow(new Date(2026, 9, 1))).toEqual([2027, 2028, 2029]);
    expect(currentFyWindow(new Date(2026, 8, 30))).toEqual([2026, 2027, 2028]);
  });

  it('axisStart: Oct 1 of the calendar year before the first shown FY', () => {
    // now = Jan 2027 -> CUR_FY 2027 -> axis origin Oct 1 2026
    const start = axisStart(new Date(2027, 0, 15));
    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(9); // October (0-indexed)
    expect(start.getDate()).toBe(1);
  });

  it('qToDate: q=0 is the axis origin; q=4 advances one FY', () => {
    const now = new Date(2027, 0, 15); // CUR_FY 2027, axis origin Oct 1 2026
    const q0 = qToDate(0, now);
    expect(q0.getFullYear()).toBe(2026);
    expect(q0.getMonth()).toBe(9); // Oct
    const q4 = qToDate(4, now); // +4 quarters = +12 months from Oct 2026
    expect(q4.getFullYear()).toBe(2027);
    expect(q4.getMonth()).toBe(9); // Oct 2027
  });

  it('qToDate: fractional quarter lands mid-window and is deterministic', () => {
    const now = new Date(2027, 0, 15);
    const a = qToDate(1.34, now);
    const b = qToDate(1.34, now);
    expect(a.getTime()).toBe(b.getTime()); // stable
    // 1.34 q = ~4.02 months from Oct 2026 -> early Feb 2027
    expect(a.getFullYear()).toBe(2027);
    expect(a.getMonth()).toBe(1); // February
  });
});
