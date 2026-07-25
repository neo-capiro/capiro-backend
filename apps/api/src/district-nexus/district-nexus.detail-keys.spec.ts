/**
 * WS-E2 keying rules.
 *
 * The district detail endpoint has to translate one incoming `:state/:district`
 * pair into THREE different district conventions, and each mistranslation fails
 * silently rather than loudly:
 *
 *   - FACILITY style ('00', '05', '23') for the districtKey and the award rails
 *   - CENSUS style ('AL', '5', '23') for the demographics join
 *   - the sentinel set ('90', '98', 'ZZ') which is not a district at all
 *
 * These pin the translations the service performs inline, so a regression shows
 * up here rather than as an empty drawer nobody can explain.
 */
import { describe, expect, test } from '@jest/globals';
import {
  districtCodeForHouseMatch,
  normalizeDistrictForCensus,
} from '../common/district-code.util.js';

describe('WS-E2 rejects what is not a district', () => {
  test.each([
    ['90', 'statewide / multi-district'],
    ['98', 'non-voting delegate'],
    ['ZZ', 'undefined'],
  ])('%s (%s) resolves to null, so the endpoint 404s', (sentinel) => {
    expect(districtCodeForHouseMatch(sentinel)).toBeNull();
  });

  test('at-large is a real district and is NOT rejected', () => {
    expect(districtCodeForHouseMatch('00')).toBe('00');
  });

  test('an ordinary district passes through zero-padded', () => {
    expect(districtCodeForHouseMatch('23')).toBe('23');
  });

  test('lowercase and whitespace are tolerated', () => {
    expect(districtCodeForHouseMatch(' zz ')).toBeNull();
    expect(districtCodeForHouseMatch(' 07 ')).toBe('07');
  });
});

describe('WS-E2 demographics join uses the census convention', () => {
  test('at-large maps to AL, not 00', () => {
    // census_district stores 'AL'. Querying district='00' matches nothing and
    // renders an at-large district as having no demographics at all.
    expect(normalizeDistrictForCensus('00')).toBe('AL');
  });

  test('a zero-padded single digit loses its padding', () => {
    // census_district stores '5', not '05'.
    expect(normalizeDistrictForCensus('05')).toBe('5');
  });

  test('a two-digit district is unchanged', () => {
    expect(normalizeDistrictForCensus('23')).toBe('23');
  });

  test('the facility and census forms genuinely differ for single digits', () => {
    // The regression this guards: using the districtKey code directly as the
    // census key. For '05' those are '05' vs '5' and the join silently misses.
    const facility = districtCodeForHouseMatch('05');
    expect(facility).toBe('05');
    expect(normalizeDistrictForCensus(facility!)).toBe('5');
    expect(normalizeDistrictForCensus(facility!)).not.toBe(facility);
  });
});
