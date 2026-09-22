import { describe, expect, it } from '@jest/globals';
import { buildCanaryReport, type CanaryTurnEvent } from './canary-report';

function event(overrides: Partial<CanaryTurnEvent> = {}): CanaryTurnEvent {
  return {
    event: 'meri.canary.turn', conversationId: 'c', tenantId: 't', surface: 'chat', modes: {},
    outcome: 'released', clarificationRequested: false, heldReason: null,
    coverage: { gaps: 0, followUps: 0, residual: 0 },
    passageSelection: { candidates: 2, kept: 1, dropped: 1, requiredCandidates: 1,
      requiredRetained: 1, contradictoryRetained: 0, fallback: false },
    repair: { attempted: 1, corrected: 1, qualified: 0, omitted: 0, documentRequested: 0, budgetExhausted: 0 },
    latencyMs: { timeToText: 100, assessment: 20, passageSelection: 10, coverageFollowUp: 0, repair: 30, total: 100 },
    tokens: { synthesis: 10, jev: 2, legacy: 0, repair: 3 }, estimatedCostUsd: 1, sampled: false,
    ...overrides,
  };
}

describe('canary report', () => {
  it('aggregates hand-computed rates, nearest-rank percentiles and costs', () => {
    const report = buildCanaryReport([
      event(),
      event({ clarificationRequested: true, repair: { attempted: 1, corrected: 0, qualified: 1, omitted: 0, documentRequested: 0, budgetExhausted: 0 },
        latencyMs: { timeToText: 300, assessment: 40, passageSelection: 20, coverageFollowUp: 5, repair: 70, total: 300 }, estimatedCostUsd: 3 }),
    ], [event({ latencyMs: { timeToText: 50, assessment: 20, passageSelection: 10, coverageFollowUp: 0, repair: 30, total: 50 }, estimatedCostUsd: 1 })]);
    expect(report.current.clarification.value).toBe(.5);
    expect(report.current.repair.successRate.value).toBe(1);
    expect(report.current.latencyMs.timeToText).toEqual({ p50: 100, p95: 300 });
    expect(report.current.costPerReleasedTurn).toBe(2);
    expect(report.current.passage.requiredRetention.value).toBe(1);
  });

  it('evaluates pass, fail and insufficient data', () => {
    const pass = buildCanaryReport([event()], [event()]);
    expect(pass.limits.holds.status).toBe('pass');
    expect(pass.limits.passageRequiredRetention.status).toBe('pass');
    expect(pass.limits.clarificationRateDeltaPp.status).toBe('pass');
    const fail = buildCanaryReport([event({ outcome: 'held', clarificationRequested: true,
      passageSelection: { candidates: 2, kept: 0, dropped: 2, requiredCandidates: 1, requiredRetained: 0, contradictoryRetained: 0, fallback: false } })], [event()]);
    expect(fail.limits.holds.status).toBe('fail');
    expect(fail.limits.passageRequiredRetention.status).toBe('fail');
    expect(buildCanaryReport([]).limits.timeToTextP95DeltaMs.status).toBe('insufficient_data');
  });
});
