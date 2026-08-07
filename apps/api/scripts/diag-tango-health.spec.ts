import { describe, expect, test } from '@jest/globals';
import { parseArgs } from './diag-tango-health.js';

describe('CLI parsing', () => {
  test('defaults to a 60-minute window with no flags', () => {
    expect(parseArgs([])).toEqual({ windowMinutes: 60 });
  });

  test('--window sets the window in minutes', () => {
    expect(parseArgs(['--window=1440'])).toEqual({ windowMinutes: 1440 });
    expect(parseArgs(['--window', '15'])).toEqual({ windowMinutes: 15 });
  });

  test('is clamped at 30 days, so a typo cannot scan the whole table', () => {
    expect(parseArgs(['--window=999999']).windowMinutes).toBe(43_200);
  });

  test('a non-numeric or non-positive value falls back to the default', () => {
    expect(parseArgs(['--window=nonsense']).windowMinutes).toBe(60);
    expect(parseArgs(['--window=0']).windowMinutes).toBe(60);
    expect(parseArgs(['--window=-5']).windowMinutes).toBe(60);
  });
});
