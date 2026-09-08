/**
 * Regression guard for the 2026-09-04 field-hearing sync revert class
 * (cm-119-119533): the legacy daily sync must never overwrite a canonical row
 * that the pipeline corrected to an explicit local zone. The official
 * announcement's "1:00 PM PT" outranks the central calendar's mis-zoned
 * instant encoding — permanently, not just on the day of the fix.
 */
import { isVerifiedLocalZoneRow, stripProtectedTimeFields } from './sync-hearings.js';

const FULL_ROW = {
  title: 'Industrial Base and Workforce Development for Skilled Trades',
  chamber: 'House',
  committeeName: 'Transportation and Infrastructure',
  committeeCode: 'hspw00',
  date: new Date('2026-09-04T00:00:00.000Z'),
  startsAt: new Date('2026-09-04T17:00:00.000Z'), // the mis-zoned re-derivation
  time: '1:00 PM',
  location: 'College of the Canyons, Santa Clarita, CA',
  type: 'hearing',
  witnesses: [],
  url: 'https://www.congress.gov/event/119th-Congress/house-event/119533',
};

describe('sync-hearings zone-protection guard (legacy sync cannot revert a corrected field hearing)', () => {
  it('classifies an America/Los_Angeles row as verified local zone', () => {
    expect(isVerifiedLocalZoneRow('America/Los_Angeles')).toBe(true);
    expect(isVerifiedLocalZoneRow('America/Chicago')).toBe(true);
    expect(isVerifiedLocalZoneRow('America/Denver')).toBe(true);
    expect(isVerifiedLocalZoneRow('Pacific/Honolulu')).toBe(true);
  });

  it('does NOT protect plain Eastern rows — the legacy sync keeps owning them', () => {
    expect(isVerifiedLocalZoneRow('America/New_York')).toBe(false);
    expect(isVerifiedLocalZoneRow(null)).toBe(false);
    expect(isVerifiedLocalZoneRow(undefined)).toBe(false);
    expect(isVerifiedLocalZoneRow('')).toBe(false);
    expect(isVerifiedLocalZoneRow('   ')).toBe(false);
  });

  it('REGRESSION: a later Congress.gov sync cannot turn the Santa Clarita hearing back into 17:00Z', () => {
    // Tomorrow's daily run re-derives startsAt=17:00Z from the central calendar
    // and calls upsert with the full row. The guard must strip every time field
    // so the corrected 20:00Z value survives the upsert untouched.
    const stripped = stripProtectedTimeFields(FULL_ROW, 'America/Los_Angeles');
    expect(Object.keys(stripped)).not.toContain('date');
    expect(Object.keys(stripped)).not.toContain('startsAt');
    expect(Object.keys(stripped)).not.toContain('time');
    expect(stripped.startsAt).toBeUndefined();
    // Display fields still refresh — only the WHEN is protected.
    expect(stripped.title).toBe(FULL_ROW.title);
    expect(stripped.location).toBe(FULL_ROW.location);
    expect(stripped.url).toBe(FULL_ROW.url);
  });

  it('leaves ordinary Eastern rows fully writable', () => {
    const row = { ...FULL_ROW };
    expect(stripProtectedTimeFields(row, 'America/New_York')).toBe(row);
    expect(stripProtectedTimeFields(row, null)).toBe(row);
  });

  /**
   * REGRESSION (production incident 2026-09-07): `prisma.committeeHearing
   * .upsert()`'s `create` branch is only ever reachable when no row exists
   * yet — but Prisma's client validates the `create` shape's required fields
   * (`date` is NOT NULL, no default) regardless of which branch will actually
   * run at the DB level. Both call sites in sync-hearings.ts once built
   * `create` from the SAME `stripProtectedTimeFields()` output used for
   * `update`, so the first protected row encountered each day threw
   * "Argument `date` is missing" and aborted the entire script — every
   * hearing behind it in that run silently never synced. The fix: `create`
   * must always spread the unstripped fields, never the stripped ones.
   */
  it("a create payload built from the STRIPPED row would be missing `date` — this is the exact shape that crashed Prisma", () => {
    const stripped = stripProtectedTimeFields(FULL_ROW, 'America/Los_Angeles');
    const brokenCreatePayload = { id: 'cm-119-119533', ...stripped };
    expect('date' in brokenCreatePayload).toBe(false);
  });

  it('a create payload built from the UNSTRIPPED fields always retains `date`, protected or not', () => {
    const fixedCreatePayload = { id: 'cm-119-119533', ...FULL_ROW };
    expect(fixedCreatePayload.date).toEqual(FULL_ROW.date);
    // Same object, regardless of what the row's existing timezone is — the
    // create branch never consults `existingTimezone` at all, by construction.
  });
});
