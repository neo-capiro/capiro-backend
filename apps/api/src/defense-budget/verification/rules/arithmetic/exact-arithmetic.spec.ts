/**
 * Tests for exact decimal arithmetic (Workstream H1).
 */
import { describe, it, expect } from '@jest/globals';
import {
  addDecimals,
  subtractDecimals,
  multiplyByInteger,
  absDifference,
  compareWithTolerance,
  printedUnitToleranceMillions,
  sumDecimals,
} from './exact-arithmetic.js';

describe('exact-arithmetic', () => {
  describe('addDecimals', () => {
    it('adds two positive values', () => {
      expect(addDecimals('1.5', '2.25')).toBe('3.75');
    });

    it('adds two negative values', () => {
      expect(addDecimals('-1.5', '-2.25')).toBe('-3.75');
    });

    it('adds positive and negative (cancellation)', () => {
      expect(addDecimals('5', '-3')).toBe('2');
    });

    it('adds to zero', () => {
      expect(addDecimals('-3', '3')).toBe('0');
    });

    it('adds fractional with carry', () => {
      expect(addDecimals('0.7', '0.3')).toBe('1');
    });

    it('adds zero', () => {
      expect(addDecimals('0', '5.5')).toBe('5.5');
    });
  });

  describe('subtractDecimals', () => {
    it('subtracts smaller from larger', () => {
      expect(subtractDecimals('5', '3')).toBe('2');
    });

    it('subtracts larger from smaller (negative result)', () => {
      expect(subtractDecimals('3', '5')).toBe('-2');
    });

    it('subtracts equal values', () => {
      expect(subtractDecimals('3.5', '3.5')).toBe('0');
    });

    it('subtracts negative from positive', () => {
      expect(subtractDecimals('5', '-3')).toBe('8');
    });

    it('subtracts with fractional parts', () => {
      expect(subtractDecimals('1.5', '0.25')).toBe('1.25');
    });
  });

  describe('multiplyByInteger', () => {
    it('multiplies by zero', () => {
      expect(multiplyByInteger('5.5', '0')).toBe('0');
    });

    it('multiplies positive integer', () => {
      expect(multiplyByInteger('2.5', '4')).toBe('10');
    });

    it('multiplies fractional', () => {
      expect(multiplyByInteger('0.0005', '3')).toBe('0.0015');
    });

    it('multiplies large number', () => {
      expect(multiplyByInteger('1.25', '100')).toBe('125');
    });
  });

  describe('absDifference', () => {
    it('returns absolute difference', () => {
      expect(absDifference('3', '5')).toBe('2');
      expect(absDifference('5', '3')).toBe('2');
    });

    it('returns zero for equal values', () => {
      expect(absDifference('3.5', '3.5')).toBe('0');
    });
  });

  describe('compareWithTolerance', () => {
    it('returns 0 when within tolerance', () => {
      expect(compareWithTolerance('1', '1.0004', '0.0005')).toBe(0);
    });

    it('returns -1 when a < b - tolerance', () => {
      expect(compareWithTolerance('1', '1.5', '0.0005')).toBe(-1);
    });

    it('returns 1 when a > b + tolerance', () => {
      expect(compareWithTolerance('1.5', '1', '0.0005')).toBe(1);
    });

    it('returns 0 for exact equality', () => {
      expect(compareWithTolerance('2.5', '2.5', '0')).toBe(0);
    });
  });

  describe('printedUnitToleranceMillions', () => {
    it('returns 0 for zero terms', () => {
      expect(printedUnitToleranceMillions(0)).toBe('0');
    });

    it('returns 0.0005 for one term', () => {
      expect(printedUnitToleranceMillions(1)).toBe('0.0005');
    });

    it('returns N * 0.0005 for N terms', () => {
      expect(printedUnitToleranceMillions(3)).toBe('0.0015');
      expect(printedUnitToleranceMillions(10)).toBe('0.005');
    });
  });

  describe('sumDecimals', () => {
    it('sums empty array to zero', () => {
      expect(sumDecimals([])).toBe('0');
    });

    it('sums multiple values', () => {
      expect(sumDecimals(['1.5', '2.5', '3'])).toBe('7');
    });

    it('sums with negative values', () => {
      expect(sumDecimals(['10', '-3', '-2'])).toBe('5');
    });
  });
});
