import { describe, expect, test } from '@jest/globals';
import {
  districtCodeForHouseMatch,
  districtMatchesHouse,
  matchFacilityDistrictCode,
  normalizeDistrictCode,
  normalizeDistrictForCensus,
  normalizeDistrictForPeopleMatch,
  toFacilityDistrictCode,
} from './district-code.util.js';

/**
 * §7-A1 consolidation guard. Six helpers that used to live in four files now
 * share a module, so the risk shifts from "copies drift apart" to "someone
 * assumes they're interchangeable and collapses them". These tests pin the
 * DIFFERENCES as hard as the behaviours.
 */

describe('the two normalizers that were both once called normalizeDistrict', () => {
  test('disagree on named districts — and both are right for their own join', () => {
    // People matching keeps a named district comparable to itself...
    expect(normalizeDistrictForPeopleMatch('At-Large')).toBe('atlarge');
    // ...while the census join has a dedicated sentinel for at-large.
    expect(normalizeDistrictForCensus('At-Large')).toBe('AL');
    // And the facility-comparison normalizer has no concept of either: a
    // non-numeric district isn't a facility code at all.
    expect(normalizeDistrictCode('At-Large')).toBeNull();
  });

  test('disagree on absent input', () => {
    expect(normalizeDistrictForPeopleMatch(null)).toBeNull();
    expect(normalizeDistrictCode(null)).toBeNull();
    // Census normalization is total — it always returns a joinable bucket.
    expect(normalizeDistrictForCensus(null)).toBe('AL');
  });

  test('agree on the ordinary case: a zero-padded number', () => {
    expect(normalizeDistrictForPeopleMatch('034')).toBe('34');
    expect(normalizeDistrictCode('034')).toBe('34');
    expect(normalizeDistrictForCensus('034')).toBe('34');
  });
});

describe('normalizeDistrictCode', () => {
  test('strips cosmetic prefixes and leading zeros', () => {
    expect(normalizeDistrictCode('HD-3')).toBe('3');
    expect(normalizeDistrictCode(' 3 ')).toBe('3');
    expect(normalizeDistrictCode('003')).toBe('3');
  });

  test('empty-ish input yields null rather than a bogus code', () => {
    expect(normalizeDistrictCode('')).toBeNull();
    expect(normalizeDistrictCode('   ')).toBeNull();
    expect(normalizeDistrictCode(undefined)).toBeNull();
  });
});

describe('districtCodeForHouseMatch (raw USAspending code -> facility style)', () => {
  test('refuses to guess a seat for unresolvable sentinels', () => {
    // The whole point of keeping this separate from the census normalizer:
    // these must NOT resolve to the at-large member.
    expect(districtCodeForHouseMatch('98')).toBeNull(); // non-voting delegate
    expect(districtCodeForHouseMatch('90')).toBeNull(); // multiple districts
    expect(districtCodeForHouseMatch('ZZ')).toBeNull(); // undefined
    expect(districtCodeForHouseMatch(null)).toBeNull();
  });

  test('maps true at-large forms to the facility sentinel', () => {
    expect(districtCodeForHouseMatch('00')).toBe('00');
    expect(districtCodeForHouseMatch('AL')).toBe('00');
    expect(districtCodeForHouseMatch(' al ')).toBe('00');
  });

  test('passes numbered districts through zero-padding intact', () => {
    // Facility style is zero-padded, so '02' must stay '02' here.
    expect(districtCodeForHouseMatch('02')).toBe('02');
    expect(districtCodeForHouseMatch('11')).toBe('11');
  });
});

describe('districtMatchesHouse', () => {
  test("'00' matches a NULL member district (at-large stored as NULL, not 0)", () => {
    expect(districtMatchesHouse('00', null)).toBe(true);
    expect(districtMatchesHouse('00', 0)).toBe(true);
    expect(districtMatchesHouse('00', 1)).toBe(false);
  });

  test('numbered districts compare numerically despite zero padding', () => {
    expect(districtMatchesHouse('02', 2)).toBe(true);
    expect(districtMatchesHouse('11', 11)).toBe(true);
    expect(districtMatchesHouse('02', 3)).toBe(false);
  });

  test('a missing facility code never matches anything', () => {
    expect(districtMatchesHouse(null, 1)).toBe(false);
    expect(districtMatchesHouse(null, null)).toBe(false);
  });
});

describe('matchFacilityDistrictCode', () => {
  test("'00' matches the sole House row, without a hardcoded at-large state list", () => {
    const rows = [{ districtNo: '1' }];
    expect(matchFacilityDistrictCode(rows, '00')).toBe(rows[0]);
  });

  test("'00' does NOT match when several House rows exist", () => {
    expect(matchFacilityDistrictCode([{ districtNo: '1' }, { districtNo: '2' }], '00')).toBeNull();
  });

  test("'00' rejects a Senate-shaped null-districtNo row (defense in depth)", () => {
    expect(matchFacilityDistrictCode([{ districtNo: null }], '00')).toBeNull();
  });

  test('numbered codes match LegiStorm bare numbers', () => {
    const rows = [{ districtNo: '23' }, { districtNo: '7' }];
    expect(matchFacilityDistrictCode(rows, '23')).toBe(rows[0]);
    expect(matchFacilityDistrictCode(rows, '07')).toBe(rows[1]);
    expect(matchFacilityDistrictCode(rows, '99')).toBeNull();
  });
});

describe('toFacilityDistrictCode (WS-D artifact feature keys)', () => {
  test('derives at-large from apportionment, NOT from the reported value', () => {
    // LegiStorm reports a sole seat as "1"; keying it '01' would never join
    // against a geocoded at-large facility, which carries '00'.
    expect(toFacilityDistrictCode('WY', '1')).toBe('00');
    expect(toFacilityDistrictCode('VT', '1')).toBe('00');
    // Non-voting delegations are modeled as a single at-large seat too.
    expect(toFacilityDistrictCode('DC', '1')).toBe('00');
    expect(toFacilityDistrictCode('PR', '1')).toBe('00');
  });

  test('zero-pads numbered districts in multi-seat states', () => {
    expect(toFacilityDistrictCode('TX', '7')).toBe('07');
    expect(toFacilityDistrictCode('TX', '23')).toBe('23');
    expect(toFacilityDistrictCode('CA', 52)).toBe('52');
  });

  test('accepts the same value in string or number form', () => {
    expect(toFacilityDistrictCode('TX', 7)).toBe(toFacilityDistrictCode('TX', '7'));
  });

  test('returns null rather than guessing when the code is not expressible', () => {
    expect(toFacilityDistrictCode('TX', null)).toBeNull(); // Senate-shaped row
    expect(toFacilityDistrictCode('TX', '')).toBeNull();
    expect(toFacilityDistrictCode(null, '7')).toBeNull();
    expect(toFacilityDistrictCode('ZZ', '7')).toBeNull(); // unknown jurisdiction
    expect(toFacilityDistrictCode('TX', 'abc')).toBeNull();
    expect(toFacilityDistrictCode('TX', '0')).toBeNull(); // '0' is not '00'
    expect(toFacilityDistrictCode('TX', '100')).toBeNull(); // cannot be 2-char
  });

  test('is case- and whitespace-insensitive on the state', () => {
    expect(toFacilityDistrictCode(' tx ', '7')).toBe('07');
  });
});
