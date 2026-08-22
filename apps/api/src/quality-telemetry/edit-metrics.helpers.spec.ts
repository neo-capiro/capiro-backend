import { describe, expect, it } from '@jest/globals';
import { computeEditMetrics } from './edit-metrics.helpers.js';

describe('computeEditMetrics', () => {
  it('returns zero distance for identical text', () => {
    const result = computeEditMetrics('hello world', 'hello world');
    expect(result).toEqual({ normalizedEditDistance: 0, percentChanged: 0 });
  });

  it('returns 100% for a fully replaced short string', () => {
    const result = computeEditMetrics('abc', 'xyz');
    expect(result?.percentChanged).toBe(100);
  });

  it('computes a partial change proportionally', () => {
    const result = computeEditMetrics('aaaa', 'aaab');
    expect(result?.normalizedEditDistance).toBeCloseTo(0.25, 5);
    expect(result?.percentChanged).toBe(25);
  });

  it('handles empty-to-nonempty text as 100% changed', () => {
    expect(computeEditMetrics('', 'new content')?.percentChanged).toBe(100);
  });

  it('handles both-empty as zero change, not a division error', () => {
    expect(computeEditMetrics('', '')).toEqual({ normalizedEditDistance: 0, percentChanged: 0 });
  });

  it('returns null (never a fabricated number) when either input exceeds the bounded-cost cap', () => {
    const huge = 'x'.repeat(20_001);
    expect(computeEditMetrics(huge, 'short')).toBeNull();
    expect(computeEditMetrics('short', huge)).toBeNull();
  });
});
