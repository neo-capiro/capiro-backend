import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { CANARY_LIMITS_V1, CANARY_LIMITS_VERSION } from './limits';

const count = z.number().int().nonnegative();
export const canaryTurnEventSchema = z.object({
  event: z.literal('meri.canary.turn'), conversationId: z.string().nullable(), tenantId: z.string(),
  surface: z.string(), modes: z.record(z.string()),
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
function aggregate(events: CanaryTurnEvent[]) {
  const released = events.filter((event) => event.outcome === 'released');
  const attempted = events.reduce((sum, event) => sum + event.repair.attempted, 0);
  const successful = events.reduce((sum, event) => sum + event.repair.corrected + event.repair.qualified + event.repair.omitted, 0);
  const requiredCandidates = events.reduce((sum, event) => sum + event.passageSelection.requiredCandidates, 0);
  const requiredRetained = events.reduce((sum, event) => sum + event.passageSelection.requiredRetained, 0);
  const component = (key: keyof CanaryTurnEvent['latencyMs']) => ({
    p50: percentile(events.map((event) => event.latencyMs[key]), .5),
    p95: percentile(events.map((event) => event.latencyMs[key]), .95),
  });
  return {
    turns: events.length,
    outcomes: Object.fromEntries(['released', 'held', 'error', 'aborted'].map((outcome) =>
      [outcome, events.filter((event) => event.outcome === outcome).length])),
    holds: events.filter((event) => event.outcome === 'held').length,
    clarification: rate(events.filter((event) => event.clarificationRequested).length, events.length),
    repair: { attempted, successful, successRate: rate(successful, attempted),
      corrected: events.reduce((s, e) => s + e.repair.corrected, 0),
      qualified: events.reduce((s, e) => s + e.repair.qualified, 0),
      omitted: events.reduce((s, e) => s + e.repair.omitted, 0) },
    passage: { candidates: events.reduce((s, e) => s + e.passageSelection.candidates, 0),
      dropped: events.reduce((s, e) => s + e.passageSelection.dropped, 0), requiredCandidates,
      requiredRetained, requiredRetention: rate(requiredRetained, requiredCandidates) },
    coverageFollowUps: events.reduce((sum, event) => sum + event.coverage.followUps, 0),
    latencyMs: Object.fromEntries((['timeToText', 'assessment', 'passageSelection', 'coverageFollowUp', 'repair', 'total'] as const)
      .map((key) => [key, component(key)])),
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
  const repairLatency = current.latencyMs.repair as { p50: number | null; p95: number | null };
  const currentTtt = current.latencyMs.timeToText as { p50: number | null; p95: number | null };
  const priorTtt = prior.latencyMs.timeToText as { p50: number | null; p95: number | null };
  const tttDelta = currentTtt.p95 === null || priorTtt.p95 === null ? null : currentTtt.p95 - priorTtt.p95;
  const costDelta = current.costPerReleasedTurn === null || prior.costPerReleasedTurn === null || prior.costPerReleasedTurn === 0
    ? null : (current.costPerReleasedTurn / prior.costPerReleasedTurn - 1) * 100;
  const retention = current.passage.requiredRetention.value;
  const compare = (value: number | null, threshold: number, direction: 'max' | 'min' = 'max', hasData = true): Status =>
    value === null || !hasData ? 'insufficient_data' : direction === 'max' ? value <= threshold ? 'pass' : 'fail' : value >= threshold ? 'pass' : 'fail';
  const limits = {
    holds: limit(compare(current.holds, CANARY_LIMITS_V1.holds, 'max', current.turns > 0), current.holds, CANARY_LIMITS_V1.holds),
    clarificationRateDeltaPp: limit(compare(clarificationDelta, CANARY_LIMITS_V1.clarificationRateDeltaPp), clarificationDelta, CANARY_LIMITS_V1.clarificationRateDeltaPp),
    repairLatencyP50Ms: limit(compare(repairLatency.p50, CANARY_LIMITS_V1.repairLatencyP50Ms, 'max', current.repair.attempted > 0), repairLatency.p50, CANARY_LIMITS_V1.repairLatencyP50Ms),
    repairLatencyP95Ms: limit(compare(repairLatency.p95, CANARY_LIMITS_V1.repairLatencyP95Ms, 'max', current.repair.attempted > 0), repairLatency.p95, CANARY_LIMITS_V1.repairLatencyP95Ms),
    passageRequiredRetention: limit(compare(retention, CANARY_LIMITS_V1.passageRequiredRetention, 'min'), retention, CANARY_LIMITS_V1.passageRequiredRetention),
    timeToTextP95DeltaMs: limit(compare(tttDelta, CANARY_LIMITS_V1.timeToTextP95DeltaMs), tttDelta, CANARY_LIMITS_V1.timeToTextP95DeltaMs),
    costPerCompletedTurnDeltaPct: limit(compare(costDelta, CANARY_LIMITS_V1.costPerCompletedTurnDeltaPct), costDelta, CANARY_LIMITS_V1.costPerCompletedTurnDeltaPct),
  };
  const payload = { version: 'meri-canary-report-v1', limitsVersion: CANARY_LIMITS_VERSION,
    sampleSizes: { canary: canary.length, baseline: baseline.length }, current, baseline: prior, limits };
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const markdown = `# Meri Stage 2 canary report\n\nHash: \`${hash}\`\n\nCanary turns: ${canary.length}; baseline turns: ${baseline.length}.\n\n## Limits\n\n| Limit | Status | Observed | Threshold |\n| --- | --- | ---: | ---: |\n${Object.entries(limits).map(([name, row]) => `| ${name} | ${row.status} | ${row.observed ?? 'n/a'} | ${row.threshold} |`).join('\n')}\n`;
  return { ...payload, hash, markdown };
}
