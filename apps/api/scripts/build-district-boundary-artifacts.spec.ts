import { describe, expect, test } from '@jest/globals';
import { formatSummary, parseArgs } from './build-district-boundary-artifacts.js';

describe('parseArgs', () => {
  test('defaults to a DRY RUN over both rails, all states', () => {
    const o = parseArgs(['node', 'script']);
    expect(o.commit).toBe(false);
    expect(o.statuses).toEqual(['C', 'F']);
    expect(o.states).toBeNull();
    expect(o.censusUrl).toMatch(/^https:\/\/www2\.census\.gov\/.*\.zip$/);
  });

  test('--commit is the only thing that enables writes', () => {
    expect(parseArgs(['node', 'script', '--commit']).commit).toBe(true);
    // A typo must not silently enable writes.
    expect(parseArgs(['node', 'script', '--COMMIT']).commit).toBe(false);
    expect(parseArgs(['node', 'script', '--commit=true']).commit).toBe(false);
  });

  test('--status selects a single rail', () => {
    expect(parseArgs(['node', 'script', '--status=C']).statuses).toEqual(['C']);
    expect(parseArgs(['node', 'script', '--status=F']).statuses).toEqual(['F']);
    expect(parseArgs(['node', 'script', '--status=f']).statuses).toEqual(['F']);
    // Anything unrecognized falls back to both rather than building nothing.
    expect(parseArgs(['node', 'script', '--status=banana']).statuses).toEqual(['C', 'F']);
  });

  test('--states is normalized to an uppercase set', () => {
    const o = parseArgs(['node', 'script', '--states=tx, wy']);
    expect(o.states && [...o.states].sort()).toEqual(['TX', 'WY']);
  });

  test('an empty --states is treated as "all", not "none"', () => {
    // Building zero states silently would look like a successful no-op run.
    expect(parseArgs(['node', 'script', '--states=']).states).toBeNull();
    expect(parseArgs(['node', 'script', '--states=,,']).states).toBeNull();
  });

  test('--census-url overrides the vintage without a code change', () => {
    const o = parseArgs(['node', 'script', '--census-url=https://example.test/cb_2027.zip']);
    expect(o.censusUrl).toBe('https://example.test/cb_2027.zip');
  });
});

describe('formatSummary', () => {
  test('emits one greppable line of JSON', () => {
    const line = formatSummary({ source: 'x', districtCount: 441 });
    expect(line.startsWith('BUILD_DISTRICT_BOUNDARY_ARTIFACTS_SUMMARY ')).toBe(true);
    const json = line.slice('BUILD_DISTRICT_BOUNDARY_ARTIFACTS_SUMMARY '.length);
    expect(JSON.parse(json)).toEqual({ source: 'x', districtCount: 441 });
  });
});
