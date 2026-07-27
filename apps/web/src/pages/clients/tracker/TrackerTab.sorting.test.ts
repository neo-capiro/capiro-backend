import { describe, expect, test } from 'vitest';
import { dateVal } from './TrackerTab.js';

/**
 * Gate D phase f (P1-16) — "Newest action" ignored the year.
 *
 * The old dateVal split on '-' and read only parts[1] (month) and parts[2]
 * (day), returning `MONTHS[m] * 31 + day`. parts[0] — the YEAR — was never
 * touched, so December 2025 scored 356 and January 2026 scored 20, and last
 * year's bills sorted first. Audit test-gap item 14.
 */
describe('dateVal — P1-16', () => {
  /** f-6 case 1: THE regression. */
  test('a January 2026 action outranks a December 2025 one', () => {
    expect(dateVal('2026-01-20')).toBeGreaterThan(dateVal('2025-12-15'));
  });

  test('the old month*31+day formula would have got this backwards', () => {
    // Documents the bug so the fix cannot be quietly reverted:
    //   Dec 2025 → 11*31+15 = 356 ; Jan 2026 → 0*31+20 = 20
    const legacyDec = 11 * 31 + 15;
    const legacyJan = 0 * 31 + 20;
    expect(legacyDec).toBeGreaterThan(legacyJan); // the bug
    expect(dateVal('2026-01-20')).toBeGreaterThan(dateVal('2025-12-15')); // the fix
  });

  /** f-6 case 2. */
  test('null and garbage are 0; a full ISO timestamp parses', () => {
    expect(dateVal(null)).toBe(0);
    expect(dateVal('garbage')).toBe(0);
    expect(dateVal('')).toBe(0);
    expect(dateVal('2026-01-20T10:00:00Z')).toBeGreaterThan(0);
  });

  /**
   * Edge case 13: `Date.parse` treats a bare YYYY-MM-DD as UTC but a bare
   * YYYY-MM-DDTHH:mm:ss (no zone) as LOCAL. The 10-char branch appends Z for
   * exactly this reason; a naive "just parse it" fix introduces a timezone bug
   * the old month/day code did not have. This pins the UTC interpretation.
   */
  test('a date-only value is parsed as UTC midnight, not local', () => {
    expect(dateVal('2026-01-20')).toBe(Date.parse('2026-01-20T00:00:00Z'));
  });

  test('orders correctly within a month, and across a year boundary', () => {
    expect(dateVal('2026-01-21')).toBeGreaterThan(dateVal('2026-01-20'));
    expect(dateVal('2026-01-01')).toBeGreaterThan(dateVal('2025-12-31'));
    expect(dateVal('2025-01-01')).toBeLessThan(dateVal('2026-01-01'));
  });

  /** f-6 case 3: the sort that consumes it. */
  test('sorting recs by newest puts the 2026 action first', () => {
    const recs = [
      { displayNum: 'H.R. 1', latestActionDate: '2025-12-15' },
      { displayNum: 'H.R. 2', latestActionDate: '2026-01-20' },
      { displayNum: 'H.R. 3', latestActionDate: null },
    ];
    const sorted = [...recs].sort(
      (a, b) => dateVal(b.latestActionDate) - dateVal(a.latestActionDate),
    );
    expect(sorted.map((r) => r.displayNum)).toEqual(['H.R. 2', 'H.R. 1', 'H.R. 3']);
  });
});
