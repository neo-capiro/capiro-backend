import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { CANARY_LIMITS_V1, CANARY_LIMITS_VERSION } from './limits';

const count = z.number().int().nonnegative();
export const canaryTurnEventSchema = z.object({
  event: z.literal('meri.canary.turn'), conversationId: z.string().nullable(), tenantId: z.string(),
  surface: z.string(), modes: z.record(z.string()),
  registryVersion: z.string().optional(),
  jevTasks: z.record(z.object({ questionVersion: z.string(), modelVersion: z.string() })).optional(),
  outcome: z.enum(['released', 'held', 'error', 'aborted']), clarificationRequested: z.boolean(),
  heldReason: z.string().nullable(),
  coverage: z.object({ gaps: count, followUps: count, residual: count }),
  passageSelection: z.object({ candidates: count, kept: count, dropped: count,
    requiredCandidates: count, requiredRetained: count, contradictoryRetained: count, fallback: z.boolean() }),
  repair: z.object({ attempted: count, corrected: count, qualified: count, omitted: count,
    documentRequested: count, budgetExhausted: count }),
  latencyMs: z.object({ timeToText: count, assessment: count, passageSelection: count,
    coverageFollowUp: count, repair: count, total: count }),
  tokens: z.object({ synthesis: count, jev: count, legacy: count, repair: count }),
  estimatedCostUsd: z.number().nonnegative(), sampled: z.boolean(),
});
export type CanaryTurnEvent = z.infer<typeof canaryTurnEventSchema>;

export function readCanaryEvents(file: string): { events: CanaryTurnEvent[]; rejected: number; unrelated: number } {
  const result = { events: [] as CanaryTurnEvent[], rejected: 0, unrelated: 0 };
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { result.rejected++; continue; }
    const row = value as Record<string, unknown>;
    const name = row?.event ?? row?.message ?? row?.name;
    if (name !== 'meri.canary.turn') { result.unrelated++; continue; }
    const fields = row.fields && typeof row.fields === 'object' ? row.fields : row;
    const checked = canaryTurnEventSchema.safeParse({ ...(fields as object), event: name });
    if (checked.success) result.events.push(checked.data); else result.rejected++;
  }
  return result;
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}
function rate(successes: number, n: number) {
  if (!n) return { value: null, n, confidence95: null };
  const value = successes / n; const z95 = 1.96; const d = 1 + z95 * z95 / n;
  const center = (value + z95 * z95 / (2 * n)) / d;
  const margin = z95 * Math.sqrt((value * (1 - value) + z95 * z95 / (4 * n)) / n) / d;
  return { value, n, confidence95: [Math.max(0, center - margin), Math.min(1, center + margin)] };
}
const LATENCY_COMPONENTS = ['timeToText', 'assessment', 'passageSelection', 'coverageFollowUp', 'repair', 'total'] as const;
type LatencyComponent = (typeof LATENCY_COMPONENTS)[number];
type Percentiles = { p50: number | null; p95: number | null };

function aggregate(events: CanaryTurnEvent[]) {
  const released = events.filter((event) => event.outcome === 'released');
  // Repair counters are per claim: `attempted` counts repairable claims and a claim is
  // resolved when it ended corrected, qualified or omitted (never more than attempted).
  // A turn is fully repaired only when every attempted claim resolved, so a single
  // unresolved claim marks the whole turn.
  const repairs = events.map((event) => {
    const attempted = event.repair.attempted;
    const resolved = Math.min(attempted, event.repair.corrected + event.repair.qualified + event.repair.omitted);
    return { attempted, resolved };
  });
  const attempted = repairs.reduce((sum, repair) => sum + repair.attempted, 0);
  const successful = repairs.reduce((sum, repair) => sum + repair.resolved, 0);
  const turnsAttempted = repairs.filter((repair) => repair.attempted > 0).length;
  const turnsFullyRepaired = repairs.filter((repair) => repair.attempted > 0 && repair.resolved === repair.attempted).length;
  // The collector leaves latencyMs.repair at 0 on turns that never ran a repair; sampling
  // those would let the repair-latency gates pass on zeros.
  const repairTurns = events.filter((event) => event.repair.attempted > 0);
  const requiredCandidates = events.reduce((sum, event) => sum + event.passageSelection.requiredCandidates, 0);
  const requiredRetained = events.reduce((sum, event) => sum + event.passageSelection.requiredRetained, 0);
  const component = (key: LatencyComponent, sample: CanaryTurnEvent[]): Percentiles => ({
    p50: percentile(sample.map((event) => event.latencyMs[key]), .5),
    p95: percentile(sample.map((event) => event.latencyMs[key]), .95),
  });
  return {
    turns: events.length,
    outcomes: Object.fromEntries(['released', 'held', 'error', 'aborted'].map((outcome) =>
      [outcome, events.filter((event) => event.outcome === outcome).length])),
    holds: events.filter((event) => event.outcome === 'held').length,
    clarification: rate(events.filter((event) => event.clarificationRequested).length, events.length),
    repair: { attempted, successful, unresolved: attempted - successful, successRate: rate(successful, attempted),
      turnsAttempted, turnsFullyRepaired, turnSuccessRate: rate(turnsFullyRepaired, turnsAttempted),
      corrected: events.reduce((s, e) => s + e.repair.corrected, 0),
      qualified: events.reduce((s, e) => s + e.repair.qualified, 0),
      omitted: events.reduce((s, e) => s + e.repair.omitted, 0) },
    passage: { candidates: events.reduce((s, e) => s + e.passageSelection.candidates, 0),
      dropped: events.reduce((s, e) => s + e.passageSelection.dropped, 0), requiredCandidates,
      requiredRetained, requiredRetention: rate(requiredRetained, requiredCandidates) },
    coverageFollowUps: events.reduce((sum, event) => sum + event.coverage.followUps, 0),
    latencyMs: Object.fromEntries(LATENCY_COMPONENTS.map((key) =>
      [key, component(key, key === 'repair' ? repairTurns : events)])) as Record<LatencyComponent, Percentiles>,
    released: released.length,
    costPerReleasedTurn: released.length ? released.reduce((sum, event) => sum + event.estimatedCostUsd, 0) / released.length : null,
  };
}

type Status = 'pass' | 'fail' | 'insufficient_data';
export function buildCanaryReport(canary: CanaryTurnEvent[], baseline: CanaryTurnEvent[] = []) {
  const current = aggregate(canary); const prior = aggregate(baseline);
  const limit = (status: Status, observed: number | null, threshold: number) => ({ status, observed, threshold });
  const clarificationDelta = current.clarification.value === null || prior.clarification.value === null ? null
    : (current.clarification.value - prior.clarification.value) * 100;
  const repairLatency = current.latencyMs.repair;
  const repairSampled = current.repair.turnsAttempted > 0;
  const currentTtt = current.latencyMs.timeToText;
  const priorTtt = prior.latencyMs.timeToText;
  const tttDelta = currentTtt.p95 === null || priorTtt.p95 === null ? null : currentTtt.p95 - priorTtt.p95;
  const costDelta = current.costPerReleasedTurn === null || prior.costPerReleasedTurn === null || prior.costPerReleasedTurn === 0
    ? null : (current.costPerReleasedTurn / prior.costPerReleasedTurn - 1) * 100;
  const retention = current.passage.requiredRetention.value;
  const compare = (value: number | null, threshold: number, direction: 'max' | 'min' = 'max', hasData = true): Status =>
    value === null || !hasData ? 'insufficient_data' : direction === 'max' ? value <= threshold ? 'pass' : 'fail' : value >= threshold ? 'pass' : 'fail';
  const limits = {
    holds: limit(compare(current.holds, CANARY_LIMITS_V1.holds, 'max', current.turns > 0), current.holds, CANARY_LIMITS_V1.holds),
    clarificationRateDeltaPp: limit(compare(clarificationDelta, CANARY_LIMITS_V1.clarificationRateDeltaPp), clarificationDelta, CANARY_LIMITS_V1.clarificationRateDeltaPp),
    repairLatencyP50Ms: limit(compare(repairLatency.p50, CANARY_LIMITS_V1.repairLatencyP50Ms, 'max', repairSampled), repairLatency.p50, CANARY_LIMITS_V1.repairLatencyP50Ms),
    repairLatencyP95Ms: limit(compare(repairLatency.p95, CANARY_LIMITS_V1.repairLatencyP95Ms, 'max', repairSampled), repairLatency.p95, CANARY_LIMITS_V1.repairLatencyP95Ms),
    passageRequiredRetention: limit(compare(retention, CANARY_LIMITS_V1.passageRequiredRetention, 'min'), retention, CANARY_LIMITS_V1.passageRequiredRetention),
    timeToTextP95DeltaMs: limit(compare(tttDelta, CANARY_LIMITS_V1.timeToTextP95DeltaMs), tttDelta, CANARY_LIMITS_V1.timeToTextP95DeltaMs),
    costPerCompletedTurnDeltaPct: limit(compare(costDelta, CANARY_LIMITS_V1.costPerCompletedTurnDeltaPct), costDelta, CANARY_LIMITS_V1.costPerCompletedTurnDeltaPct),
  };
  const payload = { version: 'meri-canary-report-v1', limitsVersion: CANARY_LIMITS_VERSION,
    sampleSizes: { canary: canary.length, baseline: baseline.length }, current, baseline: prior, limits };
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const repairNote = `Repair latency percentiles are taken over ${current.repair.turnsAttempted} turn(s) with an attempted repair; `
    + `repair success is per claim (${current.repair.successful}/${current.repair.attempted} resolved), `
    + `with ${current.repair.turnsFullyRepaired}/${current.repair.turnsAttempted} attempted turn(s) fully repaired.`;
  const markdown = `# Meri Stage 2 canary report\n\nHash: \`${hash}\`\n\nCanary turns: ${canary.length}; baseline turns: ${baseline.length}.\n\n## Limits\n\n| Limit | Status | Observed | Threshold |\n| --- | --- | ---: | ---: |\n${Object.entries(limits).map(([name, row]) => `| ${name} | ${row.status} | ${row.observed ?? 'n/a'} | ${row.threshold} |`).join('\n')}\n\n${repairNote}\n`;
  return { ...payload, hash, markdown };
}
