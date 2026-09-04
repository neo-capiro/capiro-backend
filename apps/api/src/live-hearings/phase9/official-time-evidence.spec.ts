/**
 * Hard-rule extraction of an explicit official local time + zone (2026-09-04).
 * The authority rule: explicit official local time + explicit official timezone
 * > ambiguous central-calendar timestamp. Geography ("California") never infers
 * a zone; a bare clock without a zone statement is not evidence.
 */
import { cleanTextSafe, extractExplicitLocalTime } from './official-time-evidence.js';
import { resolveSourceTime } from '../../hearing-discovery/hearing-time.js';

describe('official-time-evidence: hard-rule extraction', () => {
  it('accepts "1:00 PM PT" — the Santa Clarita announcement shape', () => {
    const ev = extractExplicitLocalTime(
      'Field Hearing: September 4, 2026, 1:00 PM PT, College of the Canyons, Santa Clarita, California',
    );
    expect(ev).not.toBeNull();
    expect(ev!.clock).toBe('1:00 PM');
    expect(ev!.zoneToken).toBe('PT');
    expect(ev!.snippet).toContain('Santa Clarita');
  });

  it('accepts "10:00 a.m. EDT" and "2:00 PM Pacific Time" shapes', () => {
    expect(extractExplicitLocalTime('The hearing begins at 10:00 a.m. EDT in room 2123.')!.zoneToken).toBe('EDT');
    expect(extractExplicitLocalTime('2:00 PM Pacific Time on Monday.')!.zoneToken).toBe('Pacific Time');
    // A bare "Eastern" without "Time" is NOT an explicit zone statement (too
    // ambiguous next to ordinary prose) — the rule requires the full token.
    expect(extractExplicitLocalTime('Doors open 9:30 AM Eastern.')).toBeNull();
  });

  it('REJECTS a bare clock with no zone statement (never guesses)', () => {
    expect(
      extractExplicitLocalTime('The hearing is at 1:00 PM in Santa Clarita, California.'),
    ).toBeNull();
  });

  it('REJECTS a location-only statement — "California" proves nothing', () => {
    expect(
      extractExplicitLocalTime('Field hearing at College of the Canyons, Santa Clarita, California.'),
    ).toBeNull();
  });

  it('finds the zone in the bounded context even when the token trails the clock', () => {
    const ev = extractExplicitLocalTime(
      'starts at 11:00 AM; the session will convene Pacific Time promptly',
    );
    expect(ev).not.toBeNull();
    expect(ev!.zoneToken).toBe('Pacific Time');
  });

  it('end-to-end: PT evidence + resolveSourceTime derive the correct 20:00Z instant', () => {
    const html = '<p>Field Hearing — September 4, 2026, 1:00 PM PT, College of the Canyons</p>';
    const ev = extractExplicitLocalTime(cleanTextSafe(html));
    expect(ev).not.toBeNull();
    const resolved = resolveSourceTime({
      instant: null,
      calendarDay: new Date('2026-09-04T00:00:00.000Z'),
      displayClock: ev!.clock,
      zoneToken: ev!.zoneToken,
    });
    expect(resolved.authority).toBe('explicit_local');
    expect(resolved.startsAt!.toISOString()).toBe('2026-09-04T20:00:00.000Z');
    expect(resolved.displayTime).toBe('1:00 PM');
    expect(resolved.timeZone).toBe('America/Los_Angeles');
  });
});
