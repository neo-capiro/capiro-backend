import { GROUNDING_CHARS, serializeRecordForGrounding } from './grounding-sources';

describe('serializeRecordForGrounding', () => {
  it('preserves budget numbers and per-FY rows (the data the verifier needs)', () => {
    const pe = {
      peCode: '0604041F',
      title: 'Family of Affordable Mass Missiles',
      appropriationType: 'RDT&E',
      years: [
        { fy: 2027, request: 525_220_000, hascMark: 472_700_000 },
        { fy: 2026, enacted: 0 },
      ],
    };
    const g = serializeRecordForGrounding(pe);
    expect(g).toContain('0604041F');
    expect(g).toContain('Family of Affordable Mass Missiles');
    expect(g).toContain('RDT&E');
    expect(g).toContain('525220000'); // the request figure is now present
    expect(g).toContain('472700000'); // the HASC mark is now present
    expect(g).toContain('fy=2027');
  });

  it('truncates to the grounding budget', () => {
    const big = { title: 'x', blob: 'y'.repeat(5000) };
    expect(serializeRecordForGrounding(big).length).toBeLessThanOrEqual(GROUNDING_CHARS);
  });

  it('handles non-object input', () => {
    expect(serializeRecordForGrounding(null)).toBe('');
    expect(serializeRecordForGrounding('hello')).toBe('hello');
  });
});
