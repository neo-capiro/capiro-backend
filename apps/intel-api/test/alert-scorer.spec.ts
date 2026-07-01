import { computeScore, bandOf, urgencyFactor, materialityFactor, scoreShadowAlert } from '../src/intel-alert/alert-scorer.js';

/** Phase 4 (plan §7.1): weighted composite. */
describe('computeScore', () => {
  it('applies the §7.1 weights with confidence penalty', () => {
    // relevance .8, materiality 1, urgency 1, political 0, clientPriority .66, legCoverage .5
    // = .35*.8 + .25*1 + .20*1 + 0 + .10*.66 - .15*(1-.5) = .28+.25+.20+.066-.075 = .721
    expect(computeScore({ relevance: 0.8, materiality: 1, urgency: 1, political: 0, clientPriority: 0.66, legCoverage: 0.5 })).toBeCloseTo(0.721, 3);
  });
  it('clamps to [0,1]', () => {
    expect(computeScore({ relevance: 1, materiality: 1, urgency: 1, political: 1, clientPriority: 1, legCoverage: 1 })).toBe(1);
    expect(computeScore({ relevance: 0, materiality: 0, urgency: 0, political: 0, clientPriority: 0, legCoverage: 0 })).toBe(0);
  });
});

describe('bandOf', () => {
  it('maps score → band at 0.66 / 0.45', () => {
    expect(bandOf(0.7)).toBe('High');
    expect(bandOf(0.5)).toBe('Med');
    expect(bandOf(0.4)).toBe('Low');
  });
});

describe('urgencyFactor', () => {
  const now = new Date('2026-03-10T00:00:00Z').getTime();
  it('rewards recency', () => {
    expect(urgencyFactor(new Date('2026-03-09T12:00:00Z'), 'bill_amendment', now)).toBe(1.0);
    expect(urgencyFactor(new Date('2026-03-05T00:00:00Z'), 'bill_amendment', now)).toBe(0.7);
    expect(urgencyFactor(new Date('2026-02-20T00:00:00Z'), 'bill_amendment', now)).toBe(0.4);
    expect(urgencyFactor(new Date('2026-01-01T00:00:00Z'), 'bill_amendment', now)).toBe(0.1);
    expect(urgencyFactor(null, 'bill_amendment', now)).toBe(0.1);
  });
  it('overrides to 1.0 for critical change types', () => {
    expect(urgencyFactor(new Date('2020-01-01T00:00:00Z'), 'bill_enacted', now)).toBe(1.0);
    expect(urgencyFactor(null, 'bill_failed', now)).toBe(1.0);
  });
});

describe('materialityFactor', () => {
  it('normalizes rank to /3', () => {
    expect(materialityFactor('high')).toBeCloseTo(1, 5);
    expect(materialityFactor('medium')).toBeCloseTo(0.6667, 3);
    expect(materialityFactor('low')).toBeCloseTo(0.3333, 3);
  });
});

describe('scoreShadowAlert', () => {
  it('always bands critical change types High (S5)', () => {
    for (const ct of ['bill_enacted', 'bill_to_president', 'bill_failed']) {
      const r = scoreShadowAlert({ severity: 'critical', materiality: 'high', changeType: ct, actionDate: null, matchedTags: [] });
      expect(r.band).toBe('High');
      expect(r.score).toBeGreaterThanOrEqual(0.66);
    }
  });
  it('scores a matched notable alert higher than an unmatched one', () => {
    const matched = scoreShadowAlert({ severity: 'notable', materiality: 'medium', changeType: 'bill_amendment', actionDate: new Date(), matchedTags: ['energy'] });
    const unmatched = scoreShadowAlert({ severity: 'notable', materiality: 'medium', changeType: 'bill_amendment', actionDate: new Date(), matchedTags: [] });
    expect(matched.score).toBeGreaterThan(unmatched.score);
    expect(matched.score).toBeGreaterThanOrEqual(0);
    expect(matched.score).toBeLessThanOrEqual(1);
  });
});
