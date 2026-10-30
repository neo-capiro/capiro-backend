import { describe, expect, test } from '@jest/globals';
import { formatUsdCompact } from './engagement-ai.service.js';

describe('formatUsdCompact — adaptive money format (W0.6)', () => {
  test('sub-billion amounts render in millions, never "$0B"', () => {
    expect(formatUsdCompact(450_000_000)).toBe('$450M');
    expect(formatUsdCompact(248_000_000)).toBe('$248M');
    expect(formatUsdCompact(450_000_000)).not.toContain('B');
  });

  test('billions and trillions keep one decimal', () => {
    expect(formatUsdCompact(10_600_000_000)).toBe('$10.6B');
    expect(formatUsdCompact(2_400_000_000_000)).toBe('$2.4T');
  });

  test('thousands and zero degrade cleanly', () => {
    expect(formatUsdCompact(12_000)).toBe('$12K');
    expect(formatUsdCompact(0)).toBe('$0');
    expect(formatUsdCompact(Number.NaN)).toBe('$0');
  });
});
