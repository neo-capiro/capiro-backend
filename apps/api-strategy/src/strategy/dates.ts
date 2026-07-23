import { BadRequestException } from '@nestjs/common';

/**
 * Parse a validated YYYY-MM-DD string into a UTC-midnight Date for a @db.Date
 * column. The DTO regex guarantees the shape; this additionally rejects
 * calendar-impossible values. NOTE: `new Date('2027-02-30')` does NOT return
 * NaN — V8 ROLLS it over to 2027-03-02 — so a NaN check alone would silently
 * persist a different day. We reject by round-tripping the UTC date part back
 * to the input: any rollover (Feb 30, Feb 29 in a common year, Apr 31, …)
 * fails the equality and 400s. UTC-midnight is intentional (@db.Date stores
 * only the calendar day, TZ-independent).
 */
export function parseDbDate(value: string, field = 'date'): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new BadRequestException(`${field} is not a valid calendar date`);
  }
  return d;
}
