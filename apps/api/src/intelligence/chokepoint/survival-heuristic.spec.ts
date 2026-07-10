import { computeSurvivalHeuristic, type SurvivalFactors } from './survival-heuristic.js';

const ALL_UNKNOWN: SurvivalFactors = {
  sponsorInMajorityOrLeadership: null,
  chairIsSponsorOrCosponsor: null,
  companionAdvancing: null,
  committeeAdvancement: null,
  daysToCutoff: null,
  isPastCutoff: false,
  passedChamberOrLater: false,
};

describe('computeSurvivalHeuristic (Phase 1 M2.4, PD3)', () => {
  it('a fully-favorable bill scores high and bands likely-advances, with normal confidence', () => {
    const out = computeSurvivalHeuristic({
      sponsorInMajorityOrLeadership: true,
      chairIsSponsorOrCosponsor: true,
      companionAdvancing: true,
      committeeAdvancement: true,
      daysToCutoff: 30,
      isPastCutoff: false,
      passedChamberOrLater: false,
    });
    expect(out.score).toBeCloseTo(0.2 + 0.2 + 0.15 + 0.2, 5);
    expect(out.band).toBe('likely-advances');
    expect(out.confidence).toBe('normal');
  });

  it('a fully-unfavorable-but-resolved bill scores 0 and bands stalled', () => {
    const out = computeSurvivalHeuristic({
      sponsorInMajorityOrLeadership: false,
      chairIsSponsorOrCosponsor: false,
      companionAdvancing: false,
      committeeAdvancement: false,
      daysToCutoff: 30,
      isPastCutoff: false,
      passedChamberOrLater: false,
    });
    expect(out.score).toBe(0);
    expect(out.band).toBe('stalled');
    expect(out.confidence).toBe('normal');
  });

  it('penalizes a bill under 7 days to cutoff that has NOT advanced past committee', () => {
    const out = computeSurvivalHeuristic({
      ...ALL_UNKNOWN,
      committeeAdvancement: false,
      daysToCutoff: 3,
      isPastCutoff: false,
    });
    expect(out.score).toBe(0); // -0.25 clamped to 0 floor
  });

  it('does NOT penalize a bill under 7 days to cutoff that HAS advanced past committee', () => {
    const out = computeSurvivalHeuristic({
      ...ALL_UNKNOWN,
      sponsorInMajorityOrLeadership: true,
      committeeAdvancement: true,
      daysToCutoff: 3,
      isPastCutoff: false,
    });
    expect(out.score).toBeCloseTo(0.2 + 0.2, 5); // sponsor + committeeAdvancement, no penalty
  });

  it('bonuses a bill already past its cutoff that has passed a chamber (momentum despite the calendar)', () => {
    const out = computeSurvivalHeuristic({
      ...ALL_UNKNOWN,
      daysToCutoff: -5,
      isPastCutoff: true,
      passedChamberOrLater: true,
    });
    expect(out.score).toBeCloseTo(0.1, 5);
  });

  it('does NOT bonus a bill past its cutoff that has NOT passed a chamber', () => {
    const out = computeSurvivalHeuristic({
      ...ALL_UNKNOWN,
      daysToCutoff: -5,
      isPastCutoff: true,
      passedChamberOrLater: false,
    });
    expect(out.score).toBe(0);
  });

  it('a bill with no companion at all scores that factor as a real zero, not a missing input', () => {
    const out = computeSurvivalHeuristic({
      sponsorInMajorityOrLeadership: true,
      chairIsSponsorOrCosponsor: true,
      companionAdvancing: false, // no companion, or one that hasn't advanced
      committeeAdvancement: true,
      daysToCutoff: 30,
      isPastCutoff: false,
      passedChamberOrLater: false,
    });
    expect(out.confidence).toBe('normal'); // NOT downgraded — companionAdvancing=false is resolved, not unknown
  });

  it('downgrades confidence to low when ANY resolvable factor is unresolvable, even with a high score', () => {
    const out = computeSurvivalHeuristic({
      sponsorInMajorityOrLeadership: true,
      chairIsSponsorOrCosponsor: null, // unresolved — e.g. no committee resolved
      companionAdvancing: true,
      committeeAdvancement: true,
      daysToCutoff: 30,
      isPastCutoff: false,
      passedChamberOrLater: false,
    });
    expect(out.confidence).toBe('low');
  });

  it('clamps the score to [0,1] — never goes negative or above 1', () => {
    const belowZero = computeSurvivalHeuristic({
      ...ALL_UNKNOWN,
      committeeAdvancement: false,
      daysToCutoff: 1,
      isPastCutoff: false,
    });
    expect(belowZero.score).toBeGreaterThanOrEqual(0);
  });

  it('band thresholds: <0.30 stalled, 0.30-0.60 at-risk, >0.60 likely-advances', () => {
    // score 0.20 (committeeAdvancement alone) -> stalled
    expect(
      computeSurvivalHeuristic({ ...ALL_UNKNOWN, committeeAdvancement: true, daysToCutoff: 30 })
        .band,
    ).toBe('stalled');
    // score 0.40 (committeeAdvancement + chairIsSponsorOrCosponsor) -> at-risk
    expect(
      computeSurvivalHeuristic({
        ...ALL_UNKNOWN,
        chairIsSponsorOrCosponsor: true,
        committeeAdvancement: true,
        daysToCutoff: 30,
      }).band,
    ).toBe('at-risk');
    // score 0.75 (sponsor + chair + companion + committeeAdvancement) -> likely-advances
    expect(
      computeSurvivalHeuristic({
        sponsorInMajorityOrLeadership: true,
        chairIsSponsorOrCosponsor: true,
        companionAdvancing: true,
        committeeAdvancement: true,
        daysToCutoff: 30,
        isPastCutoff: false,
        passedChamberOrLater: false,
      }).band,
    ).toBe('likely-advances');
  });
});
