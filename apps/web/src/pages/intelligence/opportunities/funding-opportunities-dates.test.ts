import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { formatDeadline, formatSourceDate } from './funding-opportunities-api.js';

/**
 * Source calendar dates must render as the date the source stated, in every
 * reader timezone. A `@db.Date` / midnight-UTC calendar value that goes through
 * `new Date()` + local formatting shifts one day back for readers west of
 * Greenwich (Nov 15 → Nov 14). A real timestamp (SAM response_deadline) keeps
 * its instant. Pinned at a fixed instant in a US timezone.
 */
describe('opportunity source-date display', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('formatDeadline', () => {
    test('a bare YYYY-MM-DD calendar date renders as that date, not the prior day', () => {
      // Grants.gov close_date crosses the wire as '2026-11-15' (no instant).
      const { text } = formatDeadline('2026-11-15', null);
      expect(text).toContain('Nov');
      expect(text).toContain('15');
      expect(text).not.toContain('14');
    });

    test('calendar-date daysRemaining counts to the end of the stated local day', () => {
      const { daysRemaining } = formatDeadline('2026-11-15', null);
      // 2026-11-15 is 61 days after 2026-09-15; allow off-by-one for the
      // reader's own midnight boundary but never a negative or a wrong month.
      expect(daysRemaining).toBeGreaterThan(0);
    });

    test('a real timestamp deadline keeps its instant (SAM response_deadline)', () => {
      const { text } = formatDeadline('2026-11-20T17:00:00.000Z', null);
      // Renders Nov 20 in US timezones (17:00Z = 12:00 ET), not Nov 19.
      expect(text).toContain('20');
    });

    test('a deadline note still replaces a missing date', () => {
      expect(formatDeadline(null, 'Continuous')).toEqual({
        text: 'Continuous',
        daysRemaining: null,
      });
    });
  });

  describe('formatSourceDate', () => {
    test('a bare YYYY-MM-DD renders the stated day', () => {
      expect(formatSourceDate('2026-09-01')).toBe('1 Sep 2026');
      expect(formatSourceDate('2026-12-20')).toBe('20 Dec 2026');
    });

    test('a midnight-UTC instant (stored calendar date over a timestamp column) renders its UTC calendar date', () => {
      // nextActionDueAt is a Timestamptz that only ever carries a date.
      expect(formatSourceDate('2026-10-01T00:00:00.000Z')).toBe('1 Oct 2026');
      expect(formatSourceDate('2026-10-01T00:00:00Z')).toBe('1 Oct 2026');
    });

    test('a non-midnight real timestamp is echoed verbatim, never re-bucketed to a date', () => {
      expect(formatSourceDate('2026-11-20T17:00:00.000Z')).toBe('2026-11-20T17:00:00.000Z');
    });

    test('null returns the placeholder', () => {
      expect(formatSourceDate(null, 'No date')).toBe('No date');
    });
  });
});
