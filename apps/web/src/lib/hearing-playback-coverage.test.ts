import { describe, expect, it } from 'vitest';
import { hasPlaybackAt, publicPlaybackCoverage } from './hearing-playback-coverage.js';

describe('retained media coverage', () => {
  it('offers playback only inside retained, unexpired intervals, never transcript-only gaps', () => {
    const now = Date.parse('2026-10-06T12:00:00Z');
    const epoch = { state: 'ready', startMs: 0, durableEndMs: 1000, durableBytes: 100, expiresAt: '2026-10-07T12:00:00Z' };
    const coverage = publicPlaybackCoverage([epoch, { ...epoch, startMs: 2000, durableEndMs: 3000 },
      { ...epoch, startMs: 4000, durableEndMs: 5000, durableBytes: 0 },
      { ...epoch, startMs: 6000, durableEndMs: 7000, expiresAt: '2026-10-05' },
      { ...epoch, startMs: 8000, durableEndMs: 9000, state: 'expired' }], now);
    expect(coverage).toHaveLength(2);
    expect(hasPlaybackAt(coverage, 0)).toBe(true);
    expect(hasPlaybackAt(coverage, 999)).toBe(true);
    for (const time of [1000, 1500, 3000, 4000, 6000, 8000, NaN]) expect(hasPlaybackAt(coverage, time)).toBe(false);
    expect(hasPlaybackAt([], 0)).toBe(false);
  });
});
