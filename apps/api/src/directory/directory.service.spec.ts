import { describe, expect, test } from '@jest/globals';
import { matchFacilityDistrictCode } from './directory.service.js';

/**
 * WS-D, LegiStorm gaps/enrichment plan — the at-large bridge that resolves a
 * client_facilities-style URL code ('00' for at-large, zero-padded 2-digit
 * otherwise) back to LegiStorm's own raw districtNo storage. Pinned because
 * LegiStorm reports districtNo="1" (never a "0"/null sentinel) even for a
 * jurisdiction's sole House seat — verified live 2026-07-24 via DC's
 * non-voting delegate — so a naive direct-equality match against '00' would
 * silently return nothing for every genuinely at-large state.
 */
describe('matchFacilityDistrictCode', () => {
  const row = (districtNo: string | null) => ({ districtNo });

  test('"00" matches the sole House row for a state, regardless of its raw districtNo value', () => {
    const houseRows = [row('1')]; // Wyoming-style: LegiStorm's own numbering, not "0"
    expect(matchFacilityDistrictCode(houseRows, '00')).toBe(houseRows[0]);
  });

  test('"00" matches NOTHING when the state genuinely has more than one House row', () => {
    const houseRows = [row('4'), row('24'), row('32')]; // e.g. Texas
    expect(matchFacilityDistrictCode(houseRows, '00')).toBeNull();
  });

  test('"00" matches nothing when there are zero House rows for this state+status', () => {
    expect(matchFacilityDistrictCode([], '00')).toBeNull();
  });

  test('a zero-padded single-digit code strips its leading zero to match the bare-number storage', () => {
    const houseRows = [row('2'), row('7')];
    expect(matchFacilityDistrictCode(houseRows, '02')).toBe(houseRows[0]);
  });

  test('a two-digit code matches directly, no padding to strip', () => {
    const houseRows = [row('7'), row('25')];
    expect(matchFacilityDistrictCode(houseRows, '25')).toBe(houseRows[1]);
  });

  test('returns null when the requested district genuinely does not exist among the rows', () => {
    const houseRows = [row('4'), row('24')];
    expect(matchFacilityDistrictCode(houseRows, '99')).toBeNull();
  });

  test('never matches a Senate-shaped row (districtNo=null) against "00", even if it is the only row', () => {
    // Defense in depth: resolveLegislativeDistrict always pre-filters to
    // chamber='house' before calling this function, so a null-districtNo row
    // should never actually reach it in practice — but the function must not
    // depend SOLELY on that upstream filter. A lone null-districtNo row must
    // not be treated as a valid at-large match.
    const houseRows = [row(null)];
    expect(matchFacilityDistrictCode(houseRows, '00')).toBeNull();
  });
});
