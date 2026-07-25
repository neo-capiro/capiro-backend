import { describe, expect, test } from '@jest/globals';
import {
  resolveDistrictNames,
  splitDistrictKey,
  statesForKeys,
  type LegislativeDistrictRow,
} from './district-nexus.district-names.js';
import { parseView, UnsupportedViewError } from './district-nexus.view.js';

const row = (partial: Partial<LegislativeDistrictRow>): LegislativeDistrictRow => ({
  state: 'TX',
  districtNo: '23',
  name: 'Texas 23rd',
  status: 'C',
  ...partial,
});

describe('splitDistrictKey', () => {
  test('splits an ordinary key', () => {
    expect(splitDistrictKey('TX-23')).toEqual({ state: 'TX', districtCode: '23' });
  });

  test('keeps the at-large code intact', () => {
    expect(splitDistrictKey('WY-00')).toEqual({ state: 'WY', districtCode: '00' });
  });

  test.each(['', 'TX', '-23', 'TX-'])('refuses the malformed key %p', (key) => {
    expect(splitDistrictKey(key)).toBeNull();
  });
});

describe('statesForKeys', () => {
  test('returns each state once', () => {
    expect(statesForKeys(['TX-23', 'TX-01', 'WY-00']).sort()).toEqual(['TX', 'WY']);
  });
});

describe('resolveDistrictNames', () => {
  test('matches a zero-padded key against a bare districtNo', () => {
    // The whole point: '01' must find districtNo '1'. A string equality join
    // returns nothing here, which is the silent-null bug this replaces.
    const out = resolveDistrictNames(['TX-01'], [row({ districtNo: '1', name: 'Texas 1st' })]);
    expect(out.get('TX-01')?.name).toBe('Texas 1st');
  });

  test('matches an ordinary two-digit district', () => {
    expect(resolveDistrictNames(['TX-23'], [row({})]).get('TX-23')?.name).toBe('Texas 23rd');
  });

  test('at-large resolves against the sole seat reported as "1"', () => {
    // LegiStorm reports Wyoming's only House seat as districtNo '1', not '0'.
    const out = resolveDistrictNames(
      ['WY-00'],
      [row({ state: 'WY', districtNo: '1', name: 'Wyoming At-Large' })],
    );
    expect(out.get('WY-00')?.name).toBe('Wyoming At-Large');
  });

  test('at-large refuses to guess when the state has several seats', () => {
    const out = resolveDistrictNames(
      ['TX-00'],
      [row({ districtNo: '1' }), row({ districtNo: '2' })],
    );
    expect(out.has('TX-00')).toBe(false);
  });

  test('a key with no matching row is absent, not mapped to a null name', () => {
    // Absent and null are different facts: absent means we found no row,
    // null means the row exists but carries no name.
    const out = resolveDistrictNames(['TX-23', 'CA-12'], [row({})]);
    expect(out.has('CA-12')).toBe(false);
    expect(out.has('TX-23')).toBe(true);
  });

  test('a row present but unnamed maps to a null name', () => {
    const out = resolveDistrictNames(['TX-23'], [row({ name: null })]);
    expect(out.get('TX-23')).toEqual({ name: null, status: 'C' });
  });

  test('state matching is case-insensitive on both sides', () => {
    const out = resolveDistrictNames(['tx-23'], [row({ state: 'tx' })]);
    expect(out.get('tx-23')?.name).toBe('Texas 23rd');
  });

  test('future rows are reported as F, and anything else as current', () => {
    expect(resolveDistrictNames(['TX-23'], [row({ status: 'F' })]).get('TX-23')?.status).toBe('F');
    expect(resolveDistrictNames(['TX-23'], [row({ status: null })]).get('TX-23')?.status).toBe('C');
  });
});

describe('parseView refuses what it cannot answer', () => {
  test('absent or empty defaults to current', () => {
    expect(parseView(undefined)).toBe('current');
    expect(parseView(null)).toBe('current');
    expect(parseView('')).toBe('current');
  });

  test('current is accepted, case- and whitespace-insensitively', () => {
    expect(parseView('current')).toBe('current');
    expect(parseView('  CURRENT ')).toBe('current');
  });

  test('future is rejected rather than silently served the current map', () => {
    // The dangerous failure mode is not an error, it is returning the CURRENT
    // map labelled "future" — plausible and wrong.
    expect(() => parseView('future')).toThrow(UnsupportedViewError);
    expect(() => parseView('FUTURE')).toThrow(/not available/i);
  });

  test('an unrecognised view is rejected too', () => {
    expect(() => parseView('enacted')).toThrow(UnsupportedViewError);
  });
});
