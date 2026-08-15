import {
  SBIR_ACTIONS,
  SBIR_IMMINENT_CLOSING_DAYS,
  describeSbirPhaseGap,
  isTopicClosed,
  scoreSbirRelevance,
  type SbirRelevanceInput,
} from './sbir-relevance.js';

/**
 * P43 — SBIR/STTR topic relevance.
 *
 * Two rules shape this file:
 *
 * 1. **Every clock is MID-DAY.** P41 part 1 shipped a date bug that survived 28
 *    tests because every fixture used `T00:00:00.000Z` — the one value that
 *    makes instant arithmetic accidentally agree with calendar arithmetic. A
 *    midnight fixture cannot test date logic here.
 * 2. **The dormant signals are tested anyway.** `programElementLinkedSourceBacked`
 *    and `priorSbirHistorySourceBacked` cannot fire with today's data. Testing
 *    them pins the rule order for the phase that makes them live, and proves the
 *    branch exists rather than being a comment.
 */

/** Deliberately awkward: mid-afternoon, not midnight. */
const AS_OF = new Date('2026-03-10T14:37:11.000Z');

function input(overrides: Partial<SbirRelevanceInput> = {}): SbirRelevanceInput {
  return {
    solicitationStatus: 'Open',
    closeDate: '2026-06-01',
    profileTooThin: false,
    capabilityTopicMatch: false,
    priorAgencyHistory: false,
    historyIsIdentifierBacked: false,
    programElementLinkedSourceBacked: false,
    priorSbirHistorySourceBacked: false,
    asOf: AS_OF,
    ...overrides,
  };
}

describe('phase is never inferred, and its absence is a FIELD', () => {
  test('every result carries the phase gap, on every branch', () => {
    const branches: SbirRelevanceInput[] = [
      input({ solicitationStatus: 'Closed' }),
      input({ profileTooThin: true }),
      input(),
      input({ programElementLinkedSourceBacked: true }),
      input({ priorAgencyHistory: true, historyIsIdentifierBacked: true }),
      input({ capabilityTopicMatch: true }),
    ];
    for (const branch of branches) {
      expect(scoreSbirRelevance(branch).sbirPhaseGap).toBe('phase_not_published_by_source');
    }
  });

  test('the gap names the SOURCE, never the client or the topic', () => {
    const text = describeSbirPhaseGap('phase_not_published_by_source')!;
    expect(text).toMatch(/source publishes no phase/i);
    // "Not evaluated" or "unknown phase" would read as a judgement about this
    // topic. The fact is about the published contract.
    expect(text).toMatch(/gap in the published contract/i);
    expect(describeSbirPhaseGap(null)).toBeNull();
  });

  test('no output field carries a phase value', () => {
    const result = scoreSbirRelevance(input({ capabilityTopicMatch: true }));
    expect(Object.keys(result)).not.toContain('phase');
    // And nothing composes one into prose. "Direct to Phase II" in a title is
    // the provider describing a topic, not a structured field.
    const prose = [result.primaryReason, result.recommendedNextAction, result.primaryRisk ?? ''];
    for (const line of prose) {
      expect(line).not.toMatch(/phase\s*(i{1,3}|1|2|3)\b/i);
    }
  });
});

describe('eligibility is never established here', () => {
  test('every branch reports needs_review with a reason naming what is missing', () => {
    const branches = [
      input({ solicitationStatus: 'Closed' }),
      input({ profileTooThin: true }),
      input(),
      input({ priorSbirHistorySourceBacked: true }),
      input({ capabilityTopicMatch: true }),
    ];
    for (const branch of branches) {
      const result = scoreSbirRelevance(branch);
      expect(result.eligibility).toBe('needs_review');
      expect(result.eligibilityReason).toMatch(/US ownership/i);
      expect(result.eligibilityReason).toMatch(/research-institution partner/i);
    }
  });

  test('the reason says a small-business certification is NOT the same question', () => {
    // The tempting wrong answer: setAsideCertifications is close enough to look
    // like eligibility and is a different fact.
    expect(scoreSbirRelevance(input()).eligibilityReason).toMatch(
      /small-business certification is not the same question/i,
    );
  });

  test('no branch ever reports eligible', () => {
    for (const branch of [input(), input({ programElementLinkedSourceBacked: true })]) {
      expect(scoreSbirRelevance(branch).eligibility).not.toBe('eligible');
    }
  });
});

describe('a closed topic never offers an action', () => {
  test.each([['Closed'], ['closed'], ['  ARCHIVED  '], ['Expired']])(
    'the provider status %s closes it',
    (status) => {
      const result = scoreSbirRelevance(input({ solicitationStatus: status }));
      expect(result.machineRecommendation).toBe('pass');
      expect(result.reasonCodes).toEqual(['topic_closed']);
      // Structural, not a UI convention: an empty list gives a caller nothing to
      // render, rather than a control it is trusted to hide.
      expect(result.actions).toEqual([]);
      expect(result.clearsSuggestionFloor).toBe(false);
    },
  );

  test('"Closing Soon" is NOT closed — a substring test would read it as one', () => {
    const result = scoreSbirRelevance(
      input({ solicitationStatus: 'Closing Soon', capabilityTopicMatch: true }),
    );
    expect(result.machineRecommendation).not.toBe('pass');
    expect(result.actions.length).toBeGreaterThan(0);
  });

  test('a close date in the past closes it even while the provider says Open', () => {
    const result = scoreSbirRelevance(
      input({ solicitationStatus: 'Open', closeDate: '2026-03-09' }),
    );
    expect(result.machineRecommendation).toBe('pass');
    expect(result.actions).toEqual([]);
  });

  /**
   * THE REGRESSION P41 PART 1 SHIPPED, ported forward.
   *
   * `asOf` is mid-afternoon on the 10th and the topic closes on the 10th. With
   * instant arithmetic this is `floor(-0.5) = -1` — closed, on its final
   * submittable day. With calendar arithmetic it is 0 — open.
   */
  test('a topic closing TODAY is open, at any hour', () => {
    for (const hour of ['00:00:00', '09:15:00', '14:37:11', '23:59:59']) {
      const asOf = new Date(`2026-03-10T${hour}.000Z`);
      expect(isTopicClosed({ solicitationStatus: 'Open', closeDate: '2026-03-10', asOf })).toBe(
        false,
      );
    }
  });

  test('a topic that closed yesterday is closed, at any hour', () => {
    for (const hour of ['00:00:00', '14:37:11', '23:59:59']) {
      const asOf = new Date(`2026-03-10T${hour}.000Z`);
      expect(isTopicClosed({ solicitationStatus: 'Open', closeDate: '2026-03-09', asOf })).toBe(
        true,
      );
    }
  });

  test('a null status is not a closure, and an unparseable date is not one either', () => {
    expect(isTopicClosed({ solicitationStatus: null, closeDate: null, asOf: AS_OF })).toBe(false);
    expect(
      isTopicClosed({ solicitationStatus: null, closeDate: 'sometime in spring', asOf: AS_OF }),
    ).toBe(false);
  });
});

describe('no evidence is a pass, and a closing date is not evidence', () => {
  test('nothing matching means pass, with no actions', () => {
    const result = scoreSbirRelevance(input());
    expect(result.machineRecommendation).toBe('pass');
    expect(result.reasonCodes).toEqual(['no_client_evidence']);
    expect(result.actions).toEqual([]);
  });

  test('an imminent close alone does not turn a pass into anything else', () => {
    // Every open topic has a closing date. Urgency is not evidence.
    const result = scoreSbirRelevance(input({ closeDate: '2026-03-12' }));
    expect(result.machineRecommendation).toBe('pass');
    expect(result.reasonCodes).toEqual(['no_client_evidence']);
  });
});

describe('a thin profile is needs_review, never pass', () => {
  test('it says so rather than reporting no evidence', () => {
    const result = scoreSbirRelevance(input({ profileTooThin: true, capabilityTopicMatch: true }));
    expect(result.machineRecommendation).toBe('needs_review');
    expect(result.reasonCodes).toEqual(['client_profile_too_thin']);
    // "We cannot answer" and "the answer is no" are different, and only one of
    // them is about the topic.
    expect(result.primaryReason).toMatch(/too thin/i);
  });
});

describe('generic innovation words cannot clear the floor alone', () => {
  test('capability text alone is monitor, low confidence, below the floor', () => {
    const result = scoreSbirRelevance(input({ capabilityTopicMatch: true }));
    expect(result.machineRecommendation).toBe('monitor');
    expect(result.recommendationConfidence).toBe('low');
    expect(result.clearsSuggestionFloor).toBe(false);
    expect(result.reasonCodes).toContain('capability_topic_match');
  });

  test('it says plainly that a vocabulary match is not a program fit', () => {
    const result = scoreSbirRelevance(input({ capabilityTopicMatch: true }));
    expect(result.primaryReason).toMatch(/vocabulary match/i);
    expect(result.primaryReason).toMatch(/not evidence of program fit/i);
  });

  test('the only action offered is to assess fit — never a white paper', () => {
    const result = scoreSbirRelevance(input({ capabilityTopicMatch: true }));
    expect(result.actions).toEqual(['assess_fit']);
    expect(result.actions).not.toContain('prepare_white_paper');
  });
});

describe('agency history', () => {
  test('identifier-backed history clears the floor; name-derived history does not', () => {
    const identifier = scoreSbirRelevance(
      input({ priorAgencyHistory: true, historyIsIdentifierBacked: true }),
    );
    const nameOnly = scoreSbirRelevance(
      input({ priorAgencyHistory: true, historyIsIdentifierBacked: false }),
    );

    expect(identifier.clearsSuggestionFloor).toBe(true);
    expect(identifier.recommendationConfidence).toBe('medium');
    // A name is a fact about a NAME, which another company can share.
    expect(nameOnly.clearsSuggestionFloor).toBe(false);
    expect(nameOnly.recommendationConfidence).toBe('low');
    expect(nameOnly.primaryReason).toMatch(/reviewed NAME rather than a verified identifier/i);
  });

  test('neither ever reaches pursue — agency history is not program fit', () => {
    for (const backed of [true, false]) {
      const result = scoreSbirRelevance(
        input({ priorAgencyHistory: true, historyIsIdentifierBacked: backed }),
      );
      expect(result.machineRecommendation).toBe('monitor');
    }
  });

  test('name-derived history asks for identifiers rather than for a proposal', () => {
    const result = scoreSbirRelevance(
      input({ priorAgencyHistory: true, historyIsIdentifierBacked: false }),
    );
    expect(result.actions).toEqual(['assess_fit']);
    expect(result.recommendedNextAction).toMatch(/confirm the client's identifiers/i);
  });
});

describe('the dormant source-backed signals', () => {
  /**
   * Neither can fire today: `tango_sbir_topic` has no program-element column,
   * and nothing stores a client's prior SBIR awards. Tested so the branch is
   * real and its rule order is pinned before the phase that makes them live.
   */
  test('a source-backed PE link is the one thing that reaches pursue', () => {
    const result = scoreSbirRelevance(input({ programElementLinkedSourceBacked: true }));
    expect(result.machineRecommendation).toBe('pursue');
    expect(result.clearsSuggestionFloor).toBe(true);
    expect(result.reasonCodes).toContain('program_element_link');
    expect(result.actions).toEqual([...SBIR_ACTIONS]);
  });

  test('a prior source-backed SBIR award also reaches pursue', () => {
    const result = scoreSbirRelevance(input({ priorSbirHistorySourceBacked: true }));
    expect(result.machineRecommendation).toBe('pursue');
    expect(result.reasonCodes).toContain('prior_sbir_history');
  });

  test('both together raise confidence to high; either alone is medium', () => {
    expect(
      scoreSbirRelevance(
        input({ programElementLinkedSourceBacked: true, priorSbirHistorySourceBacked: true }),
      ).recommendationConfidence,
    ).toBe('high');
    expect(
      scoreSbirRelevance(input({ programElementLinkedSourceBacked: true }))
        .recommendationConfidence,
    ).toBe('medium');
  });

  test('a structural tie outranks agency history and capability text', () => {
    // Rule order matters: the strongest evidence decides the recommendation,
    // and the weaker signals still appear in reasonCodes.
    const result = scoreSbirRelevance(
      input({
        programElementLinkedSourceBacked: true,
        priorAgencyHistory: true,
        historyIsIdentifierBacked: true,
        capabilityTopicMatch: true,
      }),
    );
    expect(result.machineRecommendation).toBe('pursue');
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining(['program_element_link', 'prior_agency_history', 'capability_topic_match']),
    );
  });
});

describe('imminence is a risk, never a reason', () => {
  test('a topic closing inside the window states the risk', () => {
    const result = scoreSbirRelevance(
      input({ programElementLinkedSourceBacked: true, closeDate: '2026-03-17' }),
    );
    expect(result.reasonCodes).toContain('closing_imminent');
    expect(result.primaryRisk).toMatch(/closes in 7 days/i);
    expect(result.primaryRisk).toMatch(/short for a white paper/i);
  });

  test('a topic closing far out carries no risk line', () => {
    const result = scoreSbirRelevance(
      input({ programElementLinkedSourceBacked: true, closeDate: '2026-09-01' }),
    );
    expect(result.reasonCodes).not.toContain('closing_imminent');
    expect(result.primaryRisk).toBeNull();
  });

  test('the window boundary is inclusive and measured in calendar days', () => {
    const boundary = new Date(AS_OF.getTime());
    boundary.setUTCDate(boundary.getUTCDate() + SBIR_IMMINENT_CLOSING_DAYS);
    const onBoundary = boundary.toISOString().slice(0, 10);
    expect(
      scoreSbirRelevance(input({ programElementLinkedSourceBacked: true, closeDate: onBoundary }))
        .reasonCodes,
    ).toContain('closing_imminent');
  });

  test('a singular day reads as "1 day", not "1 days"', () => {
    const result = scoreSbirRelevance(
      input({ programElementLinkedSourceBacked: true, closeDate: '2026-03-11' }),
    );
    expect(result.primaryRisk).toMatch(/closes in 1 day,/i);
  });
});

describe('the module is pure', () => {
  test('the same input scores the same twice, and reads no ambient clock', () => {
    const fixed = input({ capabilityTopicMatch: true });
    expect(scoreSbirRelevance(fixed)).toEqual(scoreSbirRelevance(fixed));
  });

  test('changing only asOf changes the verdict, proving the clock is the input', () => {
    const before = scoreSbirRelevance(
      input({ capabilityTopicMatch: true, closeDate: '2026-03-20' }),
    );
    const after = scoreSbirRelevance(
      input({
        capabilityTopicMatch: true,
        closeDate: '2026-03-20',
        asOf: new Date('2026-04-01T14:37:11.000Z'),
      }),
    );
    expect(before.machineRecommendation).toBe('monitor');
    expect(after.machineRecommendation).toBe('pass');
  });
});
