import { describe, expect, test } from 'vitest';
import { bandOf, directoryDistrictPath, formatMoney, splitDistrictKey } from './district-nexus-format.js';

/**
 * `directoryDistrictPath` is the single home for the
 * `/directory/districts/:state/:districtNo` convention, used from two chunks
 * (the lazy map drawer and the eager client-profile widget).
 *
 * The padding is load-bearing, not defensive styling: `districtCodeForHouseMatch`
 * (apps/api/src/common/district-code.util.ts) returns the source's code VERBATIM,
 * so a rail that stored '4' yields the key 'TX-4'. An unpadded link produces
 * /directory/districts/TX/4, which that route cannot resolve.
 */
describe('directoryDistrictPath', () => {
  test('passes through an already-padded two-digit district', () => {
    expect(directoryDistrictPath('TX-23')).toBe('/directory/districts/TX/23');
  });

  test('zero-pads a single-digit code so the route resolves', () => {
    // The regression this exists for: 'TX-4' must not link to /districts/TX/4.
    expect(directoryDistrictPath('TX-4')).toBe('/directory/districts/TX/04');
  });

  test('keeps the at-large "00" form intact', () => {
    expect(directoryDistrictPath('WY-00')).toBe('/directory/districts/WY/00');
  });

  test('does not corrupt a key it cannot parse', () => {
    // No district segment at all — pads to '00' rather than emitting a path
    // with a trailing empty segment.
    expect(directoryDistrictPath('TX')).toBe('/directory/districts/TX/00');
  });

  test('URL-encodes both segments', () => {
    expect(directoryDistrictPath('T X-2 3')).toBe('/directory/districts/T%20X/2%203');
  });
});

describe('splitDistrictKey', () => {
  test('splits state and district number', () => {
    expect(splitDistrictKey('TX-23')).toEqual({ state: 'TX', districtNo: '23' });
  });

  test('returns empty strings rather than undefined for an unparseable key', () => {
    expect(splitDistrictKey('')).toEqual({ state: '', districtNo: '' });
  });
});

describe('formatMoney — null is never zero', () => {
  test('renders null as an em dash, NEVER $0', () => {
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney(null)).not.toBe('$0');
  });

  test('renders a real zero as $0, which is a different fact from null', () => {
    expect(formatMoney(0)).toBe('$0');
  });

  test('scales to K/M/B', () => {
    expect(formatMoney(2_500)).toBe('$3K');
    expect(formatMoney(4_800_000)).toBe('$4.8M');
    expect(formatMoney(2_400_000_000)).toBe('$2.40B');
  });
});

describe('bandOf — unscored is not the lowest band', () => {
  test('returns null for a null score so callers render "Unscored"', () => {
    // Collapsing this into 'minimal' would assert a weak-but-real nexus where
    // the truth is "too little evidence to score at all".
    expect(bandOf(null)).toBeNull();
  });

  test('maps scores to their bands', () => {
    expect(bandOf(75)?.id).toBe('strong');
    expect(bandOf(40)?.id).toBe('moderate');
    expect(bandOf(20)?.id).toBe('limited');
    expect(bandOf(0)?.id).toBe('minimal');
  });
});
