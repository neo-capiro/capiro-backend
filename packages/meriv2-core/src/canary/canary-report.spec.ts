import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildCanaryReport, canaryTurnEventSchema, readCanaryEvents, type CanaryTurnEvent } from './canary-report';

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

const noRepair: CanaryTurnEvent['repair'] =
  { attempted: 0, corrected: 0, qualified: 0, omitted: 0, documentRequested: 0, budgetExhausted: 0 };
const repair = (counts: Partial<CanaryTurnEvent['repair']>): CanaryTurnEvent['repair'] => ({ ...noRepair, ...counts });
const latency = (overrides: Partial<CanaryTurnEvent['latencyMs']> = {}): CanaryTurnEvent['latencyMs'] =>
  ({ timeToText: 100, assessment: 20, passageSelection: 10, coverageFollowUp: 0, repair: 30, total: 100, ...overrides });

/**
 * Mirrors what apps/meriv2-orchestrator/src/meri/canary/canary-turn-collector.ts
 * `CanaryTurnCollector.build()` emits for a released turn after
 * `notePassageSelection(...)`: the seven mode keys, surface `chat`, zeroed coverage
 * and repair metrics, passage-selection tokens under `tokens.jev`, `timeToText`
 * equal to `total`, and the 9-decimal cost rounding. Only the passage-selection
 * counters (and, where a test needs it, the outcome) vary.
 */
function collectorEvent(
  passageSelection: CanaryTurnEvent['passageSelection'],
  overrides: Partial<CanaryTurnEvent> = {},
): CanaryTurnEvent {
  const total = 900;
  return {
    event: 'meri.canary.turn',
    conversationId: 'conv-1',
    tenantId: '00000000-0000-4000-8000-000000000001',
    surface: 'chat',
    modes: { evidenceAccuracy: 'shadow', claimAssessment: 'shadow', coverageRetrieval: 'off',
      passageSelection: 'enforce', autoCorrection: 'off', jevProvider: 'enforce', routing: 'cascade' },
    outcome: 'released',
    clarificationRequested: false,
    heldReason: null,
    coverage: { gaps: 0, followUps: 0, residual: 0 },
    passageSelection,
    repair: noRepair,
    latencyMs: { timeToText: total, assessment: 0, passageSelection: 40, coverageFollowUp: 0, repair: 0, total },
    tokens: { synthesis: 120, jev: 55, legacy: 0, repair: 0 },
    estimatedCostUsd: Number((55 * 2e-7).toFixed(9)),
    sampled: false,
    ...overrides,
  };
}
/** Two required candidates, one of them dropped: requiredRetention 1/2. */
const droppedRequired: CanaryTurnEvent['passageSelection'] =
  { candidates: 3, kept: 1, dropped: 2, requiredCandidates: 2, requiredRetained: 1, contradictoryRetained: 0, fallback: false };

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
    const fail = buildCanaryReport([collectorEvent(droppedRequired,
      { outcome: 'held', heldReason: 'unsupported_claims', clarificationRequested: true })], [event()]);
    expect(fail.limits.holds.status).toBe('fail');
    expect(fail.limits.passageRequiredRetention).toEqual({ status: 'fail', observed: .5, threshold: 1 });
    expect(buildCanaryReport([]).limits.timeToTextP95DeltaMs.status).toBe('insufficient_data');
  });

  it('fails passageRequiredRetention from a collector-shaped event read back through readCanaryEvents', () => {
    const dropped = collectorEvent(droppedRequired, {
      registryVersion: 'jev-task-registry.v1',
      jevTasks: {
        claim_support: { questionVersion: 'claim_support.v1', modelVersion: 'jev-1.13.0' },
        passage_relevance: { questionVersion: 'passage_selection.v1', modelVersion: 'jev-1.13.0' },
      },
    });
    expect(canaryTurnEventSchema.safeParse(dropped).success).toBe(true);
    const directory = mkdtempSync(path.join(tmpdir(), 'canary-report-'));
    try {
      const file = path.join(directory, 'events.jsonl');
      writeFileSync(file, `${JSON.stringify(dropped)}\n${JSON.stringify({ event: 'meri.other', tenantId: 't' })}\n`);
      const read = readCanaryEvents(file);
      expect(read).toMatchObject({ rejected: 0, unrelated: 1 });
      expect(read.events).toEqual([dropped]);
      const report = buildCanaryReport(read.events);
      expect(report.current.passage).toMatchObject({ requiredCandidates: 2, requiredRetained: 1 });
      expect(report.current.passage.requiredRetention.value).toBe(.5);
      expect(report.limits.passageRequiredRetention).toEqual({ status: 'fail', observed: .5, threshold: 1 });
      expect(report.markdown).toContain('| passageRequiredRetention | fail | 0.5 | 1 |');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('samples repair latency only from turns that attempted a repair, so zeros cannot pass the gates', () => {
    const idle = event({ repair: noRepair, latencyMs: latency({ repair: 0 }) });
    const slow = event({ latencyMs: latency({ repair: 12_000 }) });
    const report = buildCanaryReport([
      ...Array.from({ length: 95 }, () => idle),
      ...Array.from({ length: 5 }, () => slow),
    ]);
    expect(report.current.repair.turnsAttempted).toBe(5);
    expect(report.current.latencyMs.repair).toEqual({ p50: 12_000, p95: 12_000 });
    expect(report.limits.repairLatencyP50Ms).toEqual({ status: 'fail', observed: 12_000, threshold: 3_000 });
    expect(report.limits.repairLatencyP95Ms).toEqual({ status: 'fail', observed: 12_000, threshold: 8_000 });
    expect(report.current.latencyMs.timeToText).toEqual({ p50: 100, p95: 100 });
    expect(report.markdown).toContain('5 turn(s) with an attempted repair or outer-fence timeout');
  });

  it('reports insufficient data, never pass, for repair latency when no turn attempted a repair', () => {
    const idle = event({ repair: noRepair, latencyMs: latency({ repair: 250 }) });
    const report = buildCanaryReport([idle, idle]);
    expect(report.current.repair.turnsAttempted).toBe(0);
    expect(report.current.latencyMs.repair).toEqual({ p50: null, p95: null });
    expect(report.limits.repairLatencyP50Ms).toEqual({ status: 'insufficient_data', observed: null, threshold: 3_000 });
    expect(report.limits.repairLatencyP95Ms).toEqual({ status: 'insufficient_data', observed: null, threshold: 8_000 });
  });

  it('measures repair success per claim and marks a turn with any unresolved claim as not fully repaired', () => {
    const partial = event({ repair: repair({ attempted: 3, corrected: 2 }) });
    const alone = buildCanaryReport([partial]);
    expect(alone.current.repair).toMatchObject({ attempted: 3, successful: 2, unresolved: 1, turnsAttempted: 1, turnsFullyRepaired: 0 });
    expect(alone.current.repair.successRate.value).toBeCloseTo(2 / 3);
    expect(alone.current.repair.turnSuccessRate.value).toBe(0);

    const full = event({ repair: repair({ attempted: 2, corrected: 1, qualified: 1 }) });
    const mixed = buildCanaryReport([partial, full]);
    expect(mixed.current.repair).toMatchObject({ attempted: 5, successful: 4, unresolved: 1, turnsAttempted: 2, turnsFullyRepaired: 1 });
    expect(mixed.current.repair.successRate.value).toBe(.8);
    expect(mixed.current.repair.turnSuccessRate.value).toBe(.5);

    const inconsistent = buildCanaryReport([event({ repair: repair({ attempted: 1, corrected: 1, qualified: 1 }) })]);
    expect(inconsistent.current.repair).toMatchObject({ successful: 1, unresolved: 0 });
    expect(inconsistent.current.repair.successRate.value).toBe(1);
  });

  it('applies V2 completion, failure and passage-intervention limits while V1 remains unchanged', () => {
    const intervention = event({ passageSelection: {
      ...event().passageSelection,
      safetyIntervention: { evaluated: true, intervened: true, reasons: ['required_candidate_restored'] },
    } });
    const incomplete = event({ outcome: 'incomplete' });
    const report = buildCanaryReport([intervention, incomplete], [event(), event()], { limitsVersion: 'v2' });
    expect(report.limitsVersion).toBe('stage2-canary-limits-v2');
    expect(report.current.outcomes.incomplete).toBe(1);
    expect(report.current.passage.selectionsEvaluated).toBe(1);
    expect(report.current.passage.safetyInterventionReasons).toEqual({ required_candidate_restored: 1 });
    expect(report.limits.passageSafetyInterventionRate.status).toBe('fail');
    expect(report.limits.completionRateDropPp.status).toBe('fail');
    expect(report.limits.incompleteRateDeltaPp.status).toBe('fail');
    expect(buildCanaryReport([intervention], [event()]).limits).not.toHaveProperty('passageSafetyInterventionRate');
  });

  it('keeps an outer-fence timeout in the repair latency sample without claiming an attempted claim', () => {
    const timedOut = event({ repair: repair({ timedOut: true, budgetExhausted: 1 }),
      latencyMs: latency({ repair: 8_000 }) });
    const report = buildCanaryReport([timedOut], [], { limitsVersion: 'v2' });
    expect(report.current.repair.turnsAttempted).toBe(0);
    expect(report.current.latencyMs.repair).toEqual({ p50: 8_000, p95: 8_000 });
    expect(report.limits.repairLatencyP50Ms.status).toBe('fail');
  });
});
