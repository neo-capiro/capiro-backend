/**
 * ONE home for congressional/legislative district-code handling (§7-A1).
 *
 * Before this module the same problem was solved in six places, in four files,
 * with two unrelated functions both called `normalizeDistrict`. They are NOT
 * interchangeable — each targets a different join, and collapsing them into a
 * single "normalize a district" helper would silently corrupt at least one
 * rail. They live together here so the differences are visible side by side;
 * the original call sites now re-export from this module.
 *
 * The four vendor/domain conventions in play:
 *
 *  - **Facility style** — 2-char zero-padded, `'00'` = at-large
 *    (`client_facilities.district`, written by the Census geocoder as `CD<n>`).
 *  - **Census style** — bare number, `'AL'` = at-large (`census_district.district`).
 *  - **LegiStorm style** — bare number string, and *no* at-large sentinel: a
 *    jurisdiction's sole House seat is reported as `"1"`, verified live
 *    2026-07-24 against DC's non-voting delegate. At-largeness must therefore
 *    be derived from apportionment, never read off the value.
 *  - **OpenStates/LegiScan style** — free-form (`"HD-034"`, `"34"`, `"At-Large"`).
 *
 * USAspending's `congressional_code` adds sentinels on top of facility style:
 * `'00'` true at-large, `'98'` non-voting delegate, `'90'`/`'ZZ'`
 * multiple/undefined. Which of those are safe to collapse depends entirely on
 * the consumer, which is why `normalizeDistrictForCensus` and
 * `districtCodeForHouseMatch` treat them differently and both are kept.
 */

import { US_HOUSE_SEATS } from './us-congressional-districts.js';

/** At-large district in Census style (`census_district.district`). */
export const AT_LARGE_CENSUS = 'AL';

/** At-large district in facility style (`client_facilities.district`). */
export const AT_LARGE_FACILITY = '00';

/**
 * USAspending codes that identify a seat we cannot resolve to a numbered
 * House district: non-voting delegate, multiple districts, undefined.
 */
const UNRESOLVABLE_HOUSE_SENTINELS: ReadonlySet<string> = new Set(['98', '90', 'ZZ']);

/**
 * Strip cosmetic variation ("HD-3", "003", " 3 ") down to a bare digit
 * string for comparison against a facility's geocoded BASENAME-style code.
 * `state_legislator.district` is populated verbatim from OpenStates
 * (`currentRole?.district?.toString()`) whose exact per-state format is not
 * guaranteed — never assume exact string equality (PD2).
 *
 * Leading NON-digits are stripped, so a purely alphabetic district yields
 * null. Use `normalizeDistrictForPeopleMatch` instead when a named district
 * ("At-Large") must still compare equal to itself.
 */
export function normalizeDistrictCode(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const digits = raw
    .trim()
    .replace(/^\D+/, '')
    .replace(/^0+(?=\d)/, '');
  return digits || null;
}

/**
 * Normalize a district to a comparable string for LegiScan<->OpenStates people
 * matching. They disagree on formatting ("HD-034" vs "34" vs "034"), so extract
 * the first digit run and strip leading zeros; a purely non-numeric district
 * (rare named districts, "At-Large") falls back to its alphanumeric-only form
 * rather than null, so two spellings of the same named district still match.
 * Null/empty → null. Note the digit run alone is chamber-agnostic ("HD-34" and
 * "SD-34" both → "34"), which is why callers pair a district match with a
 * chamber (or name) constraint.
 */
export function normalizeDistrictForPeopleMatch(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  const digits = s.match(/\d+/);
  if (digits) return String(Number(digits[0]));
  const alnum = s.replace(/[^a-z0-9]+/g, '');
  return alnum || null;
}

/**
 * Normalize a USAspending `congressional_code` to match `CensusDistrict.district`.
 * USAspending returns zero-padded ('02', '11') or '90'/'98'/'00' for non-district
 * / at-large; CensusDistrict stores plain numbers ('2', '11') or 'AL' for at-large.
 * Returns 'AL' for at-large/unknown sentinels, else the leading-zero-stripped number.
 *
 * This deliberately collapses '00', '98', '90' and 'ZZ' into one 'AL' bucket —
 * acceptable for attaching demographics, lossy for anything that needs to know
 * WHICH seat. For that, use `districtCodeForHouseMatch` on the raw code.
 */
export function normalizeDistrictForCensus(code: string | null): string {
  if (!code) return AT_LARGE_CENSUS;
  const trimmed = code.trim().toUpperCase();
  if (
    trimmed === AT_LARGE_CENSUS ||
    trimmed === AT_LARGE_FACILITY ||
    UNRESOLVABLE_HOUSE_SENTINELS.has(trimmed)
  ) {
    return AT_LARGE_CENSUS;
  }
  const n = parseInt(trimmed, 10);
  return Number.isFinite(n) ? String(n) : AT_LARGE_CENSUS;
}

/**
 * Bridge a RAW USAspending place-of-performance congressional_code to the
 * "'00'-for-at-large" convention `districtMatchesHouse` expects — operating
 * on the raw code, NOT `normalizeDistrictForCensus`'s output, which has
 * already collapsed '00'/'98'/'90'/'ZZ' into one indistinguishable 'AL'
 * bucket. Resolving '98' or '90'/'ZZ' to the at-large House member would
 * misattribute a representative for a seat we don't actually know. Returns
 * null when the House seat can't be determined — the caller still resolves
 * Senate independently, since that only needs the state, not a district.
 */
export function districtCodeForHouseMatch(rawPopDistrict: string | null): string | null {
  if (!rawPopDistrict) return null;
  const trimmed = rawPopDistrict.trim().toUpperCase();
  if (UNRESOLVABLE_HOUSE_SENTINELS.has(trimmed)) return null;
  if (trimmed === AT_LARGE_FACILITY || trimmed === AT_LARGE_CENSUS) return AT_LARGE_FACILITY;
  return trimmed;
}

/**
 * Does a facility-style district code refer to the same seat as a
 * `CongressMember.district` number? Encodes the '00' <-> NULL/0 at-large
 * convention: at-large facilities match a member with no district number,
 * which is how at-large and non-voting seats are stored.
 */
export function districtMatchesHouse(
  facilityCd: string | null,
  memberDistrict: number | null,
): boolean {
  if (facilityCd == null) return false;
  const isAtLarge = facilityCd === AT_LARGE_FACILITY;
  if (isAtLarge) return memberDistrict == null || memberDistrict === 0;
  const n = Number(facilityCd);
  return Number.isFinite(n) && memberDistrict === n;
}

/**
 * Pick the House row matching a facility's district code.
 *
 * '00' matches ONLY when exactly one House row exists for this state+status
 * — never a hardcoded list of "the 6 at-large states" (WY, VT, DE, ND, SD,
 * AK today; apportionment can change after a future census), and never by
 * trusting LegiStorm's own districtNo value, which reports "1" (not a "0"
 * or null sentinel) even for a jurisdiction's sole House seat — verified
 * live 2026-07-24 via DC's non-voting delegate.
 */
export function matchFacilityDistrictCode<T extends { districtNo: string | null }>(
  houseRows: T[],
  facilityDistrictNo: string,
): T | null {
  if (facilityDistrictNo === AT_LARGE_FACILITY) {
    // Defense in depth: don't rely solely on the caller's chamber='house'
    // filter to keep a null-districtNo (Senate-shaped) row out of this
    // array — require the sole row to actually carry a districtNo before
    // calling it an at-large match.
    const single = houseRows.length === 1 ? houseRows[0]! : null;
    return single && single.districtNo !== null ? single : null;
  }
  const bare = facilityDistrictNo.replace(/^0+(?=\d)/, '');
  return houseRows.find((r) => r.districtNo === bare) ?? null;
}

/**
 * Render a `LegislativeDistrict.districtNo` as a facility-style code so map
 * features, facilities, awards and spend rails all key the same way (WS-D).
 *
 * At-largeness is derived from `US_HOUSE_SEATS`, NOT from the value: LegiStorm
 * reports a sole House seat as "1", so `('WY', '1')` must still key as '00' to
 * join against a geocoded at-large facility. That also means this is only
 * correct for congressional districts — do not use it for state-legislative
 * rows, whose numbering is unrelated to House apportionment.
 *
 * Returns null when the district cannot be expressed in facility style (a
 * Senate-shaped null districtNo, an unknown state, a non-numeric value, or a
 * number too large to zero-pad) — callers must skip, not guess.
 */
export function toFacilityDistrictCode(
  state: string | null | undefined,
  districtNo: string | number | null | undefined,
): string | null {
  if (!state || districtNo == null || districtNo === '') return null;
  const seats = US_HOUSE_SEATS[state.trim().toUpperCase()];
  if (seats == null) return null; // unknown state/territory — don't guess
  // Single-seat jurisdictions are at-large regardless of the reported number.
  if (seats === 1) return AT_LARGE_FACILITY;
  const n = Number(String(districtNo).trim());
  if (!Number.isInteger(n) || n < 1 || n > 99) return null;
  return String(n).padStart(2, '0');
}
