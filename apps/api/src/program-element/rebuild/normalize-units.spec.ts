import { describe, expect, test } from '@jest/globals';
import {
  needsScaling,
  toMillions,
  DOLLARS_THRESHOLD,
  PE_VALUE_COLUMNS,
} from './normalize-units.js';

describe('needsScaling', () => {
  test('dollar-scale values (above threshold) need scaling', () => {
    expect(needsScaling(60280000)).toBe(true); // $60.3M stored as dollars
    expect(needsScaling(931164000)).toBe(true);
    expect(needsScaling(555000)).toBe(true); // small $0.555M program, still dollars
    expect(needsScaling(-3000000)).toBe(true); // negative reprogramming
  });

  test('already-millions and fixture values (at/below threshold) are left alone', () => {
    expect(needsScaling(931.164)).toBe(false); // already converted
    expect(needsScaling(220.1)).toBe(false); // seed fixture
    expect(needsScaling(1478.648)).toBe(false); // largest real mark seen
    expect(needsScaling(0)).toBe(false);
    expect(needsScaling(null)).toBe(false);
    expect(needsScaling(undefined)).toBe(false);
  });

  test('threshold boundary', () => {
    expect(needsScaling(DOLLARS_THRESHOLD)).toBe(false); // exactly at -> not scaled
    expect(needsScaling(DOLLARS_THRESHOLD + 1)).toBe(true);
  });
});

describe('toMillions', () => {
  test('divides by 1e6', () => {
    expect(toMillions(60280000)).toBe(60.28);
    expect(toMillions(931164000)).toBe(931.164);
  });
});

describe('PE_VALUE_COLUMNS', () => {
  test('covers all ten numeric mark columns', () => {
    expect(PE_VALUE_COLUMNS).toHaveLength(10);
    expect(PE_VALUE_COLUMNS).toContain('enacted');
    expect(PE_VALUE_COLUMNS).toContain('conference');
    expect(PE_VALUE_COLUMNS).toContain('ndaa_conference');
    expect(PE_VALUE_COLUMNS).toContain('request');
  });
});
