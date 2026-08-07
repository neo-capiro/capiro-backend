import { describe, expect, test } from '@jest/globals';
import {
  APPROACHING_AWARD_DAYS,
  FORECAST_REASON_CODES,
  scoreForecastRelevance,
  type ForecastRelevanceInput,
} from './forecast-relevance.js';
import { FORECAST_RECOMMENDATIONS, MACHINE_RECOMMENDATIONS, RECOMMENDATION_CONFIDENCES } from './opportunity-recommendation.js';

/**
 * P25 — the forecast recommendation truth table.
 *
 * The acceptance bar, stated as tests:
 *   - a generic forecast with no client evidence cannot surface (never
 *     shape_now, never monitor from a real signal — always pass);
 *   - an exact program/capability match CAN surface, with an early-action
 *     reason (shape_now);
 *   - no response deadline is fabricated anywhere in the output;
 *   - the recommendation is stable — the same input always produces the
 *     same output.
 */

const ASOF = new Date('2026-08-07T00:00:00.000Z');
const FAR_AWARD = '2028-01-01T00:00:00.000Z';
const APPROACHING_AWARD = '2026-09-15T00:00:00.000Z'; // ~39 days out
const PAST_AWARD = '2026-01-01T00:00:00.000Z';

function input(over: Partial<ForecastRelevanceInput> = {}): ForecastRelevanceInput {
  return {
    isActive: true,
    profileTooThin: false,
    exactNaicsMatch: false,
    exactPscMatch: false,
    capabilityMatch: false,
    priorAgencyHistory: false,
    programElementLinkedSourceBacked: false,
    locationMatch: false,
    knownVehicleAccess: false,
    reviewedStrategicPriority: false,
    anticipatedAwardDate: FAR_AWARD,
    asOf: ASOF,
    ...over,
  };
}

describe('vocabularies', () => {
  test('the forecast recommendation is exactly the four the plan names', () => {
    expect([...FORECAST_RECOMMENDATIONS]).toEqual(['shape_now', 'monitor', 'pass', 'needs_review']);
  });

  test('every reason code a rule can emit is in the declared vocabulary', () => {
    const declared = new Set<string>(FORECAST_REASON_CODES);
    const cases: ForecastRelevanceInput[] = [
      input({ isActive: false }),
      input({ profileTooThin: true }),
      input(),
      input({ anticipatedAwardDate: APPROACHING_AWARD }),
      input({ exactNaicsMatch: true }),
      input({ exactPscMatch: true }),
      input({ capabilityMatch: true }),
      input({ programElementLinkedSourceBacked: true }),
      input({ locationMatch: true }),
      input({ knownVehicleAccess: true }),
      input({ reviewedStrategicPriority: true }),
      input({ exactNaicsMatch: true, priorAgencyHistory: true, knownVehicleAccess: true, anticipatedAwardDate: APPROACHING_AWARD }),
    ];
    for (const c of cases) {
      for (const code of scoreForecastRelevance(c).reasonCodes) {
        expect(declared.has(code)).toBe(true);
      }
    }
  });
});

describe('rule 1: an inactive forecast is always pass, regardless of any other signal', () => {
  test('inactive beats even a strong match', () => {
    const r = scoreForecastRelevance(
      input({ isActive: false, exactNaicsMatch: true, priorAgencyHistory: true, knownVehicleAccess: true }),
    );
    expect(r.forecastRecommendation).toBe('pass');
    expect(r.machineRecommendation).toBe('pass');
    expect(r.reasonCodes).toEqual(['forecast_inactive']);
  });
});

describe('rule 2: profile too thin is needs_review', () => {
  test('needs_review, even with signals present', () => {
    const r = scoreForecastRelevance(input({ profileTooThin: true, exactNaicsMatch: true }));
    expect(r.forecastRecommendation).toBe('needs_review');
    expect(r.machineRecommendation).toBe('needs_review');
  });
});

describe('acceptance: a generic agency forecast with no client evidence cannot surface', () => {
  test('zero signals -> pass, never shape_now, never monitor', () => {
    const r = scoreForecastRelevance(input());
    expect(r.forecastRecommendation).toBe('pass');
    expect(r.reasonCodes).toEqual(['no_client_evidence']);
  });

  test('an approaching award date ALONE is not evidence — still pass, not fabricated urgency standing in for a real signal', () => {
    const r = scoreForecastRelevance(input({ anticipatedAwardDate: APPROACHING_AWARD }));
    expect(r.forecastRecommendation).toBe('pass');
  });
});

describe('acceptance: an exact program/capability match CAN surface, with an early-action reason', () => {
  test.each([
    ['exact NAICS match', { exactNaicsMatch: true }, 'exact_naics_match'],
    ['exact PSC match', { exactPscMatch: true }, 'exact_psc_match'],
    ['capability match', { capabilityMatch: true }, 'capability_match'],
    ['a source-backed PE link', { programElementLinkedSourceBacked: true }, 'program_element_linked'],
  ] as Array<[string, Partial<ForecastRelevanceInput>, string]>)('%s alone -> shape_now', (_label, partial, code) => {
    const r = scoreForecastRelevance(input(partial));
    expect(r.forecastRecommendation).toBe('shape_now');
    expect(r.machineRecommendation).toBe('monitor'); // never 'pursue' — see opportunity-recommendation.ts's own doc
    expect(r.reasonCodes).toContain(code);
    expect(r.recommendedNextAction.length).toBeGreaterThan(0);
  });

  test('weaker evidence alone (location, vehicle access, or strategic priority) is monitor, not shape_now', () => {
    for (const partial of [{ locationMatch: true }, { knownVehicleAccess: true }, { reviewedStrategicPriority: true }]) {
      const r = scoreForecastRelevance(input(partial));
      expect(r.forecastRecommendation).toBe('monitor');
    }
  });
});

describe('confidence: high needs BOTH a strong match and (prior history OR vehicle access)', () => {
  test('strong match + prior agency history -> high', () => {
    const r = scoreForecastRelevance(input({ exactNaicsMatch: true, priorAgencyHistory: true }));
    expect(r.recommendationConfidence).toBe('high');
  });

  test('strong match + known vehicle access (no prior history) -> still high', () => {
    const r = scoreForecastRelevance(input({ exactNaicsMatch: true, knownVehicleAccess: true }));
    expect(r.recommendationConfidence).toBe('high');
    expect(r.primaryRisk).toBeNull();
  });

  test('strong match alone, no history, no vehicle access -> medium, and the risk names the missing vehicle access', () => {
    const r = scoreForecastRelevance(input({ exactNaicsMatch: true }));
    expect(r.recommendationConfidence).toBe('medium');
    expect(r.primaryRisk).toMatch(/vehicle/i);
  });
});

describe('acceptance: no response deadline is ever fabricated', () => {
  test('the anticipated award date only affects WORDING, never the recommendation itself, when there is no real evidence', () => {
    const withDate = scoreForecastRelevance(input({ anticipatedAwardDate: APPROACHING_AWARD }));
    const withoutDate = scoreForecastRelevance(input({ anticipatedAwardDate: null }));
    expect(withDate.forecastRecommendation).toBe(withoutDate.forecastRecommendation);
  });

  test('an approaching award date adds urgency wording to a shape_now action; a far-out or absent one does not', () => {
    const approaching = scoreForecastRelevance(input({ exactNaicsMatch: true, anticipatedAwardDate: APPROACHING_AWARD }));
    const far = scoreForecastRelevance(input({ exactNaicsMatch: true, anticipatedAwardDate: FAR_AWARD }));
    const absent = scoreForecastRelevance(input({ exactNaicsMatch: true, anticipatedAwardDate: null }));
    expect(approaching.recommendedNextAction).toMatch(/anticipated award estimate/i);
    expect(far.recommendedNextAction).not.toMatch(/anticipated award estimate/i);
    expect(absent.recommendedNextAction).not.toMatch(/anticipated award estimate/i);
  });

  test('a PAST anticipated award date is not "approaching" — it does not add urgency wording', () => {
    const r = scoreForecastRelevance(input({ exactNaicsMatch: true, anticipatedAwardDate: PAST_AWARD }));
    expect(r.recommendedNextAction).not.toMatch(/anticipated award estimate/i);
  });

  test('the word "deadline" never appears anywhere in the output, on any branch', () => {
    const cases: ForecastRelevanceInput[] = [
      input({ isActive: false }),
      input({ profileTooThin: true }),
      input(),
      input({ exactNaicsMatch: true, anticipatedAwardDate: APPROACHING_AWARD }),
      input({ locationMatch: true }),
    ];
    for (const c of cases) {
      const r = scoreForecastRelevance(c);
      const text = `${r.primaryReason} ${r.primaryRisk ?? ''} ${r.recommendedNextAction}`.toLowerCase();
      expect(text).not.toContain('deadline');
    }
  });

  test(`APPROACHING_AWARD_DAYS (${APPROACHING_AWARD_DAYS}) is far wider than an active solicitation's imminent window — shaping a capture takes months`, () => {
    expect(APPROACHING_AWARD_DAYS).toBeGreaterThanOrEqual(60);
  });
});

describe('no eligibility state is inferred from a forecast', () => {
  test('no result carries an eligibility-shaped field, and no output text uses an eligibility word', () => {
    const cases: ForecastRelevanceInput[] = [
      input(),
      input({ exactNaicsMatch: true }),
      input({ isActive: false }),
      input({ profileTooThin: true }),
    ];
    for (const c of cases) {
      const r = scoreForecastRelevance(c);
      expect(r).not.toHaveProperty('eligibility');
      expect(r).not.toHaveProperty('eligibilityState');
      const text = `${r.primaryReason} ${r.primaryRisk ?? ''} ${r.recommendedNextAction}`.toLowerCase();
      expect(text).not.toMatch(/\beligible\b|\bineligible\b/);
    }
  });
});

describe('acceptance: the recommendation is stable — same input, same output', () => {
  test('calling twice with an identical input produces an identical result', () => {
    const i = input({ exactPscMatch: true, priorAgencyHistory: true, anticipatedAwardDate: APPROACHING_AWARD });
    expect(scoreForecastRelevance(i)).toEqual(scoreForecastRelevance(i));
  });

  test('re-sorting which signals are true does not change the outcome — only which signals ARE true does', () => {
    const a = scoreForecastRelevance(input({ exactNaicsMatch: true, locationMatch: true }));
    const b = scoreForecastRelevance(input({ locationMatch: true, exactNaicsMatch: true }));
    expect(a).toEqual(b);
  });
});

describe('every combination produces a valid, invariant-respecting result', () => {
  test('the full cross-product', () => {
    const forecastRecs = new Set<string>(FORECAST_RECOMMENDATIONS);
    const machineRecs = new Set<string>(MACHINE_RECOMMENDATIONS);
    const confs = new Set<string>(RECOMMENDATION_CONFIDENCES);
    let count = 0;

    for (const isActive of [true, false, null]) {
      for (const profileTooThin of [true, false]) {
        for (const exactNaicsMatch of [true, false]) {
          for (const knownVehicleAccess of [true, false]) {
            for (const priorAgencyHistory of [true, false]) {
              for (const anticipatedAwardDate of [FAR_AWARD, APPROACHING_AWARD, null]) {
                const r = scoreForecastRelevance(
                  input({ isActive, profileTooThin, exactNaicsMatch, knownVehicleAccess, priorAgencyHistory, anticipatedAwardDate }),
                );
                count += 1;
                expect(forecastRecs.has(r.forecastRecommendation)).toBe(true);
                expect(machineRecs.has(r.machineRecommendation)).toBe(true);
                expect(confs.has(r.recommendationConfidence)).toBe(true);
                expect(r.primaryReason.length).toBeGreaterThan(0);
                expect(r.recommendedNextAction.length).toBeGreaterThan(0);

                // The invariant that carries this whole phase: NEVER 'pursue'.
                expect(r.machineRecommendation).not.toBe('pursue');
                // isActive === false always wins, regardless of every other input.
                if (isActive === false) {
                  expect(r.forecastRecommendation).toBe('pass');
                }
              }
            }
          }
        }
      }
    }
    // 3*2*2*2*2*3 — asserted so a collapsed loop cannot silently shrink the sweep.
    expect(count).toBe(3 * 2 * 2 * 2 * 2 * 3);
  });
});
