import { describe, expect, test } from '@jest/globals';
import { normalizeDistrictForCensus as normalizeDistrict } from '../common/district-code.util.js';

/**
 * Unit test for the district-code normalizer used by getDistrictNexusSpend to join
 * USAspending place-of-performance congressional_code -> CensusDistrict.district.
 * Pinned because a mismatch here silently drops the census demographics join
 * (district spend shows, demographics go null) — the kind of bug that's invisible
 * until someone checks the data.
 *
 * This used to re-declare a COPY of the implementation, which meant the spec
 * could pass while the real normalizer drifted away from it. It now imports the
 * shared implementation (§7-A1), so these assertions actually constrain
 * production behaviour.
 */

describe('normalizeDistrict (USAspending -> CensusDistrict)', () => {
  test('strips leading zeros to match census plain numbers', () => {
    expect(normalizeDistrict('02')).toBe('2');
    expect(normalizeDistrict('11')).toBe('11');
    expect(normalizeDistrict('01')).toBe('1');
  });

  test('maps at-large / non-district sentinels to AL', () => {
    expect(normalizeDistrict('00')).toBe('AL'); // at-large
    expect(normalizeDistrict('98')).toBe('AL'); // non-voting delegate
    expect(normalizeDistrict('90')).toBe('AL'); // multiple/undefined
    expect(normalizeDistrict('ZZ')).toBe('AL');
    expect(normalizeDistrict('AL')).toBe('AL');
  });

  test('null / empty / garbage -> AL (never throws)', () => {
    expect(normalizeDistrict(null)).toBe('AL');
    expect(normalizeDistrict('')).toBe('AL');
    expect(normalizeDistrict('   ')).toBe('AL');
    expect(normalizeDistrict('abc')).toBe('AL');
  });

  test('handles whitespace + case', () => {
    expect(normalizeDistrict(' 07 ')).toBe('7');
    expect(normalizeDistrict('al')).toBe('AL');
  });
});
