import { DOMAIN_PRIMER, extractCitedPeCodes } from './domain-primer';

describe('DOMAIN_PRIMER', () => {
  it('is concise enough not to blow the prompt budget', () => {
    expect(DOMAIN_PRIMER.length).toBeLessThanOrEqual(1700);
    expect(DOMAIN_PRIMER.length).toBeGreaterThan(200);
  });
  it('states the key structural invariants', () => {
    const p = DOMAIN_PRIMER.toLowerCase();
    expect(p).toContain('rdt&e');
    expect(p).toContain('procurement');
    expect(p).toContain('authorization');
    expect(p).toContain('appropriation');
    expect(p).toContain('ndaa');
  });
});

describe('extractCitedPeCodes', () => {
  it('pulls PE codes in both formats', () => {
    const text = 'Anchor to PE 0207179F and FAMM 0604041F; avoid program line 5726K99200 (XM32).';
    const codes = extractCitedPeCodes(text);
    expect(codes).toContain('0207179F');
    expect(codes).toContain('0604041F');
    expect(codes).toContain('5726K99200');
  });
  it('dedupes and handles no matches', () => {
    expect(extractCitedPeCodes('PE 0207179F and 0207179F again')).toEqual(['0207179F']);
    expect(extractCitedPeCodes('no codes here')).toEqual([]);
    expect(extractCitedPeCodes(null as unknown as string)).toEqual([]);
  });
});
