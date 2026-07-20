import { describe, expect, test } from '@jest/globals';
import {
  DEFAULT_MIN_WRITE_CONFIDENCE,
  passesWriteConfidenceGate,
} from './memory-confidence.helpers.js';

describe('passesWriteConfidenceGate', () => {
  test('passes at/above floor, fails below', () => {
    expect(passesWriteConfidenceGate(0.7, 0.7)).toBe(true);
    expect(passesWriteConfidenceGate(0.69, 0.7)).toBe(false);
    expect(passesWriteConfidenceGate(0.9, 0.7)).toBe(true);
  });

  test('float round-trip at the boundary is not spuriously rejected', () => {
    expect(passesWriteConfidenceGate(0.7 - 1e-12, 0.7)).toBe(true);
  });

  test('null/undefined/NaN fails (unscored machine guess is not trusted)', () => {
    expect(passesWriteConfidenceGate(null)).toBe(false);
    expect(passesWriteConfidenceGate(undefined)).toBe(false);
    expect(passesWriteConfidenceGate(NaN)).toBe(false);
  });

  test('default floor is 0.7', () => {
    expect(DEFAULT_MIN_WRITE_CONFIDENCE).toBe(0.7);
    expect(passesWriteConfidenceGate(0.7)).toBe(true);
    expect(passesWriteConfidenceGate(0.6)).toBe(false);
  });
});
