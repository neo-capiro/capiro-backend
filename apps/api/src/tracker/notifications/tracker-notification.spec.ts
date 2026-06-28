import { clearsMateriality, SEVERITY_RANK } from './tracker-notification.types.js';

describe('clearsMateriality', () => {
  it('high floor only passes critical', () => {
    expect(clearsMateriality('critical', 'high')).toBe(true);
    expect(clearsMateriality('notable', 'high')).toBe(false);
    expect(clearsMateriality('info', 'high')).toBe(false);
  });
  it('medium floor passes notable + critical', () => {
    expect(clearsMateriality('critical', 'medium')).toBe(true);
    expect(clearsMateriality('notable', 'medium')).toBe(true);
    expect(clearsMateriality('info', 'medium')).toBe(false);
  });
  it('low floor passes everything', () => {
    expect(clearsMateriality('critical', 'low')).toBe(true);
    expect(clearsMateriality('notable', 'low')).toBe(true);
    expect(clearsMateriality('info', 'low')).toBe(true);
  });
  it('defaults unknown materiality to medium', () => {
    expect(clearsMateriality('info', 'bogus')).toBe(false);
    expect(clearsMateriality('notable', 'bogus')).toBe(true);
  });
  it('severity rank is ordered', () => {
    expect(SEVERITY_RANK.critical).toBeGreaterThan(SEVERITY_RANK.notable);
    expect(SEVERITY_RANK.notable).toBeGreaterThan(SEVERITY_RANK.info);
  });
});
