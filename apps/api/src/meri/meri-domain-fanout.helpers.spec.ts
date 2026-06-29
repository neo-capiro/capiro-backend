import {
  DOMAIN_PRIMER,
  extractCitedPeCodes,
  planFanOutQueries,
} from './meri-domain-fanout.helpers.js';

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
    expect(p).toContain('primary');
    expect(p).toContain('markup');
  });
});

describe('extractCitedPeCodes', () => {
  it('pulls PE codes in both formats', () => {
    const text =
      'Anchor to PE 0207179F and FAMM 0604041F; avoid program line 5726K99200 (XM32).';
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

describe('planFanOutQueries', () => {
  const pes = [{ peCode: '0207179F', title: 'Autonomous Collaborative Platforms' }];

  it('always plans a markup-status check per PE (freshness)', () => {
    const q = planFanOutQueries(pes, 'A neutral sentence about the program.');
    expect(q.some((x) => x.kind === 'markup_status' && x.peCode === '0207179F')).toBe(true);
  });

  it('plans a better-fit-lane check when the deliverable is about a kinetic capability', () => {
    const q = planFanOutQueries(pes, 'micro-guided kinetic interceptor for counter-UAS drone defeat');
    expect(q.some((x) => x.kind === 'better_fit_lane')).toBe(true);
  });

  it('plans a sibling check when a "primary vehicle" claim is made', () => {
    const q = planFanOutQueries(pes, 'PE 0207179F is the primary funding vehicle for this mission.');
    expect(q.some((x) => x.kind === 'primary_vehicle_siblings')).toBe(true);
  });

  it('does NOT plan kinetic/primary checks for an unrelated, modest deliverable', () => {
    const q = planFanOutQueries(pes, 'A routine status note.');
    expect(q.some((x) => x.kind === 'better_fit_lane')).toBe(false);
    expect(q.some((x) => x.kind === 'primary_vehicle_siblings')).toBe(false);
  });

  it('dedupes and caps the query count', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ peCode: `000000${i}F` }));
    const q = planFanOutQueries(many, 'primary vehicle missile interceptor', 5);
    expect(q.length).toBeLessThanOrEqual(5);
  });
});
