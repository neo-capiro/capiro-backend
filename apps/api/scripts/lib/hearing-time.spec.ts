import {
  etCalendarDay,
  etParts,
  etWallClockToInstant,
  formatTime,
  hearingCalendarDate,
  houseStartsAt,
  isDateOnlySentinel,
  parseEtClock,
} from './hearing-time';

/**
 * REGRESSION GUARD for the +4h hearing-time defect (2026-07-29).
 *
 * `sync-hearings.ts` formatted Congress.gov's `date` with `getUTCHours()`, under
 * the comment "Congress.gov encodes hearing times as UTC wall-clock for the
 * chamber; we render as-is". That premise was false — the field is a true UTC
 * instant — so every hearing time in the product read 4 hours late (5 in winter).
 *
 * The ground truth below is senate.gov's own `hearings.xml` as fetched on
 * 2026-07-29, cross-checked against the UTC instants Congress.gov serves for the
 * same five meetings. These are real rows, not invented fixtures: the bug was
 * found by noticing the live HSGAC Fauci hearing displayed as 12:30 PM while it
 * had actually gavelled in at 8:30 AM ET.
 */
describe('hearing-time: Eastern derivation', () => {
  // [Congress.gov UTC instant, senate.gov Eastern truth, committee]
  const JULY_29_2026: Array<[string, string, string]> = [
    ['2026-07-29T12:30:00Z', '8:30 AM', 'Homeland Security (Fauci testimony)'],
    ['2026-07-29T13:30:00Z', '9:30 AM', 'Energy and Natural Resources'],
    ['2026-07-29T18:00:00Z', '2:00 PM', 'HELP / Employment and Workplace Safety'],
    ['2026-07-29T18:30:00Z', '2:30 PM', 'Indian Affairs'],
    ['2026-07-29T19:45:00Z', '3:45 PM', 'Aging (Special)'],
  ];

  describe('formatTime renders Eastern, not UTC', () => {
    it.each(JULY_29_2026)('%s -> %s (%s)', (iso, expected) => {
      expect(formatTime(iso)).toBe(expected);
    });

    it('is exactly the 4-hour EDT correction the bug produced', () => {
      // Reproduce the OLD implementation and assert the delta, so this test
      // documents the defect rather than merely asserting the new behaviour.
      const legacyFormatTime = (iso: string): string => {
        const d = new Date(iso);
        let h = d.getUTCHours();
        const m = d.getUTCMinutes();
        const ampm = h >= 12 ? 'PM' : 'AM';
        h = h % 12;
        if (h === 0) h = 12;
        return `${h}:${String(m).padStart(2, '0')} ${ampm}`;
      };
      expect(legacyFormatTime('2026-07-29T12:30:00Z')).toBe('12:30 PM'); // what shipped
      expect(formatTime('2026-07-29T12:30:00Z')).toBe('8:30 AM'); // what is true
    });

    it('applies the 5-hour EST correction in winter (DST-aware, not a fixed offset)', () => {
      expect(formatTime('2026-01-14T15:00:00Z')).toBe('10:00 AM');
      // Same wall-clock hearing in summer is one UTC hour earlier.
      expect(formatTime('2026-07-14T14:00:00Z')).toBe('10:00 AM');
    });

    it('handles both DST transition days', () => {
      // 2026 US DST: begins Sun Mar 8 (02:00 EST -> 03:00 EDT), ends Sun Nov 1.
      expect(formatTime('2026-03-08T15:00:00Z')).toBe('11:00 AM'); // already EDT
      expect(formatTime('2026-11-01T15:00:00Z')).toBe('10:00 AM'); // back to EST
    });

    it('returns null rather than a fabricated time for unusable input', () => {
      expect(formatTime(null)).toBeNull();
      expect(formatTime(undefined)).toBeNull();
      expect(formatTime('')).toBeNull();
      expect(formatTime('not-a-date')).toBeNull();
    });

    it('formats noon and midnight-adjacent hours without a 0 or 24 leaking out', () => {
      expect(formatTime('2026-07-29T16:00:00Z')).toBe('12:00 PM'); // noon ET
      expect(formatTime('2026-07-29T04:05:00Z')).toBe('12:05 AM'); // 00:05 ET
    });
  });

  describe('the date-only sentinel is detected on the UTC instant, before conversion', () => {
    it('treats a bare UTC midnight as "date known, time unknown"', () => {
      expect(isDateOnlySentinel(new Date('2026-07-29T00:00:00Z'))).toBe(true);
      expect(formatTime('2026-07-29T00:00:00Z')).toBeNull();
    });

    it('files a date-only record under its UTC date, NOT the Eastern shift', () => {
      // Converting first would read 00:00Z as 8:00 PM Jul 28 and file it a day early.
      expect(hearingCalendarDate(new Date('2026-07-29T00:00:00Z')).toISOString()).toBe(
        '2026-07-29T00:00:00.000Z',
      );
    });

    it('does not mistake a real early-morning instant for the sentinel', () => {
      expect(isDateOnlySentinel(new Date('2026-07-29T00:30:00Z'))).toBe(false);
      expect(formatTime('2026-07-29T00:30:00Z')).toBe('8:30 PM'); // Jul 28 ET
    });
  });

  describe('hearingCalendarDate files rows under the Eastern day', () => {
    it('keeps a normal daytime hearing on its own day', () => {
      expect(hearingCalendarDate(new Date('2026-07-29T12:30:00Z')).toISOString()).toBe(
        '2026-07-29T00:00:00.000Z',
      );
    });

    it('pulls a late-evening hearing BACK to the Eastern day it belongs to', () => {
      // 2026-07-29 23:00 ET is 2026-07-30 03:00Z. Using the UTC date filed this
      // under Jul 30 — a day later than the hearing actually happened.
      const instant = new Date('2026-07-30T03:00:00Z');
      expect(etParts(instant)).toMatchObject({ year: 2026, month: 7, day: 29, hour: 23 });
      expect(hearingCalendarDate(instant).toISOString()).toBe('2026-07-29T00:00:00.000Z');
      expect(formatTime(instant.toISOString())).toBe('11:00 PM');
    });

    it('etCalendarDay has no sentinel special-case, so it is safe for "now"', () => {
      // hearingCalendarDate would return the PREVIOUS Eastern day for this input.
      const utcMidnight = new Date('2026-07-30T00:00:00Z');
      expect(etCalendarDay(utcMidnight).toISOString()).toBe('2026-07-29T00:00:00.000Z');
      expect(hearingCalendarDate(utcMidnight).toISOString()).toBe('2026-07-30T00:00:00.000Z');
    });
  });

  /**
   * KNOWN, UNAVOIDABLE AMBIGUITY — documented deliberately rather than hidden.
   *
   * A genuine 8:00 PM EDT hearing is `T00:00:00Z` the next day, which is
   * byte-identical to Congress.gov's date-only sentinel. Nothing in the payload
   * distinguishes them. We resolve in favour of the sentinel, because a hearing
   * announced without a time is far more common than one gavelling in at exactly
   * 8:00 PM, and because the failure mode is then "no time shown" rather than "a
   * confidently wrong time shown".
   *
   * Consequence: a real 8:00 PM ET (or 7:00 PM EST) hearing loses its time and
   * files under the following day. If that ever matters, the fix is upstream —
   * cross-check senate.gov's hearings.xml, which publishes zone-less Eastern
   * wall-clock and so has no such collision.
   */
  it('resolves the 8 PM EDT / sentinel collision toward the sentinel, and says so', () => {
    const eightPmEdt = new Date('2026-07-30T00:00:00Z');
    expect(etParts(eightPmEdt)).toMatchObject({ month: 7, day: 29, hour: 20, minute: 0 });
    expect(isDateOnlySentinel(eightPmEdt)).toBe(true);
    expect(formatTime(eightPmEdt.toISOString())).toBeNull();
    expect(hearingCalendarDate(eightPmEdt).toISOString()).toBe('2026-07-30T00:00:00.000Z');
  });

  describe('parseEtClock', () => {
    it('parses the docs.house.gov formats', () => {
      expect(parseEtClock('10:00 AM')).toEqual({ hour: 10, minute: 0 });
      expect(parseEtClock('2:15 PM')).toEqual({ hour: 14, minute: 15 });
      expect(parseEtClock('12:00 PM')).toEqual({ hour: 12, minute: 0 }); // noon
      expect(parseEtClock('12:30 AM')).toEqual({ hour: 0, minute: 30 }); // after midnight
      expect(parseEtClock('  9:05 a.m.  ')).toEqual({ hour: 9, minute: 5 });
    });

    it('rejects anything it cannot parse instead of guessing', () => {
      expect(parseEtClock(null)).toBeNull();
      expect(parseEtClock('')).toBeNull();
      expect(parseEtClock('TBD')).toBeNull();
      expect(parseEtClock('10:00')).toBeNull(); // no meridiem -> ambiguous
      expect(parseEtClock('25:00 AM')).toBeNull();
      expect(parseEtClock('10:75 AM')).toBeNull();
      expect(parseEtClock('0:30 AM')).toBeNull(); // 12-hour clocks start at 1
    });
  });

  describe('etWallClockToInstant / houseStartsAt convert Eastern FORWARD', () => {
    it('round-trips against etParts across both offsets', () => {
      for (const [y, mo, d, h, mi] of [
        [2026, 7, 29, 10, 0],
        [2026, 1, 14, 14, 30],
        [2026, 12, 31, 23, 59],
      ] as Array<[number, number, number, number, number]>) {
        const inst = etWallClockToInstant(y, mo, d, h, mi);
        expect(etParts(inst)).toEqual({ year: y, month: mo, day: d, hour: h, minute: mi });
      }
    });

    it('maps a House 10:00 AM to the right instant in summer and winter', () => {
      expect(houseStartsAt(new Date('2026-07-29T00:00:00Z'), '10:00 AM')?.toISOString()).toBe(
        '2026-07-29T14:00:00.000Z', // EDT, -4
      );
      expect(houseStartsAt(new Date('2026-01-14T00:00:00Z'), '10:00 AM')?.toISOString()).toBe(
        '2026-01-14T15:00:00.000Z', // EST, -5
      );
    });

    it('returns null when the page listed no parseable time', () => {
      expect(houseStartsAt(new Date('2026-07-29T00:00:00Z'), null)).toBeNull();
      expect(houseStartsAt(new Date('2026-07-29T00:00:00Z'), 'TBD')).toBeNull();
    });

    it('agrees with the Congress.gov path for the same wall-clock hearing', () => {
      // Both sources describe the same 10:00 AM ET meeting; the two derivations
      // must land on the same instant, or the shared `committee_hearing` row
      // would flip depending on which writer touched it last.
      const fromHouse = houseStartsAt(new Date('2026-07-29T00:00:00Z'), '10:00 AM');
      const fromCongress = new Date('2026-07-29T14:00:00Z');
      expect(fromHouse?.getTime()).toBe(fromCongress.getTime());
      expect(formatTime(fromCongress.toISOString())).toBe('10:00 AM');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Zone-aware layer (2026-09-04 field-hearing correction, QA brief §2–§4).
// ─────────────────────────────────────────────────────────────────────────────
import {
  normalizeSourceZone,
  resolveSourceTime,
  zoneWallClockToInstant,
  isValidIanaZone,
} from '../../src/hearing-discovery/hearing-time.js';

describe('hearing-time: zone-aware layer (field hearings)', () => {
  it('resolveSourceTime corrects the Santa Clarita field hearing to 20:00Z (1:00 PM PT)', () => {
    // What the central calendar publishes: "1:00 PM" encoded as an Eastern
    // instant (17:00Z). What the official announcement says: 1:00 PM PT.
    const resolved = resolveSourceTime({
      instant: new Date('2026-09-04T17:00:00.000Z'),
      calendarDay: new Date('2026-09-04T00:00:00.000Z'),
      displayClock: '1:00 PM',
      zoneToken: 'PT',
    });
    expect(resolved.authority).toBe('explicit_local');
    expect(resolved.startsAt!.toISOString()).toBe('2026-09-04T20:00:00.000Z');
    expect(resolved.displayTime).toBe('1:00 PM');
    expect(resolved.timeZone).toBe('America/Los_Angeles');
  });

  it('REGRESSION: the mis-zoned 17:00Z encoding never survives an explicit PT observation', () => {
    const resolved = resolveSourceTime({
      instant: new Date('2026-09-04T17:00:00.000Z'),
      calendarDay: new Date('2026-09-04T00:00:00.000Z'),
      displayClock: '1:00 PM',
      zoneToken: 'America/Los_Angeles',
    });
    expect(resolved.startsAt!.toISOString()).not.toBe('2026-09-04T17:00:00.000Z');
    expect(resolved.startsAt!.toISOString()).toBe('2026-09-04T20:00:00.000Z');
  });

  it('keeps normal Washington hearings on the Eastern instant verbatim (no zone statement)', () => {
    const resolved = resolveSourceTime({
      instant: new Date('2026-09-03T13:00:00.000Z'),
      calendarDay: new Date('2026-09-03T00:00:00.000Z'),
      displayClock: '9:00 AM',
      zoneToken: null,
    });
    expect(resolved.authority).toBe('instant');
    expect(resolved.startsAt!.toISOString()).toBe('2026-09-03T13:00:00.000Z'); // 9:00 AM ET
    expect(resolved.timeZone).toBe('America/New_York');
  });

  it('an explicit ET statement re-derives to the SAME instant (no drift for Washington hearings)', () => {
    const resolved = resolveSourceTime({
      instant: new Date('2026-09-03T13:00:00.000Z'),
      calendarDay: new Date('2026-09-03T00:00:00.000Z'),
      displayClock: '9:00 AM',
      zoneToken: 'ET',
    });
    // Explicit ET derivation lands on exactly the published instant.
    expect(resolved.authority).toBe('explicit_local');
    expect(resolved.startsAt!.toISOString()).toBe('2026-09-03T13:00:00.000Z');
    expect(resolved.timeZone).toBe('America/New_York');
  });

  it('date-only sentinel stays date-only in any zone (no fabricated midnight)', () => {
    const resolved = resolveSourceTime({
      instant: new Date('2026-09-04T00:00:00.000Z'),
      calendarDay: new Date('2026-09-04T00:00:00.000Z'),
      displayClock: null,
      zoneToken: 'PT',
    });
    expect(resolved.authority).toBe('date_only');
    expect(resolved.startsAt).toBeNull();
    expect(resolved.calendarDate.toISOString().slice(0, 10)).toBe('2026-09-04');
  });

  it('derives an instant from clock + zone even with no instant input (enrichment path)', () => {
    const resolved = resolveSourceTime({
      instant: null,
      calendarDay: new Date('2026-09-04T00:00:00.000Z'),
      displayClock: '1:00 PM',
      zoneToken: 'PDT',
    });
    expect(resolved.authority).toBe('explicit_local');
    expect(resolved.startsAt!.toISOString()).toBe('2026-09-04T20:00:00.000Z');
  });

  it('Central and Mountain zones resolve for field hearings in those zones', () => {
    expect(
      resolveSourceTime({
        instant: null,
        calendarDay: new Date('2026-09-04T00:00:00.000Z'),
        displayClock: '2:00 PM',
        zoneToken: 'CT',
      }).startsAt!.toISOString(),
    ).toBe('2026-09-04T19:00:00.000Z'); // 2:00 PM CT = 19:00Z (CDT)
    expect(
      resolveSourceTime({
        instant: null,
        calendarDay: new Date('2026-09-04T00:00:00.000Z'),
        displayClock: '1:00 PM',
        zoneToken: 'MT',
      }).startsAt!.toISOString(),
    ).toBe('2026-09-04T19:00:00.000Z'); // 1:00 PM MT = 19:00Z (MDT)
  });

  it('DST: a Pacific wall clock resolves correctly across the DST boundary', () => {
    // PDT (-7) in September vs PST (-8) in December.
    expect(zoneWallClockToInstant(2026, 9, 4, 13, 0, 'America/Los_Angeles').toISOString()).toBe(
      '2026-09-04T20:00:00.000Z',
    );
    expect(zoneWallClockToInstant(2026, 12, 4, 13, 0, 'America/Los_Angeles').toISOString()).toBe(
      '2026-12-04T21:00:00.000Z',
    );
  });

  it('never infers a zone from a location string — only explicit zone evidence', () => {
    // "Santa Clarita, California" must NOT flip the zone on its own.
    const resolved = resolveSourceTime({
      instant: new Date('2026-09-04T17:00:00.000Z'),
      calendarDay: new Date('2026-09-04T00:00:00.000Z'),
      displayClock: '1:00 PM',
      zoneToken: null,
      zoneText: 'College of the Canyons, Santa Clarita, California',
    });
    expect(resolved.authority).toBe('instant'); // no explicit zone → instant used as-is
    expect(resolved.timeZone).toBe('America/New_York');
  });

  it('normalizeSourceZone maps printed tokens, abbreviations and words; unknown → ET', () => {
    expect(normalizeSourceZone('America/Los_Angeles')).toBe('America/Los_Angeles');
    expect(normalizeSourceZone('PT')).toBe('America/Los_Angeles');
    expect(normalizeSourceZone('PDT')).toBe('America/Los_Angeles');
    expect(normalizeSourceZone('ET')).toBe('America/New_York');
    expect(normalizeSourceZone('CT')).toBe('America/Chicago');
    expect(normalizeSourceZone('MT')).toBe('America/Denver');
    expect(normalizeSourceZone(null, '1:00 PM Pacific Time')).toBe('America/Los_Angeles');
    expect(normalizeSourceZone(null, 'hearing in Eastern Time')).toBe('America/New_York');
    expect(normalizeSourceZone('Mars/Olympus_Mons')).toBe('America/New_York');
    expect(normalizeSourceZone(null)).toBe('America/New_York');
  });

  it('isValidIanaZone accepts real zones and rejects garbage', () => {
    expect(isValidIanaZone('America/New_York')).toBe(true);
    expect(isValidIanaZone('Pacific/Honolulu')).toBe(true);
    expect(isValidIanaZone('Not/AZone')).toBe(false);
    expect(isValidIanaZone('')).toBe(false);
    expect(isValidIanaZone(null)).toBe(false);
  });
});
