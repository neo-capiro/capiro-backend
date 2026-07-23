import { describe, expect, it } from '@jest/globals';
import { parseDbDate } from './dates.js';

describe('parseDbDate', () => {
  it('accepts a real calendar date (UTC midnight)', () => {
    expect(parseDbDate('2027-02-06').toISOString()).toBe('2027-02-06T00:00:00.000Z');
  });

  it('accepts a leap day in a leap year', () => {
    expect(parseDbDate('2028-02-29').toISOString().slice(0, 10)).toBe('2028-02-29');
  });

  it.each(['2027-02-30', '2027-02-29', '2027-04-31', '2027-06-31', '2027-11-31', '2027-13-01', '2027-00-10', '2027-01-00'])(
    'rejects the calendar-impossible date %s (rollover-safe)',
    (bad) => {
      expect(() => parseDbDate(bad)).toThrow();
    },
  );
});
