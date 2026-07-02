import { normalizeServiceFilter } from './service-filter.js';

describe('normalizeServiceFilter', () => {
  test('legacy Finder values that silently matched nothing now resolve', () => {
    // The pre-fix SERVICE_OPTIONS sent these; DB stores AF/SF/DW.
    expect(normalizeServiceFilter('AIR_FORCE')).toBe('AF');
    expect(normalizeServiceFilter('SPACE_FORCE')).toBe('SF');
    expect(normalizeServiceFilter('DOD')).toBe('DW');
  });

  test('canonical codes pass through', () => {
    for (const c of ['ARMY', 'NAVY', 'AF', 'SF', 'USMC', 'DW', 'DARPA']) {
      expect(normalizeServiceFilter(c)).toBe(c);
    }
  });

  test('display labels and common variants resolve, case-insensitively', () => {
    expect(normalizeServiceFilter('Air Force')).toBe('AF');
    expect(normalizeServiceFilter('space force')).toBe('SF');
    expect(normalizeServiceFilter('Marine Corps')).toBe('USMC');
    expect(normalizeServiceFilter('Defense-Wide')).toBe('DW');
    expect(normalizeServiceFilter('usaf')).toBe('AF');
    expect(normalizeServiceFilter('navy')).toBe('NAVY');
  });

  test('unknown values pass through unchanged; empty/null become undefined', () => {
    expect(normalizeServiceFilter('COAST_GUARD')).toBe('COAST_GUARD');
    expect(normalizeServiceFilter('')).toBeUndefined();
    expect(normalizeServiceFilter('   ')).toBeUndefined();
    expect(normalizeServiceFilter(null)).toBeUndefined();
    expect(normalizeServiceFilter(undefined)).toBeUndefined();
  });
});
