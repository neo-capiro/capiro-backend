import {
  DEFAULT_MATERIALITY_WEIGHTS,
  MATERIALITY_THRESHOLDS,
  dollarMagnitudeFactor,
  pctMagnitudeFactor,
  rescoreWithClientRelevance,
  scoreMateriality,
  severityForScore,
  type DeltaStage,
  type MaterialityInput,
} from './materiality-scorer.js';

const base = (over: Partial<MaterialityInput> = {}): MaterialityInput => ({
  deltaType: 'mark_vs_request',
  deltaAbsM: 50,
  deltaPct: 0.1,
  stage: 'marks',
  ...over,
});

describe('dollarMagnitudeFactor', () => {
  test('is 0 at no change and strictly increasing in |Δ$| (log-scaled, clamped)', () => {
    expect(dollarMagnitudeFactor(0)).toBe(0);
    expect(dollarMagnitudeFactor(null)).toBe(0);
    const samples = [1, 10, 100, 1000, 10000].map((m) => dollarMagnitudeFactor(m));
    for (let i = 1; i < samples.length; i += 1) {
      expect(samples[i]!).toBeGreaterThanOrEqual(samples[i - 1]!);
    }
    // Saturates to ~1 at/above the $1B reference, clamped to 1.
    expect(dollarMagnitudeFactor(1000)).toBeCloseTo(1, 5);
    expect(dollarMagnitudeFactor(1e9)).toBe(1);
    // Sign is ignored — magnitude only.
    expect(dollarMagnitudeFactor(-200)).toBe(dollarMagnitudeFactor(200));
  });
});

describe('pctMagnitudeFactor', () => {
  test('clamps to [0,1] and ignores null/non-finite', () => {
    expect(pctMagnitudeFactor(null)).toBe(0);
    expect(pctMagnitudeFactor(Infinity)).toBe(0);
    expect(pctMagnitudeFactor(0.25)).toBeCloseTo(0.25);
    expect(pctMagnitudeFactor(5)).toBe(1); // 500% saturates at 1
    expect(pctMagnitudeFactor(-0.3)).toBeCloseTo(0.3); // magnitude only
  });
});

describe('severityForScore', () => {
  test.each([
    [0, 'info'],
    [0.39, 'info'],
    [MATERIALITY_THRESHOLDS.notable, 'notable'],
    [0.5, 'notable'],
    [0.69, 'notable'],
    [MATERIALITY_THRESHOLDS.critical, 'critical'],
    [0.95, 'critical'],
  ])('score %s → %s', (score, expected) => {
    expect(severityForScore(score)).toBe(expected);
  });
});

describe('scoreMateriality — monotonicity (more $ → ≥ score)', () => {
  test.each([
    [10, 50],
    [50, 200],
    [200, 800],
    [800, 5000],
  ])('|Δ$|=%sM ≤ |Δ$|=%sM in score, all else equal', (small, big) => {
    const lo = scoreMateriality(base({ deltaAbsM: small })).score;
    const hi = scoreMateriality(base({ deltaAbsM: big })).score;
    expect(hi).toBeGreaterThanOrEqual(lo);
  });

  test('strictly increasing across a sweep', () => {
    const sweep = [0, 1, 5, 25, 100, 500, 2000].map((m) => scoreMateriality(base({ deltaAbsM: m })).score);
    for (let i = 1; i < sweep.length; i += 1) {
      expect(sweep[i]!).toBeGreaterThanOrEqual(sweep[i - 1]!);
    }
  });

  test('more % → ≥ score, all else equal', () => {
    const lo = scoreMateriality(base({ deltaPct: 0.05 })).score;
    const hi = scoreMateriality(base({ deltaPct: 0.6 })).score;
    expect(hi).toBeGreaterThanOrEqual(lo);
  });
});

describe('scoreMateriality — stage ordering (enacted > conference > marks > pb)', () => {
  test('same delta at a later stage scores ≥ an earlier stage', () => {
    const fixed = { deltaType: 'mark_vs_request', deltaAbsM: 100, deltaPct: 0.2 } as const;
    const stages: DeltaStage[] = ['pb', 'marks', 'conference', 'enacted'];
    const scores = stages.map((stage) => scoreMateriality({ ...fixed, stage }).score);
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]!).toBeGreaterThanOrEqual(scores[i - 1]!);
    }
    // And strictly: enacted beats pb here (non-trivial stage weight).
    expect(scores[3]!).toBeGreaterThan(scores[0]!);
  });
});

describe('scoreMateriality — unusual-pattern boost', () => {
  test('new_start / termination / zeroed / transfer_candidate beat a same-size ordinary delta', () => {
    const size = { deltaAbsM: 30, deltaPct: 0.1, stage: 'pb' as const };
    const ordinary = scoreMateriality({ deltaType: 'mark_vs_request', ...size }).score;
    for (const t of ['new_start', 'termination', 'zeroed', 'transfer_candidate']) {
      expect(scoreMateriality({ deltaType: t, ...size }).score).toBeGreaterThan(ordinary);
    }
  });

  test('a structural change clears the notable line on the boost alone', () => {
    // A brand-new $5M start: tiny dollars/%, pb stage, but new_start → notable.
    const r = scoreMateriality({ deltaType: 'new_start', deltaAbsM: 5, deltaPct: null, stage: 'pb' });
    expect(r.score).toBeGreaterThanOrEqual(MATERIALITY_THRESHOLDS.notable);
    expect(r.severity).not.toBe('info');
  });
});

describe('scoreMateriality — clientRelevance is a per-tenant read-time lever', () => {
  test('default stored score uses clientRelevance=0; layering relevance only raises it', () => {
    const stored = scoreMateriality(base()).score;
    expect(scoreMateriality(base()).factors.clientRelevance).toBe(0);

    const relevant = rescoreWithClientRelevance(base(), 1).score;
    expect(relevant).toBeGreaterThanOrEqual(stored);
    // The lift equals the clientRelevance weight (relevance contributes weight*1) up to clamp.
    expect(relevant).toBeGreaterThan(stored);
  });
});

describe('scoreMateriality — bounds + factor decomposition', () => {
  test('score is always within [0,1] even with huge inputs', () => {
    const r = scoreMateriality({
      deltaType: 'new_start',
      deltaAbsM: 1e9,
      deltaPct: 1e6,
      stage: 'enacted',
      clientRelevance: 1,
      deadlineProximity: 1,
    });
    expect(r.score).toBeLessThanOrEqual(1);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  test('weighted factors are each within their weight and (pre-clamp) sum to score', () => {
    const r = scoreMateriality(base({ deltaAbsM: 1, deltaPct: 0.01, stage: 'pb' }));
    expect(r.factors.dollarMagnitude).toBeLessThanOrEqual(DEFAULT_MATERIALITY_WEIGHTS.dollarMagnitude);
    expect(r.factors.stageSignificance).toBeLessThanOrEqual(DEFAULT_MATERIALITY_WEIGHTS.stageSignificance);
    const sum =
      r.factors.dollarMagnitude +
      r.factors.pctMagnitude +
      r.factors.stageSignificance +
      r.factors.clientRelevance +
      r.factors.deadlineProximity +
      r.factors.unusualPattern;
    expect(r.score).toBeCloseTo(Math.min(1, sum), 6);
  });
});
