import {
  computeScore,
  bandOf,
  urgencyFactor,
  materialityFactor,
  scoreShadowAlert,
  CRITICAL_CHANGE_TYPES,
  CRITICAL_SEVERITY_FLOOR,
} from '../src/intel-alert/alert-scorer.js';
import {
  classifyStatusChange,
  classifyStateStatusChange,
} from '../src/tracker/change-detector.util.js';

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

/**
 * Gate D phase a (P1-08). The floor used to key on a hard-coded FEDERAL
 * change-type list, so five change types the detector itself classifies
 * `critical` could band Med. Audit test-gap item 9.
 */
describe('P1-08 — critical events band High on SEVERITY, not a federal list', () => {
  const NOW = new Date('2026-03-10T00:00:00Z').getTime();

  // D2: every string added to CRITICAL_CHANGE_TYPES must actually be emitted by
  // change-detector.util.ts. A typo here is a silent no-op — the exact failure
  // mode P1-08 already had — so assert it against the detector, not a comment.
  it('D2: every added change type is really emitted by the detector', () => {
    expect(classifyStatusChange('rule_failed')?.changeType).toBe('bill_rule_failed');
    for (const status of ['enacted', 'vetoed', 'failed', 'dead_by_deadline']) {
      const cls = classifyStateStatusChange(status);
      expect(cls?.changeType).toBe(`state_bill_${status}`);
      expect(cls?.severity).toBe('critical'); // and the detector agrees it is critical
    }
    expect(CRITICAL_CHANGE_TYPES).toEqual([
      'bill_enacted',
      'bill_to_president',
      'bill_failed',
      'bill_rule_failed',
      'state_bill_enacted',
      'state_bill_vetoed',
      'state_bill_failed',
      'state_bill_dead_by_deadline',
    ]);
  });

  it.each([
    ['bill_rule_failed'], // case 1 — the motivating example
    ['state_bill_vetoed'], // case 2
    ['state_bill_dead_by_deadline'], // case 3
    ['state_bill_enacted'],
    ['state_bill_failed'],
  ])('bands %s High with no action date', (changeType) => {
    const r = scoreShadowAlert({
      severity: 'critical',
      materiality: 'high',
      changeType,
      actionDate: null,
      matchedTags: [],
      nowMs: NOW,
    });
    expect(r.band).toBe('High');
    expect(r.score).toBeGreaterThanOrEqual(CRITICAL_SEVERITY_FLOOR);
  });

  // case 4 — the SEVERITY path on its own, with a changeType in neither list.
  // state_bill_deadline_approaching at <3 days is exactly this: the detector
  // marks it critical dynamically, so no static list can ever cover it.
  it('bands a critical severity High even when the change type is not listed', () => {
    const r = scoreShadowAlert({
      severity: 'critical',
      materiality: 'low',
      changeType: 'state_bill_deadline_approaching',
      actionDate: null,
      matchedTags: [],
      nowMs: NOW,
    });
    expect(CRITICAL_CHANGE_TYPES).not.toContain('state_bill_deadline_approaching');
    expect(r.band).toBe('High');
  });

  // case 5 — regression lock on the list path: a low severity on a listed
  // terminal move still bands High.
  it('keeps the list path: severity info + bill_enacted still bands High', () => {
    const r = scoreShadowAlert({
      severity: 'info',
      materiality: 'low',
      changeType: 'bill_enacted',
      actionDate: null,
      matchedTags: [],
      nowMs: NOW,
    });
    expect(r.band).toBe('High');
  });

  // case 6 — a non-critical alert's score is byte-identical to pre-Gate-D.
  it('leaves a non-critical alert byte-identical', () => {
    const r = scoreShadowAlert({
      severity: 'notable',
      materiality: 'medium',
      changeType: 'bill_amendment',
      actionDate: new Date(NOW - 3_600_000), // 1h ago → urgency 1.0
      matchedTags: ['energy'],
      nowMs: NOW,
    });
    // The literal pre-Gate-D double, not an approximation.
    expect(r.score).toBe(0.6376666666666668);
    expect(r.band).toBe('Med');
    // …and it still routes through the untouched §7.1 weights.
    expect(r.score).toBe(
      computeScore({
        relevance: 0.8,
        materiality: materialityFactor('medium'),
        urgency: 1.0,
        political: 0,
        clientPriority: 0.66,
        legCoverage: 0.5,
      }),
    );
  });

  // case 7 — the deliberate asymmetry documented on urgencyFactor: a critical
  // SEVERITY with no action date does not get urgency 1.0 for free.
  it('does not grant urgency 1.0 to a critical severity off the list', () => {
    expect(urgencyFactor(null, 'state_bill_deadline_approaching', NOW)).toBe(0.1);
    expect(urgencyFactor(null, 'bill_rule_failed', NOW)).toBe(1.0); // listed → yes
  });

  it('D1: bandOf thresholds are untouched and the floor equals the High threshold', () => {
    expect(CRITICAL_SEVERITY_FLOOR).toBe(0.66);
    expect(bandOf(CRITICAL_SEVERITY_FLOOR)).toBe('High');
    expect(bandOf(0.66 - Number.EPSILON)).toBe('Med');
    expect(bandOf(0.45)).toBe('Med');
    expect(bandOf(0.45 - Number.EPSILON)).toBe('Low');
  });
});
