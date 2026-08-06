import { describe, expect, test } from '@jest/globals';
import {
  IMMINENT_DEADLINE_DAYS,
  MACHINE_RECOMMENDATIONS,
  RECOMMENDATION_CONFIDENCES,
  RECOMMENDATION_REASON_CODES,
  recommendOpportunity,
  type RecommendationInput,
} from './opportunity-recommendation.js';
import { ELIGIBILITY_STATES, OPPORTUNITY_KINDS } from './funding-opportunities.types.js';

/**
 * P06 — the recommendation truth table.
 *
 * The two invariants the plan states outright get their own tests and are also
 * swept across every combination below, because they are the ones a later phase is
 * most likely to break by adding a rule in the wrong place:
 *
 *   - a closed or informational notice can NEVER be `pursue`;
 *   - strong relevance with unresolved eligibility is `needs_review`, not `pursue`.
 */

const ASOF = new Date('2026-08-06T00:00:00.000Z');
const FAR = '2027-01-15T00:00:00.000Z';
const SOON = '2026-08-12T00:00:00.000Z'; // 6 days out
const PAST = '2026-07-01T00:00:00.000Z';

function input(over: Partial<RecommendationInput> = {}): RecommendationInput {
  return {
    source: 'sam_gov',
    kind: 'solicitation',
    isActive: true,
    isPursuable: true,
    responseDeadline: FAR,
    relevanceScore: 60,
    signalStrengths: ['strong'],
    signalKeys: ['naicsExact'],
    eligibility: 'eligible',
    profileTooThin: false,
    asOf: ASOF,
    ...over,
  };
}

// ── Vocabularies ────────────────────────────────────────────────────────────

describe('the vocabularies are bounded', () => {
  test('recommendations are exactly the four the plan names', () => {
    expect([...MACHINE_RECOMMENDATIONS]).toEqual(['pursue', 'monitor', 'pass', 'needs_review']);
  });

  test('confidence is evidence quality, expressed in three bands', () => {
    expect([...RECOMMENDATION_CONFIDENCES]).toEqual(['high', 'medium', 'low']);
  });

  test('every reason code a rule can emit is in the declared vocabulary', () => {
    // Bounded so the web mirror can label everything it will ever receive. An
    // unlabelled code renders as its own machine key, which is the thing P09 exists
    // to remove.
    const declared = new Set<string>(RECOMMENDATION_REASON_CODES);
    const cases: RecommendationInput[] = [
      input({ isActive: false }),
      input({ isPursuable: false, kind: 'award_notice' }),
      input({ eligibility: 'ineligible' }),
      input({ profileTooThin: true }),
      input({ eligibility: 'needs_review' }),
      input({ eligibility: 'unknown' }),
      input({ signalStrengths: [], signalKeys: [] }),
      input({ signalStrengths: ['weak'], signalKeys: ['genericToken'] }),
      input({ signalStrengths: ['moderate', 'moderate'], signalKeys: ['naicsGroup', 'pscGroup'] }),
      input({ signalKeys: ['naicsExact', 'priorAgency'] }),
      input({ responseDeadline: SOON }),
      input({ responseDeadline: null }),
    ];
    for (const c of cases) {
      for (const code of recommendOpportunity(c).reasonCodes) {
        expect(declared.has(code)).toBe(true);
      }
    }
  });

  test('no reason code is emitted twice for one opportunity', () => {
    const result = recommendOpportunity(input({ responseDeadline: SOON, signalKeys: ['naicsExact', 'priorAgency'] }));
    expect(new Set(result.reasonCodes).size).toBe(result.reasonCodes.length);
  });
});

// ── The two hard invariants ─────────────────────────────────────────────────

describe('a closed or informational notice can never be pursue', () => {
  test('a closed notice is pass, even with perfect evidence', () => {
    const r = recommendOpportunity(
      input({ isActive: false, signalStrengths: ['strong', 'strong'], signalKeys: ['naicsExact', 'priorAgency'] }),
    );
    expect(r.machineRecommendation).toBe('pass');
    expect(r.reasonCodes).toContain('source_closed');
  });

  test.each([...OPPORTUNITY_KINDS])('an informational %s notice is monitor, never pursue', (kind) => {
    const r = recommendOpportunity(
      input({ kind, isPursuable: false, signalStrengths: ['strong'], signalKeys: ['naicsExact'] }),
    );
    expect(r.machineRecommendation).toBe('monitor');
    expect(r.reasonCodes).toContain('informational_notice');
  });

  test('closed OUTRANKS informational, so precedence is total not accidental', () => {
    // Both conditions hold. Written as independent ifs the answer would depend on
    // which check happened to be first, and no reviewer could tell which was meant.
    const r = recommendOpportunity(input({ isActive: false, isPursuable: false, kind: 'award_notice' }));
    expect(r.machineRecommendation).toBe('pass');
    expect(r.reasonCodes).toEqual(['source_closed']);
  });

  test('closed OUTRANKS ineligible', () => {
    const r = recommendOpportunity(input({ isActive: false, eligibility: 'ineligible' }));
    expect(r.reasonCodes).toEqual(['source_closed']);
  });
});

describe('strong relevance with unresolved eligibility is needs_review, not pursue', () => {
  test.each(['needs_review', 'unknown'] as const)(
    'eligibility %s with a strong match is needs_review',
    (eligibility) => {
      const r = recommendOpportunity(
        input({ eligibility, signalStrengths: ['strong', 'strong'], signalKeys: ['naicsExact', 'priorAgency'] }),
      );
      expect(r.machineRecommendation).toBe('needs_review');
      // Medium, not high: the fit is strong, the open question is permission.
      expect(r.recommendationConfidence).toBe('medium');
      expect(r.recommendedNextAction).toMatch(/Resolve eligibility/);
    },
  );

  test('ineligible is pass, not needs_review — it is a resolved answer', () => {
    const r = recommendOpportunity(input({ eligibility: 'ineligible' }));
    expect(r.machineRecommendation).toBe('pass');
  });

  test('unresolved eligibility with weak evidence is low confidence', () => {
    const r = recommendOpportunity(
      input({ eligibility: 'needs_review', signalStrengths: ['weak'], signalKeys: ['genericToken'] }),
    );
    expect(r.machineRecommendation).toBe('needs_review');
    expect(r.recommendationConfidence).toBe('low');
  });
});

// ── The full table ──────────────────────────────────────────────────────────

describe('the evidence floor decides pursue vs monitor vs pass', () => {
  test('one strong signal clears the floor', () => {
    const r = recommendOpportunity(input({ signalStrengths: ['strong'], signalKeys: ['naicsExact'] }));
    expect(r.machineRecommendation).toBe('pursue');
  });

  test('two moderate signals clear the floor, but only to monitor', () => {
    const r = recommendOpportunity({
      ...input(),
      signalStrengths: ['moderate', 'moderate'],
      signalKeys: ['naicsGroup', 'pscGroup'],
    });
    expect(r.machineRecommendation).toBe('monitor');
    expect(r.reasonCodes).toContain('moderate_capability_match');
  });

  test('ONE moderate signal does not clear the floor', () => {
    const r = recommendOpportunity({
      ...input(),
      signalStrengths: ['moderate'],
      signalKeys: ['naicsGroup'],
    });
    expect(r.machineRecommendation).toBe('pass');
    expect(r.reasonCodes).toContain('below_evidence_floor');
  });

  test('a pile of weak signals never clears the floor, whatever the score', () => {
    // The specific failure this guards: generic tokens ("systems", "services")
    // accumulating past a numeric threshold without amounting to evidence.
    const r = recommendOpportunity({
      ...input(),
      relevanceScore: 99,
      signalStrengths: ['weak', 'weak', 'weak', 'weak', 'weak', 'weak'],
      signalKeys: ['genericToken'],
    });
    expect(r.machineRecommendation).toBe('pass');
    expect(r.reasonCodes).toContain('below_evidence_floor');
  });

  test('no signals at all is pass at high confidence', () => {
    const r = recommendOpportunity(input({ signalStrengths: [], signalKeys: [], relevanceScore: 0 }));
    expect(r.machineRecommendation).toBe('pass');
    expect(r.recommendationConfidence).toBe('high');
  });

  test('relevanceScore alone never decides anything', () => {
    // Two inputs identical except for the score produce the same recommendation.
    const low = recommendOpportunity(input({ relevanceScore: 1 }));
    const high = recommendOpportunity(input({ relevanceScore: 100 }));
    expect(low.machineRecommendation).toBe(high.machineRecommendation);
    expect(low.recommendationConfidence).toBe(high.recommendationConfidence);
  });
});

describe('confidence is evidence quality, not a win probability', () => {
  test('a strong match WITH agency history is high', () => {
    const r = recommendOpportunity(input({ signalKeys: ['naicsExact', 'priorAgency'] }));
    expect(r.machineRecommendation).toBe('pursue');
    expect(r.recommendationConfidence).toBe('high');
    expect(r.reasonCodes).toContain('prior_agency_award_history');
  });

  test('a strong match WITHOUT agency history is only medium', () => {
    // One exact code match is real evidence but a thin basis for committing bid
    // effort, and saying "high" would overstate what is known.
    const r = recommendOpportunity(input({ signalKeys: ['naicsExact'] }));
    expect(r.machineRecommendation).toBe('pursue');
    expect(r.recommendationConfidence).toBe('medium');
    expect(r.reasonCodes).toContain('no_award_history_evidence');
  });

  test('a high-confidence PASS exists, and is not a contradiction', () => {
    // Proof that confidence is not a win rate: this is a confident recommendation
    // NOT to bid.
    const r = recommendOpportunity(input({ eligibility: 'ineligible' }));
    expect(r.machineRecommendation).toBe('pass');
    expect(r.recommendationConfidence).toBe('high');
  });

  test('a thin profile is always low confidence', () => {
    const r = recommendOpportunity(
      input({ profileTooThin: true, signalStrengths: ['strong'], signalKeys: ['naicsExact'] }),
    );
    expect(r.machineRecommendation).toBe('needs_review');
    expect(r.recommendationConfidence).toBe('low');
    expect(r.reasonCodes).toContain('client_profile_too_thin');
  });

  test('a thin profile OUTRANKS unresolved eligibility', () => {
    const r = recommendOpportunity(input({ profileTooThin: true, eligibility: 'needs_review' }));
    expect(r.reasonCodes).toContain('client_profile_too_thin');
    expect(r.reasonCodes).not.toContain('eligibility_needs_review');
  });
});

// ── Determinism ─────────────────────────────────────────────────────────────

describe('the recommendation is deterministic', () => {
  test('it is stable under signal ORDER', () => {
    // Reduced to a tally and a key set on purpose. If any rule read
    // `signalStrengths[0]`, re-sorting the array would change the answer.
    const a = recommendOpportunity({
      ...input(),
      signalStrengths: ['weak', 'moderate', 'strong'],
      signalKeys: ['genericToken', 'naicsGroup', 'naicsExact'],
    });
    const b = recommendOpportunity({
      ...input(),
      signalStrengths: ['strong', 'weak', 'moderate'],
      signalKeys: ['naicsExact', 'genericToken', 'naicsGroup'],
    });
    expect(b).toEqual(a);
  });

  test('the same input twice gives byte-identical output', () => {
    expect(JSON.stringify(recommendOpportunity(input()))).toBe(
      JSON.stringify(recommendOpportunity(input())),
    );
  });

  test('it reads the supplied asOf, never the wall clock', () => {
    // Same opportunity, two different clocks: the deadline is imminent under one
    // and not the other. If the module called new Date() this would be untestable
    // and the output would drift daily.
    const before = recommendOpportunity(input({ responseDeadline: SOON, asOf: new Date('2026-07-01T00:00:00.000Z') }));
    const near = recommendOpportunity(input({ responseDeadline: SOON, asOf: ASOF }));
    expect(before.reasonCodes).not.toContain('deadline_imminent');
    expect(near.reasonCodes).toContain('deadline_imminent');
  });

  test('a deadline exactly on the boundary is imminent', () => {
    const at = new Date(ASOF.getTime() + IMMINENT_DEADLINE_DAYS * 86_400_000).toISOString();
    expect(recommendOpportunity(input({ responseDeadline: at })).reasonCodes).toContain(
      'deadline_imminent',
    );
  });

  test('a deadline one day past the boundary is not', () => {
    const at = new Date(ASOF.getTime() + (IMMINENT_DEADLINE_DAYS + 1) * 86_400_000).toISOString();
    expect(recommendOpportunity(input({ responseDeadline: at })).reasonCodes).not.toContain(
      'deadline_imminent',
    );
  });

  test('an unparseable deadline is treated as no deadline, not as imminent', () => {
    // Failing open here would mark every malformed row urgent.
    const r = recommendOpportunity(input({ responseDeadline: 'not-a-date' }));
    expect(r.reasonCodes).not.toContain('deadline_imminent');
  });

  test('a past deadline on a still-active notice is not called imminent', () => {
    // Negative days are not "0 days left". `isActive` is the source's own answer
    // and this module does not second-guess it, but it must not invent urgency.
    const r = recommendOpportunity(input({ responseDeadline: PAST }));
    expect(r.reasonCodes).not.toContain('deadline_imminent');
  });

  test('no output text contains a raw camelCase signal key', () => {
    // P09 renders these strings. A machine key leaking into prose is the exact
    // thing that phase removes, so it must not be introduced here.
    for (const eligibility of ELIGIBILITY_STATES) {
      for (const thin of [true, false]) {
        const r = recommendOpportunity(input({ eligibility, profileTooThin: thin }));
        for (const text of [r.primaryReason, r.primaryRisk ?? '', r.recommendedNextAction]) {
          expect(text).not.toMatch(/[a-z][A-Z]/);
        }
      }
    }
  });
});

// ── Risk is always named where one exists ───────────────────────────────────

describe('primaryRisk', () => {
  test('a pursue still names its strongest objection', () => {
    // A recommendation with no stated risk reads as unqualified, which is how a
    // team ends up surprised by something the data already knew.
    const r = recommendOpportunity(input({ responseDeadline: SOON, signalKeys: ['naicsExact'] }));
    expect(r.machineRecommendation).toBe('pursue');
    expect(r.primaryRisk).toMatch(/deadline is 6 days away/);
  });

  test('a strong match with history and a distant deadline has no risk to name', () => {
    const r = recommendOpportunity(input({ signalKeys: ['naicsExact', 'priorAgency'] }));
    expect(r.primaryRisk).toBeNull();
  });

  test('a missing deadline is named as a risk, not silently ignored', () => {
    const r = recommendOpportunity(input({ responseDeadline: null }));
    expect(r.primaryRisk).toMatch(/no response deadline/);
    expect(r.reasonCodes).toContain('deadline_not_stated');
  });

  test('a closed notice names no risk — there is nothing left to risk', () => {
    expect(recommendOpportunity(input({ isActive: false })).primaryRisk).toBeNull();
  });

  test('one day reads "1 day", not "1 days"', () => {
    const at = new Date(ASOF.getTime() + 86_400_000).toISOString();
    const r = recommendOpportunity(input({ responseDeadline: at }));
    expect(r.primaryRisk).toContain('1 day away');
    expect(r.primaryRisk).not.toContain('1 days');
  });
});

// ── Exhaustive sweep ────────────────────────────────────────────────────────

describe('every combination produces a valid, invariant-respecting result', () => {
  test('the full cross-product', () => {
    const recs = new Set<string>(MACHINE_RECOMMENDATIONS);
    const confs = new Set<string>(RECOMMENDATION_CONFIDENCES);
    let count = 0;

    for (const isActive of [true, false]) {
      for (const isPursuable of [true, false]) {
        for (const eligibility of ELIGIBILITY_STATES) {
          for (const profileTooThin of [true, false]) {
            for (const deadline of [FAR, SOON, null, PAST]) {
              for (const strengths of [
                [],
                ['weak'],
                ['moderate'],
                ['moderate', 'moderate'],
                ['strong'],
                ['strong', 'moderate'],
              ] as Array<Array<'strong' | 'moderate' | 'weak'>>) {
                for (const keys of [['naicsExact'], ['naicsExact', 'priorAgency'], []]) {
                  const r = recommendOpportunity(
                    input({
                      isActive,
                      isPursuable,
                      eligibility,
                      profileTooThin,
                      responseDeadline: deadline,
                      signalStrengths: strengths,
                      signalKeys: keys,
                    }),
                  );
                  count += 1;

                  expect(recs.has(r.machineRecommendation)).toBe(true);
                  expect(confs.has(r.recommendationConfidence)).toBe(true);
                  expect(r.primaryReason.length).toBeGreaterThan(0);
                  expect(r.recommendedNextAction.length).toBeGreaterThan(0);
                  expect(r.reasonCodes.length).toBeGreaterThan(0);

                  // The two invariants, on every single row of the table.
                  if (!isActive || !isPursuable) {
                    expect(r.machineRecommendation).not.toBe('pursue');
                  }
                  if (isActive && isPursuable && eligibility !== 'eligible') {
                    expect(r.machineRecommendation).not.toBe('pursue');
                  }
                }
              }
            }
          }
        }
      }
    }
    // 2*2*4*2*4*6*3 — asserted so a collapsed loop cannot silently shrink the sweep.
    expect(count).toBe(2 * 2 * 4 * 2 * 4 * 6 * 3);
  });
});
