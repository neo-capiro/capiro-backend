import { DEFENSE_BUDGET_DOMAIN_PRIMER } from '@capiro/shared';
import {
  DOMAIN_PRIMER,
  extractCitedPeCodes,
  planFanOutQueries,
} from './meri-domain-fanout.helpers.js';

describe('DOMAIN_PRIMER', () => {
  it('is concise enough not to blow the prompt budget', () => {
    // Bound aligned to the meriv2-core sibling primer (≤2000): this apps/api copy
    // legitimately carries a few extra structural bullets (procurement-exhibit,
    // outyear, no-reason-without-language) and had outgrown the stale 1700 bound.
    // ~2k chars ≈ ~500 tokens — negligible against the prompt budget.
    expect(DOMAIN_PRIMER.length).toBeLessThanOrEqual(2000);
    expect(DOMAIN_PRIMER.length).toBeGreaterThan(200);
  });
  it('is byte-identical to the shared canonical primer', () => {
    expect(DOMAIN_PRIMER).toBe(DEFENSE_BUDGET_DOMAIN_PRIMER);
  });

  it('states the key structural invariants without the old BA shortcuts', () => {
    const p = DOMAIN_PRIMER.toLowerCase();
    expect(p).toContain('rdt&e');
    expect(p).toContain('procurement');
    expect(p).toContain('authorization');
    expect(p).toContain('appropriation');
    expect(p).toContain('ndaa');
    expect(p).toContain('primary');
    expect(p).toContain('loaded source coverage');
    expect(p).toContain('procurement poc');
    expect(p).toContain('budget activity 4 alone');
    expect(p).not.toContain('rdt&e (budget activity 4)');
    expect(p).not.toContain('procurement (ba 2)');
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
  it('pulls short-tail and alphanumeric-tail BLINs the old regex missed (RC2)', () => {
    // 1507N2280 = 4 trailing digits; 3010F10TRGT = alphanumeric tail. The prior
    // regex required exactly 5 trailing digits, so both were silently dropped —
    // a cited procurement line never fanned out for a structural cross-check.
    const codes = extractCitedPeCodes('Buy via line item 1507N2280 and BLIN 3010F10TRGT.');
    expect(codes).toContain('1507N2280');
    expect(codes).toContain('3010F10TRGT');
  });
  it('captures full PE codes with multi-char suffixes', () => {
    expect(extractCitedPeCodes('PE 0604256AX and 0603851F')).toEqual(['0604256AX', '0603851F']);
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
    const q = planFanOutQueries(
      pes,
      'micro-guided kinetic interceptor for counter-UAS drone defeat',
    );
    expect(q.some((x) => x.kind === 'better_fit_lane')).toBe(true);
  });

  it('plans a sibling check when a "primary vehicle" claim is made', () => {
    const q = planFanOutQueries(
      pes,
      'PE 0207179F is the primary funding vehicle for this mission.',
    );
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
