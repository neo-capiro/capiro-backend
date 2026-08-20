import { describe, expect, it } from 'vitest';
import { readableDegradedReasons } from './MeriContextSheet.js';

describe('readableDegradedReasons', () => {
  it('humanizes a semicolon-joined list of bare codes', () => {
    expect(
      readableDegradedReasons(
        'firm-identity; coverage_manifest_incomplete; source_unavailable:clients',
      ),
    ).toEqual(['Firm identity', 'Coverage manifest incomplete', 'Source unavailable (clients)']);
  });

  it('leaves a plain prose sentence untouched', () => {
    const prose =
      'The roll-call source is unavailable, so no claim about the vote margin can be verified in either direction.';
    expect(readableDegradedReasons(prose)).toEqual([prose]);
  });

  it('leaves prose with an internal semicolon untouched', () => {
    const prose = 'Mail coverage is degraded; the calendar feed is current.';
    expect(readableDegradedReasons(prose)).toEqual([prose]);
  });

  it('handles a single bare code with no semicolon', () => {
    expect(readableDegradedReasons('coverage_manifest_incomplete')).toEqual([
      'Coverage manifest incomplete',
    ]);
  });

  it('leaves the default single-sentence fallback untouched', () => {
    expect(readableDegradedReasons('The context packet is degraded.')).toEqual([
      'The context packet is degraded.',
    ]);
  });
});
