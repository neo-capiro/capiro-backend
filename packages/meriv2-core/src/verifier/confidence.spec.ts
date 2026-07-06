import { confidenceLevel } from './confidence';

describe('confidenceLevel', () => {
  it('null / NaN => unknown', () => {
    expect(confidenceLevel(null).level).toBe('unknown');
    expect(confidenceLevel(Number.NaN).level).toBe('unknown');
  });

  it('boundaries', () => {
    expect(confidenceLevel(0).level).toBe('high');
    expect(confidenceLevel(0.05).level).toBe('high');
    expect(confidenceLevel(0.0500001).level).toBe('medium');
    expect(confidenceLevel(0.2).level).toBe('medium');
    expect(confidenceLevel(0.2001).level).toBe('low');
    expect(confidenceLevel(1).level).toBe('low');
  });

  it('labels are human-readable and warn at low confidence', () => {
    expect(confidenceLevel(0).label).toMatch(/high/i);
    expect(confidenceLevel(0.5).label.toLowerCase()).toContain('verify');
  });
});
