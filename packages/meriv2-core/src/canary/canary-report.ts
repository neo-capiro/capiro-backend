import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  CANARY_LIMITS_V1,
  CANARY_LIMITS_V2,
  CANARY_LIMITS_V2_VERSION,
  CANARY_LIMITS_VERSION,
} from './limits';

const count = z.number().int().nonnegative();
export const canaryTurnEventSchema = z.object({
  event: z.literal('meri.canary.turn'), conversationId: z.string().nullable(), tenantId: z.string(),
  surface: z.string(), modes: z.record(z.string()),
  registryVersion: z.string().optional(),
  jevTasks: z.record(z.object({ questionVersion: z.string(), modelVersion: z.string() })).optional(),
  outcome: z.enum(['released', 'held', 'error', 'aborted', 'incomplete']), clarificationRequested: z.boolean(),
  heldReason: z.string().nullable(),
  coverage: z.object({ gaps: count, followUps: count, residual: count }),
  passageSelection: z.object({ candidates: count, kept: count, dropped: count,
    requiredCandidates: count, requiredRetained: count, contradictoryRetained: count, fallback: z.boolean(),
    safetyIntervention: z.object({ evaluated: z.boolean().optional(), intervened: z.boolean(),
      reasons: z.array(z.string()) }).optional() }),
  repair: z.object({ attempted: count, corrected: count, qualified: count, omitted: count,
    documentRequested: count, budgetExhausted: count, timedOut: z.boolean().optional(),
    outcomesComplete: z.boolean().optional() }),
  repairUsage: z.enum(['not_attempted', 'measured', 'unknown']).optional(),
  latencyMs: z.object({ timeToText: count, assessment: count, passageSelection: count,
    coverageFollowUp: count, repair: count, total: count }),
  tokens: z.object({ synthesis: count, jev: count, legacy: count.nullable(), repair: count.nullable() }),
  cost: z.object({ retrievalToolCalls: count, retrievalLatencyMs: count, coverageFollowUpTokens: count,
    jevCalls: count.nullable(), legacyCalls: count.nullable(), repairLoops: count.nullable() }).optional(),
  cache: z.object({ mode: z.enum(['shadow', 'enforce']), lookups: count, hits: count, agreements: count }).optional(),
  estimatedCostUsd: z.number().nonnegative().nullable(), sampled: z.boolean(),
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
const COST_COMPONENTS = ['retrievalToolCalls', 'retrievalLatencyMs', 'coverageFollowUpTokens',
  'jevCalls', 'legacyCalls', 'repairLoops'] as const;
type LatencyComponent = (typeof LATENCY_COMPONENTS)[number];
type Percentiles = { p50: number | null; p95: number | null };

function aggregate(events: CanaryTurnEvent[], humanLabels?: Readonly<Record<string, boolean>>) {
  const released = events.filter((event) => event.outcome === 'released');
  const completed = released;
  const costValue = (event: CanaryTurnEvent, key: (typeof COST_COMPONENTS)[number]) =>
    event.cost?.[key] === undefined ? 0 : event.cost[key]!;
  const costMetric = (key: (typeof COST_COMPONENTS)[number]) => {
    const values = completed.map((event) => costValue(event, key));
    const known = values.filter((value): value is number => value !== null);
    const hasUnknown = known.length !== values.length;
    return {
      total: hasUnknown ? null : known.reduce((sum, value) => sum + value, 0),
      perCompletedTask: values.length && !hasUnknown ? known.reduce((sum, value) => sum + value, 0) / values.length : null,
      p50: percentile(known, .5),
      p95: percentile(known, .95),
      knownTurns: known.length,
      unknownTurns: values.length - known.length,
    };
  };
  const correctlyLabelled = humanLabels === undefined ? [] : completed.filter((event) =>
    event.conversationId !== null && humanLabels[event.conversationId] === true);
  // Repair counters are per claim: `attempted` counts repairable claims and a claim is
  // resolved when it ended corrected, qualified or omitted (never more than attempted).
  // A turn is fully repaired only when every attempted claim resolved, so a single
  // unresolved claim marks the whole turn.
  const repairOutcomeEvents = events.filter((event) => event.repair.outcomesComplete !== false);
  const repairs = repairOutcomeEvents.map((event) => {
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
  const repairTurns = events.filter((event) => event.repair.attempted > 0 || event.repair.timedOut === true);
  const requiredCandidates = events.reduce((sum, event) => sum + event.passageSelection.requiredCandidates, 0);
  const requiredRetained = events.reduce((sum, event) => sum + event.passageSelection.requiredRetained, 0);
  const passageSelections = events.filter((event) => event.passageSelection.safetyIntervention?.evaluated === true);
  const component = (key: LatencyComponent, sample: CanaryTurnEvent[]): Percentiles => ({
    p50: percentile(sample.map((event) => event.latencyMs[key]), .5),
    p95: percentile(sample.map((event) => event.latencyMs[key]), .95),
  });
  return {
    turns: events.length,
    outcomes: Object.fromEntries(['released', 'held', 'error', 'aborted', 'incomplete'].map((outcome) =>
      [outcome, events.filter((event) => event.outcome === outcome).length])),
    holds: events.filter((event) => event.outcome === 'held').length,
    clarification: rate(events.filter((event) => event.clarificationRequested).length, events.length),
    repair: { attempted, successful, unresolved: attempted - successful, successRate: rate(successful, attempted),
      turnsAttempted, turnsFullyRepaired, turnSuccessRate: rate(turnsFullyRepaired, turnsAttempted),
      outcomeCompleteTurns: repairOutcomeEvents.length,
      outcomeIncompleteTurns: events.length - repairOutcomeEvents.length,
      latencyTurns: repairTurns.length,
      corrected: events.reduce((s, e) => s + e.repair.corrected, 0),
      qualified: events.reduce((s, e) => s + e.repair.qualified, 0),
      omitted: events.reduce((s, e) => s + e.repair.omitted, 0) },
    passage: { candidates: events.reduce((s, e) => s + e.passageSelection.candidates, 0),
      dropped: events.reduce((s, e) => s + e.passageSelection.dropped, 0), requiredCandidates,
      requiredRetained, requiredRetention: rate(requiredRetained, requiredCandidates),
      selectionsEvaluated: passageSelections.length,
      safetyInterventions: passageSelections.filter((event) => event.passageSelection.safetyIntervention?.intervened).length,
      safetyInterventionRate: rate(passageSelections.filter((event) =>
        event.passageSelection.safetyIntervention?.intervened).length, passageSelections.length),
      safetyInterventionReasons: events.flatMap((event) => event.passageSelection.safetyIntervention?.reasons ?? [])
        .reduce<Record<string, number>>((counts, reason) => ({ ...counts, [reason]: (counts[reason] ?? 0) + 1 }), {}) },
    coverageFollowUps: events.reduce((sum, event) => sum + event.coverage.followUps, 0),
    latencyMs: Object.fromEntries(LATENCY_COMPONENTS.map((key) =>
      [key, component(key, key === 'repair' ? repairTurns : events)])) as Record<LatencyComponent, Percentiles>,
    released: released.length,
    completionRate: rate(released.length, events.length),
    errorRate: rate(events.filter((event) => event.outcome === 'error').length, events.length),
    abortRate: rate(events.filter((event) => event.outcome === 'aborted').length, events.length),
    incompleteRate: rate(events.filter((event) => event.outcome === 'incomplete').length, events.length),
    costPerReleasedTurn: released.length && released.every((event) => event.estimatedCostUsd !== null)
      ? released.reduce((sum, event) => sum + event.estimatedCostUsd!, 0) / released.length : null,
    costPerCompletedTask: {
      completed: completed.length,
      estimatedCostUsd: {
        total: completed.some((event) => event.estimatedCostUsd === null) ? null
          : completed.reduce((sum, event) => sum + (event.estimatedCostUsd ?? 0), 0),
        perCompletedTask: completed.length && completed.every((event) => event.estimatedCostUsd !== null)
          ? completed.reduce((sum, event) => sum + event.estimatedCostUsd!, 0) / completed.length : null,
        p50: percentile(completed.flatMap((event) => event.estimatedCostUsd === null ? [] : [event.estimatedCostUsd]), .5),
        p95: percentile(completed.flatMap((event) => event.estimatedCostUsd === null ? [] : [event.estimatedCostUsd]), .95),
        knownTurns: completed.filter((event) => event.estimatedCostUsd !== null).length,
        unknownTurns: completed.filter((event) => event.estimatedCostUsd === null).length,
      },
      components: Object.fromEntries(COST_COMPONENTS.map((key) => [key, costMetric(key)])),
    },
    costPerCorrectCompletedTask: humanLabels === undefined
      ? { value: null, correctCompleted: 0, reason: 'human_labels_not_supplied' }
      : correctlyLabelled.length === 0
        ? { value: null, correctCompleted: 0, reason: 'no_correct_completed_tasks' }
      : correctlyLabelled.some((event) => event.estimatedCostUsd === null)
        ? { value: null, correctCompleted: correctlyLabelled.length, reason: 'usage_unknown' }
        : { value: correctlyLabelled.reduce((sum, event) => sum + (event.estimatedCostUsd ?? 0), 0)
            / correctlyLabelled.length, correctCompleted: correctlyLabelled.length, reason: null },
  };
}

type Status = 'pass' | 'fail' | 'insufficient_data';
export type CanaryLimitsVersion = 'v1' | 'v2';
export function buildCanaryReport(
  canary: CanaryTurnEvent[],
  baseline: CanaryTurnEvent[] = [],
  options: { limitsVersion?: CanaryLimitsVersion; humanLabels?: Readonly<Record<string, boolean>> } = {},
) {
  const current = aggregate(canary, options.humanLabels); const prior = aggregate(baseline);
  const selectedVersion = options.limitsVersion ?? 'v1';
  const configured = selectedVersion === 'v2' ? CANARY_LIMITS_V2 : CANARY_LIMITS_V1;
  const limit = (status: Status, observed: number | null, threshold: number) => ({ status, observed, threshold });
  const clarificationDelta = current.clarification.value === null || prior.clarification.value === null ? null
    : (current.clarification.value - prior.clarification.value) * 100;
  const repairLatency = current.latencyMs.repair;
  const repairSampled = repairLatency.p50 !== null;
  const currentTtt = current.latencyMs.timeToText;
  const priorTtt = prior.latencyMs.timeToText;
  const tttDelta = currentTtt.p95 === null || priorTtt.p95 === null ? null : currentTtt.p95 - priorTtt.p95;
  const costDelta = current.costPerReleasedTurn === null || prior.costPerReleasedTurn === null || prior.costPerReleasedTurn === 0
    ? null : (current.costPerReleasedTurn / prior.costPerReleasedTurn - 1) * 100;
  const retention = current.passage.requiredRetention.value;
  const compare = (value: number | null, threshold: number, direction: 'max' | 'min' = 'max', hasData = true): Status =>
    value === null || !hasData ? 'insufficient_data' : direction === 'max' ? value <= threshold ? 'pass' : 'fail' : value >= threshold ? 'pass' : 'fail';
  const limits = {
    holds: limit(compare(current.holds, configured.holds, 'max', current.turns > 0), current.holds, configured.holds),
    clarificationRateDeltaPp: limit(compare(clarificationDelta, configured.clarificationRateDeltaPp), clarificationDelta, configured.clarificationRateDeltaPp),
    repairLatencyP50Ms: limit(compare(repairLatency.p50, configured.repairLatencyP50Ms, 'max', repairSampled), repairLatency.p50, configured.repairLatencyP50Ms),
    repairLatencyP95Ms: limit(compare(repairLatency.p95, configured.repairLatencyP95Ms, 'max', repairSampled), repairLatency.p95, configured.repairLatencyP95Ms),
    passageRequiredRetention: limit(compare(retention, configured.passageRequiredRetention, 'min'), retention, configured.passageRequiredRetention),
    timeToTextP95DeltaMs: limit(compare(tttDelta, configured.timeToTextP95DeltaMs), tttDelta, configured.timeToTextP95DeltaMs),
    costPerCompletedTurnDeltaPct: limit(compare(costDelta, configured.costPerCompletedTurnDeltaPct), costDelta, configured.costPerCompletedTurnDeltaPct),
  } as Record<'holds' | 'clarificationRateDeltaPp' | 'repairLatencyP50Ms' | 'repairLatencyP95Ms'
    | 'passageRequiredRetention' | 'timeToTextP95DeltaMs' | 'costPerCompletedTurnDeltaPct'
    | 'passageSafetyInterventionRate' | 'completionRateDropPp' | 'errorRateDeltaPp'
    | 'abortRateDeltaPp' | 'incompleteRateDeltaPp', ReturnType<typeof limit>>;
  if (selectedVersion === 'v2') {
    const deltaPp = (now: number | null, before: number | null) => now === null || before === null ? null : (now - before) * 100;
    const completionDrop = current.completionRate.value === null || prior.completionRate.value === null
      ? null : (prior.completionRate.value - current.completionRate.value) * 100;
    limits.passageSafetyInterventionRate = limit(compare(current.passage.safetyInterventionRate.value,
      CANARY_LIMITS_V2.passageSafetyInterventionRate), current.passage.safetyInterventionRate.value,
    CANARY_LIMITS_V2.passageSafetyInterventionRate);
    limits.completionRateDropPp = limit(compare(completionDrop, CANARY_LIMITS_V2.completionRateDropPp),
      completionDrop, CANARY_LIMITS_V2.completionRateDropPp);
    for (const [name, currentRate, priorRate, threshold] of [
      ['errorRateDeltaPp', current.errorRate.value, prior.errorRate.value, CANARY_LIMITS_V2.errorRateDeltaPp],
      ['abortRateDeltaPp', current.abortRate.value, prior.abortRate.value, CANARY_LIMITS_V2.abortRateDeltaPp],
      ['incompleteRateDeltaPp', current.incompleteRate.value, prior.incompleteRate.value, CANARY_LIMITS_V2.incompleteRateDeltaPp],
    ] as const) {
      const observed = deltaPp(currentRate, priorRate);
      limits[name] = limit(compare(observed, threshold), observed, threshold);
    }
  }
  const payload = { version: 'meri-canary-report-v1',
    limitsVersion: selectedVersion === 'v2' ? CANARY_LIMITS_V2_VERSION : CANARY_LIMITS_VERSION,
    sampleSizes: { canary: canary.length, baseline: baseline.length }, current, baseline: prior, limits };
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const repairNote = `Repair latency percentiles are taken over ${current.repair.latencyTurns} turn(s) with an attempted repair or outer-fence timeout; `
    + `repair success is per claim (${current.repair.successful}/${current.repair.attempted} resolved), `
    + `with ${current.repair.turnsFullyRepaired}/${current.repair.turnsAttempted} attempted turn(s) fully repaired.`;
  const markdown = `# Meri Stage 2 canary report\n\nHash: \`${hash}\`\n\nCanary turns: ${canary.length}; baseline turns: ${baseline.length}.\n\n## Limits\n\n| Limit | Status | Observed | Threshold |\n| --- | --- | ---: | ---: |\n${Object.entries(limits).map(([name, row]) => `| ${name} | ${row.status} | ${row.observed ?? 'n/a'} | ${row.threshold} |`).join('\n')}\n\n${repairNote}\n`;
  return { ...payload, hash, markdown };
}
