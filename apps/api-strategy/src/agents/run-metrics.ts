/*
 * Stage H run-metrics stamp. PURE module (no Nest, no DB, no deps) — same
 * discipline as run-state.ts / risk-router.ts. Merges an observability
 * `metrics` object (model / prompt-spec version / phase latency / last phase)
 * onto a run's findings JSON, ADDITIVELY: the sibling keys the run lifecycle
 * owns (execution / tasks / g0 / results / sendApproval / calendarFingerprint /
 * findings …) are preserved untouched, and a later stamp MERGES onto the prior
 * metrics rather than replacing them (so an earlier phase's model survives a
 * later phase that only carries latency).
 *
 * DOCUMENTED SEAM: the shared aiUsageEvent table (agent_run_id linkage, real
 * token $ cost) lives in apps/api — a cross-app migration is out of scope for
 * this stage. Until it lands, the orchestrator's `workflow` usage tag plus this
 * findings.metrics blob carry the model / latency signal for a run.
 */

export interface RunMetricsInput {
  /** The phase that just finished (e.g. 'plan', 'execute', 'check'). Required. */
  phase: string;
  /** Model id the phase used, when an LLM ran (deterministic phases omit it). */
  model?: string;
  /** Prompt / tool-spec version stamp, when applicable. */
  promptSpecVersion?: string;
  /** Wall-clock latency of the phase, in milliseconds. */
  latencyMs?: number;
}

/** The shape written to run.findings.metrics. Only `lastPhase` is guaranteed. */
export interface RunMetrics {
  lastPhase: string;
  model?: string;
  promptSpecVersion?: string;
  latencyMs?: number;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Return a NEW findings object with `metrics` merged in. Pure — never mutates
 * its argument. A non-object `existingFindings` (null / array / scalar) is
 * treated as an empty base, so the result is always a plain object carrying at
 * least `{ metrics: { lastPhase } }`. Undefined input fields are OMITTED (never
 * written as null), and a non-finite latency is dropped.
 */
export function stampRunMetrics(
  existingFindings: unknown,
  input: RunMetricsInput,
): Record<string, unknown> {
  const base = { ...(asObject(existingFindings) ?? {}) };
  const prev = asObject(base.metrics) ?? {};
  const metrics: RunMetrics = { ...(prev as Partial<RunMetrics>), lastPhase: input.phase };
  if (input.model !== undefined) metrics.model = input.model;
  if (input.promptSpecVersion !== undefined) metrics.promptSpecVersion = input.promptSpecVersion;
  if (typeof input.latencyMs === 'number' && Number.isFinite(input.latencyMs)) {
    metrics.latencyMs = input.latencyMs;
  }
  base.metrics = metrics;
  return base;
}
