import {
  assembleFundingNarrative,
  type NarrativeYearValues,
} from './pe-funding-narrative.helpers.js';

const base: NarrativeYearValues = {
  request: null,
  hasc: null,
  sasc: null,
  hacd: null,
  sacd: null,
  conference: null,
  enacted: null,
};

describe('assembleFundingNarrative (Phase 4.1 PE narrative)', () => {
  it('orders acted stages request→marks→enactment and computes signed deltas', () => {
    const steps = assembleFundingNarrative({
      ...base,
      request: 72.1,
      hacd: 112.9,
      enacted: 100,
    });
    expect(steps.map((s) => s.stage)).toEqual(['request', 'hacd', 'enacted']);
    // HAC-D is +40.8 vs request (the S1-3 direction, computed from values, not narrated).
    expect(steps[1]).toMatchObject({
      label: 'HAC-D',
      vehicle: 'appropriation',
      valueM: 112.9,
      deltaVsRequestM: 40.8,
      deltaVsPriorStageM: 40.8,
    });
    // enacted is −12.9 vs the prior acted stage (HAC-D), −27.9 vs request.
    expect(steps[2]).toMatchObject({ deltaVsPriorStageM: -12.9, deltaVsRequestM: 27.9 });
  });

  it('labels authorization vs appropriation stages distinctly and skips absent stages', () => {
    const steps = assembleFundingNarrative({ ...base, request: 50, hasc: 55, sacd: 48 });
    expect(steps.map((s) => [s.stage, s.vehicle])).toEqual([
      ['request', 'request'],
      ['hasc', 'authorization'],
      ['sacd', 'appropriation'],
    ]);
  });

  it('the request step carries no delta-vs-request; a request-less year has null prior/request deltas', () => {
    const [reqStep] = assembleFundingNarrative({ ...base, request: 50 });
    expect(reqStep).toMatchObject({
      stage: 'request',
      deltaVsRequestM: null,
      deltaVsPriorStageM: null,
    });
    const [mark] = assembleFundingNarrative({ ...base, hacd: 60 });
    expect(mark).toMatchObject({ stage: 'hacd', deltaVsRequestM: null, deltaVsPriorStageM: null });
  });

  it('returns [] when no stage has acted', () => {
    expect(assembleFundingNarrative(base)).toEqual([]);
  });
});
