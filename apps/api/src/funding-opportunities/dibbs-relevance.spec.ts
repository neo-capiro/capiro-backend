import { describe, expect, test } from '@jest/globals';
import {
  DIBBS_IMMINENT_CLOSING_DAYS,
  DIBBS_PART_PROFILE_GAPS,
  DIBBS_REASON_CODES,
  describeDibbsAwardIntelligence,
  scoreDibbsRelevance,
  type DibbsRelevanceInput,
} from './dibbs-relevance.js';
import { MACHINE_RECOMMENDATIONS, RECOMMENDATION_CONFIDENCES } from './opportunity-recommendation.js';

/**
 * P41 — the DIBBS bid-board truth table.
 *
 * P41's acceptance, stated as tests:
 *   - exact part/NSN is strong; generic manufacturing terms are weak;
 *   - awards never offer Pursue;
 *   - unknown quantity/value remains unknown;
 *   - cross-client part data does not leak.
 *
 * The last one is worth being precise about, because it is easy to test the
 * wrong thing. This module is pure and holds no client data at all: it receives
 * booleans a caller established. So the leak it CAN be tested for is that the
 * output never carries another party's identifiers — specifically that an award
 * belonging to a different supplier is not described as the client's, and that
 * a CAGE comparison cannot succeed on an empty or whitespace client CAGE, which
 * would make every award with a blank awardee "the client's own".
 */

const ASOF = new Date('2026-08-08T00:00:00.000Z');
const FAR_CLOSE = '2026-10-01T00:00:00.000Z'; // ~54 days out
const IMMINENT_CLOSE = '2026-08-12T00:00:00.000Z'; // 4 days out
const PAST_CLOSE = '2026-07-01T00:00:00.000Z';

function input(over: Partial<DibbsRelevanceInput> = {}): DibbsRelevanceInput {
  return {
    documentType: 'rfq',
    isOpen: true,
    closesDate: FAR_CLOSE,
    profileTooThin: false,
    exactNsnMatch: false,
    exactPartNumberMatch: false,
    priorCageAwardHistory: false,
    buyerHistory: false,
    capabilityTextMatch: false,
    clientHasRecordedParts: false,
    asOf: ASOF,
    ...over,
  };
}

describe('P41 scoreDibbsRelevance — the acceptance bar', () => {
  test('an exact NSN match is strong: it reaches pursue and clears the suggestion floor', () => {
    const result = scoreDibbsRelevance(input({ exactNsnMatch: true, clientHasRecordedParts: true }));

    expect(result.machineRecommendation).toBe('pursue');
    expect(result.clearsSuggestionFloor).toBe(true);
    expect(result.reasonCodes).toContain('exact_nsn_match');
  });

  test('an exact part-number match is strong in the same way', () => {
    const result = scoreDibbsRelevance(input({ exactPartNumberMatch: true, clientHasRecordedParts: true }));

    expect(result.machineRecommendation).toBe('pursue');
    expect(result.clearsSuggestionFloor).toBe(true);
  });

  test('capability text ALONE is weak: it never reaches pursue and never clears the floor', () => {
    const result = scoreDibbsRelevance(input({ capabilityTextMatch: true }));

    expect(result.machineRecommendation).toBe('monitor');
    expect(result.clearsSuggestionFloor).toBe(false);
    expect(result.reasonCodes).toContain('capability_text_match');
    // The reason must say WHY it is weak, not merely that it matched.
    expect(result.primaryReason).toMatch(/vocabulary match/i);
  });

  test('capability text plus an imminent close is still weak — a deadline is not evidence', () => {
    const result = scoreDibbsRelevance(input({ capabilityTextMatch: true, closesDate: IMMINENT_CLOSE }));

    expect(result.machineRecommendation).toBe('monitor');
    expect(result.clearsSuggestionFloor).toBe(false);
  });

  test('a prior award to the client\'s own CAGE is strong on its own', () => {
    const result = scoreDibbsRelevance(input({ priorCageAwardHistory: true }));

    expect(result.machineRecommendation).toBe('pursue');
    expect(result.clearsSuggestionFloor).toBe(true);
    expect(result.reasonCodes).toContain('prior_cage_award_history');
  });

  test('part-level evidence AND prior CAGE history together raise confidence to high', () => {
    const medium = scoreDibbsRelevance(input({ exactNsnMatch: true, clientHasRecordedParts: true }));
    const high = scoreDibbsRelevance(
      input({ exactNsnMatch: true, priorCageAwardHistory: true, clientHasRecordedParts: true }),
    );

    expect(medium.recommendationConfidence).toBe('medium');
    expect(high.recommendationConfidence).toBe('high');
  });

  test('no evidence at all cannot surface: pass, floor not cleared', () => {
    const result = scoreDibbsRelevance(input());

    expect(result.machineRecommendation).toBe('pass');
    expect(result.clearsSuggestionFloor).toBe(false);
    expect(result.reasonCodes).toEqual(['no_client_evidence']);
  });

  test('an imminent close with no other evidence is still pass — every open item has a date', () => {
    const result = scoreDibbsRelevance(input({ closesDate: IMMINENT_CLOSE }));

    expect(result.machineRecommendation).toBe('pass');
    expect(result.reasonCodes).toContain('closing_imminent');
    expect(result.reasonCodes).not.toContain('no_client_evidence');
  });
});

describe('P41 closed items', () => {
  test('the provider saying closed closes it, even with strong evidence', () => {
    const result = scoreDibbsRelevance(input({ isOpen: false, exactNsnMatch: true, clientHasRecordedParts: true }));

    expect(result.machineRecommendation).toBe('pass');
    expect(result.clearsSuggestionFloor).toBe(false);
    expect(result.reasonCodes).toEqual(['solicitation_closed']);
  });

  test('a genuinely past closing date closes it even while the provider still says open', () => {
    const result = scoreDibbsRelevance(input({ isOpen: true, closesDate: PAST_CLOSE, exactNsnMatch: true }));

    expect(result.machineRecommendation).toBe('pass');
    expect(result.reasonCodes).toEqual(['solicitation_closed']);
  });

  test('a null isOpen is NOT treated as closed — an absent statement is not a closure', () => {
    const result = scoreDibbsRelevance(input({ isOpen: null, exactNsnMatch: true, clientHasRecordedParts: true }));

    expect(result.machineRecommendation).toBe('pursue');
  });

  test('a null closing date is not a closure either', () => {
    const result = scoreDibbsRelevance(input({ closesDate: null, priorCageAwardHistory: true }));

    expect(result.machineRecommendation).toBe('pursue');
  });
});

describe('P41 the part/NSN profile gap is reported, not scored as a failed match', () => {
  test('a client with no recorded parts gets the gap, on every rule path', () => {
    const paths = [
      input(),
      input({ isOpen: false }),
      input({ profileTooThin: true }),
      input({ capabilityTextMatch: true }),
      input({ priorCageAwardHistory: true }),
    ];

    for (const candidate of paths) {
      expect(scoreDibbsRelevance(candidate).dibbsPartProfileGap).toBe('no_client_parts_recorded');
    }
  });

  test('a client WITH recorded parts has no gap', () => {
    expect(scoreDibbsRelevance(input({ clientHasRecordedParts: true })).dibbsPartProfileGap).toBeNull();
  });

  test('the gap changes the next action to name the missing data, not to blame the match', () => {
    const withGap = scoreDibbsRelevance(input());
    const withoutGap = scoreDibbsRelevance(input({ clientHasRecordedParts: true }));

    expect(withGap.recommendedNextAction).toMatch(/part numbers/i);
    expect(withoutGap.recommendedNextAction).not.toMatch(/part numbers/i);
  });

  test('the gap is never itself a reason code — an absence of data is not evidence', () => {
    const result = scoreDibbsRelevance(input({ capabilityTextMatch: true }));

    for (const code of result.reasonCodes) {
      expect(DIBBS_PART_PROFILE_GAPS).not.toContain(code as never);
    }
  });
});

describe('P41 awards never offer Pursue', () => {
  test('the award path exposes no recommendation field at all', () => {
    const award = describeDibbsAwardIntelligence({
      awardeeCage: '1ABC5',
      awardeeCageCode: '1ABC5',
      clientCageCode: '1ABC5',
      awardeeLegalBusinessName: 'Example Precision LLC',
      totalContractPrice: '12500.00',
    });

    // Structural, not a value assertion: there is no field to put a Pursue in.
    expect(award).not.toHaveProperty('machineRecommendation');
    expect(award).not.toHaveProperty('recommendedNextAction');
    expect(award).not.toHaveProperty('clearsSuggestionFloor');
    expect(Object.keys(award).sort()).toEqual(['isOwnAward', 'priceIsUnknown', 'summary']);
  });

  test('scoreDibbsRelevance admits only rfq and rfp document types', () => {
    // The type system is the real guarantee; this pins the runtime vocabulary
    // so widening it becomes a deliberate, visible change.
    const rfq = scoreDibbsRelevance(input({ documentType: 'rfq', priorCageAwardHistory: true }));
    const rfp = scoreDibbsRelevance(input({ documentType: 'rfp', priorCageAwardHistory: true }));

    expect(rfq.recommendedNextAction).toMatch(/quote/i);
    expect(rfp.recommendedNextAction).toMatch(/proposal/i);
  });
});

describe('P41 unknown stays unknown, and cross-client data does not leak', () => {
  test('a null award price is reported unknown, never zero', () => {
    const award = describeDibbsAwardIntelligence({
      awardeeCage: '1ABC5',
      awardeeCageCode: null,
      clientCageCode: '1ABC5',
      awardeeLegalBusinessName: 'Example Precision LLC',
      totalContractPrice: null,
    });

    expect(award.priceIsUnknown).toBe(true);
    expect(award.summary).toMatch(/states no award price/i);
    expect(award.summary).not.toMatch(/\$?0(\.00)?\b/);
  });

  test('an empty-string price is unknown too', () => {
    const award = describeDibbsAwardIntelligence({
      awardeeCage: null,
      awardeeCageCode: null,
      clientCageCode: '1ABC5',
      awardeeLegalBusinessName: null,
      totalContractPrice: '',
    });

    expect(award.priceIsUnknown).toBe(true);
  });

  test("another supplier's award is never described as the client's", () => {
    const award = describeDibbsAwardIntelligence({
      awardeeCage: '9XYZ1',
      awardeeCageCode: '9XYZ1',
      clientCageCode: '1ABC5',
      awardeeLegalBusinessName: 'Some Other Machining Co',
      totalContractPrice: '900.00',
    });

    expect(award.isOwnAward).toBe(false);
    expect(award.summary).toMatch(/Some Other Machining Co/);
    expect(award.summary).not.toMatch(/This client/);
  });

  test('a blank or absent client CAGE never matches an award with a blank awardee', () => {
    for (const clientCageCode of [null, '', '   ']) {
      const award = describeDibbsAwardIntelligence({
        awardeeCage: null,
        awardeeCageCode: '',
        clientCageCode,
        awardeeLegalBusinessName: null,
        totalContractPrice: '10.00',
      });

      expect(award.isOwnAward).toBe(false);
    }
  });

  test('either provider CAGE field can establish the match, and neither is derived from the other', () => {
    const viaTopLevel = describeDibbsAwardIntelligence({
      awardeeCage: '1ABC5',
      awardeeCageCode: null,
      clientCageCode: '1abc5',
      awardeeLegalBusinessName: null,
      totalContractPrice: '10.00',
    });
    const viaNested = describeDibbsAwardIntelligence({
      awardeeCage: null,
      awardeeCageCode: '1ABC5',
      clientCageCode: ' 1ABC5 ',
      awardeeLegalBusinessName: null,
      totalContractPrice: '10.00',
    });

    expect(viaTopLevel.isOwnAward).toBe(true);
    expect(viaNested.isOwnAward).toBe(true);
  });

  test('an unnamed other supplier does not become the client', () => {
    const award = describeDibbsAwardIntelligence({
      awardeeCage: '9XYZ1',
      awardeeCageCode: null,
      clientCageCode: '1ABC5',
      awardeeLegalBusinessName: null,
      totalContractPrice: null,
    });

    expect(award.isOwnAward).toBe(false);
    expect(award.summary).toMatch(/Another supplier/);
  });
});

describe('P41 contract stability', () => {
  test('every reason code the scorer can emit is in the declared vocabulary', () => {
    const permutations: DibbsRelevanceInput[] = [];
    for (const exactNsnMatch of [false, true]) {
      for (const priorCageAwardHistory of [false, true]) {
        for (const capabilityTextMatch of [false, true]) {
          for (const buyerHistory of [false, true]) {
            for (const closesDate of [FAR_CLOSE, IMMINENT_CLOSE, null]) {
              for (const profileTooThin of [false, true]) {
                permutations.push(
                  input({
                    exactNsnMatch,
                    priorCageAwardHistory,
                    capabilityTextMatch,
                    buyerHistory,
                    closesDate,
                    profileTooThin,
                  }),
                );
              }
            }
          }
        }
      }
    }

    for (const candidate of permutations) {
      const result = scoreDibbsRelevance(candidate);
      for (const code of result.reasonCodes) {
        expect(DIBBS_REASON_CODES).toContain(code);
      }
      expect(MACHINE_RECOMMENDATIONS).toContain(result.machineRecommendation);
      expect(RECOMMENDATION_CONFIDENCES).toContain(result.recommendationConfidence);
    }

    expect(permutations).toHaveLength(2 * 2 * 2 * 2 * 3 * 2);
  });

  test('the floor is never cleared without part-level evidence or a prior CAGE award', () => {
    const permutations: DibbsRelevanceInput[] = [];
    for (const capabilityTextMatch of [false, true]) {
      for (const buyerHistory of [false, true]) {
        for (const closesDate of [FAR_CLOSE, IMMINENT_CLOSE]) {
          permutations.push(input({ capabilityTextMatch, buyerHistory, closesDate }));
        }
      }
    }

    for (const candidate of permutations) {
      expect(scoreDibbsRelevance(candidate).clearsSuggestionFloor).toBe(false);
    }
  });

  test('the same input always produces the same output', () => {
    const candidate = input({ exactNsnMatch: true, capabilityTextMatch: true, closesDate: IMMINENT_CLOSE });

    expect(scoreDibbsRelevance(candidate)).toEqual(scoreDibbsRelevance(candidate));
  });

  test('the imminent window is the declared constant, not a magic number', () => {
    const justInside = new Date(ASOF.getTime() + DIBBS_IMMINENT_CLOSING_DAYS * 86_400_000).toISOString();
    const justOutside = new Date(ASOF.getTime() + (DIBBS_IMMINENT_CLOSING_DAYS + 1) * 86_400_000).toISOString();

    expect(scoreDibbsRelevance(input({ closesDate: justInside })).reasonCodes).toContain('closing_imminent');
    expect(scoreDibbsRelevance(input({ closesDate: justOutside })).reasonCodes).not.toContain('closing_imminent');
  });
});
