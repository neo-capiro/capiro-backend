import { normalizeDistrictCode } from './district-code.util.js';

describe('normalizeDistrictCode', () => {
  it('strips leading zeros', () => expect(normalizeDistrictCode('003')).toBe('3'));
  it('strips a non-digit prefix', () => expect(normalizeDistrictCode('HD-9')).toBe('9'));
  it('trims whitespace', () => expect(normalizeDistrictCode(' 3 ')).toBe('3'));
  it('null passthrough', () => expect(normalizeDistrictCode(null)).toBeNull());
  it('empty string -> null', () => expect(normalizeDistrictCode('')).toBeNull());
  // REGRESSION (2026-07-10, W2.2): the single-digit vs zero-padded case that
  // motivated moving this util out of representation-resolver.service.ts and
  // into facility-geocode.util.ts's discrepancy check too.
  it('a bare digit and its zero-padded form normalize to the same value', () => {
    expect(normalizeDistrictCode('2')).toBe(normalizeDistrictCode('02'));
  });
});
