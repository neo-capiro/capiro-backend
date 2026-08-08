/**
 * Phase 7 Gap 5 decision C — SLO instrumentation contract.
 *
 * Neo's instruction: implement the *measurement*, do not invent the
 * *threshold*. Final SLO thresholds must come from the measured pre-Phase-7
 * production baseline and be approved during rollout — nothing in this
 * repository can substitute for that measurement, so nothing here tries to.
 * Every metric's threshold is the literal marker
 * `THRESHOLD_PENDING_ROLLOUT_BASELINE`, not a number, and not a TODO that
 * reads like an oversight: this is the documented, correct state until a real
 * production measurement exists.
 *
 * ---------------------------------------------------------------------------
 * What is wired versus what is only specified
 * ---------------------------------------------------------------------------
 *
 * All nine metrics Neo named are declared in `SLO_METRIC_V1_VALUES` below, so
 * the taxonomy — name, unit, dimensions — exists for every one of them and a
 * future emitter has a contract to fill in rather than a blank page. Emission
 * calls are wired into the two modules this pass already owns end-to-end and
 * can safely modify without touching anything AWS-side:
 *
 *   - `eligibility_evaluation_latency_ms`, in
 *     `DefenseBudgetPromotionEligibilityServiceV1.evaluate()`
 *     (`promotion-eligibility-service-v1.ts`).
 *   - `projection_plan_load_latency_ms`, in
 *     `PrismaProjectionPlanRepositoryV1.loadVerified` / `.loadForScope`
 *     (`projection-plan-repository-prisma-v1.ts`).
 *
 * The other seven — staging duration, activation duration, snapshot-read
 * latency, shadow mismatch, outbox backlog/age, rollback duration, DB
 * connection/load behavior — are declared here but NOT yet wired into their
 * respective services (`canonical-promotion-service-v1.ts`, snapshot
 * activation, `shadow-read-comparison-v1.ts`, the outbox drain, rollback).
 * Reported honestly as MEASUREMENT SPECIFIED, EMISSION NOT YET WIRED, in the
 * gap tracker rather than claimed alongside the two that are — wiring nine
 * emission call sites across modules outside this pass's scope in one sitting
 * risks getting several of them wrong in code nobody asked to have touched.
 *
 * ---------------------------------------------------------------------------
 * Why a sink interface, not a concrete emitter
 * ---------------------------------------------------------------------------
 *
 * Nothing in Phase 7 is deployed anywhere a real metrics backend exists to
 * receive these. A concrete CloudWatch/StatsD/OTel emitter would be answering
 * an infrastructure question nobody has asked yet — which backend, which
 * namespace, which IAM role gets to write it — so this module stops at the
 * port: `SloMetricSinkV1`. `ConsoleSloMetricSinkV1` is the only
 * implementation, safe everywhere including disposable rehearsals, and
 * `NoopSloMetricSinkV1` is the default so wiring this into a service costs
 * nothing when nobody has configured a sink.
 */

export const SLO_METRIC_V1_VALUES = [
  'eligibility_evaluation_latency_ms',
  'projection_plan_load_latency_ms',
  'snapshot_staging_duration_ms',
  'snapshot_activation_duration_ms',
  'snapshot_read_latency_ms',
  'shadow_read_mismatch_count',
  'promotion_outbox_backlog_age_ms',
  'rollback_duration_ms',
  'promotion_db_connection_saturation_ratio',
] as const;
export type SloMetricV1 = (typeof SLO_METRIC_V1_VALUES)[number];

export const SLO_METRIC_UNIT_V1 = {
  eligibility_evaluation_latency_ms: 'milliseconds',
  projection_plan_load_latency_ms: 'milliseconds',
  snapshot_staging_duration_ms: 'milliseconds',
  snapshot_activation_duration_ms: 'milliseconds',
  snapshot_read_latency_ms: 'milliseconds',
  shadow_read_mismatch_count: 'count',
  promotion_outbox_backlog_age_ms: 'milliseconds',
  rollback_duration_ms: 'milliseconds',
  promotion_db_connection_saturation_ratio: 'ratio',
} as const satisfies Record<SloMetricV1, 'milliseconds' | 'count' | 'ratio'>;

/**
 * The dimension keys each metric may carry. Declared per metric rather than
 * one shared bag, so a caller cannot tag `rollback_duration_ms` with a
 * `family` dimension that means something different there than it does on
 * `eligibility_evaluation_latency_ms`.
 */
export const SLO_METRIC_DIMENSIONS_V1 = {
  eligibility_evaluation_latency_ms: ['cycleId', 'environment', 'outcome'],
  projection_plan_load_latency_ms: ['family', 'environment'],
  snapshot_staging_duration_ms: ['domain', 'environment'],
  snapshot_activation_duration_ms: ['domain', 'environment'],
  snapshot_read_latency_ms: ['domain', 'environment', 'mode'],
  shadow_read_mismatch_count: ['domain', 'environment', 'method'],
  promotion_outbox_backlog_age_ms: ['domain', 'environment'],
  rollback_duration_ms: ['domain', 'environment'],
  promotion_db_connection_saturation_ratio: ['role', 'environment'],
} as const satisfies Record<SloMetricV1, readonly string[]>;

export const THRESHOLD_PENDING_ROLLOUT_BASELINE = 'THRESHOLD_PENDING_ROLLOUT_BASELINE' as const;

export const SLO_WIRING_STATUS_V1_VALUES = [
  'MEASUREMENT_IMPLEMENTED',
  'SPECIFIED_NOT_WIRED',
] as const;
export type SloWiringStatusV1 = (typeof SLO_WIRING_STATUS_V1_VALUES)[number];

/**
 * Which of the nine are actually emitting today. Kept as data, not prose, so
 * a test can assert it stays truthful as more get wired — an emission call
 * added to a service without updating this map is a documentation lie the
 * next reader would have no way to catch otherwise.
 */
export const SLO_METRIC_WIRING_STATUS_V1: Record<SloMetricV1, SloWiringStatusV1> = {
  eligibility_evaluation_latency_ms: 'MEASUREMENT_IMPLEMENTED',
  projection_plan_load_latency_ms: 'MEASUREMENT_IMPLEMENTED',
  snapshot_staging_duration_ms: 'SPECIFIED_NOT_WIRED',
  snapshot_activation_duration_ms: 'SPECIFIED_NOT_WIRED',
  snapshot_read_latency_ms: 'SPECIFIED_NOT_WIRED',
  shadow_read_mismatch_count: 'SPECIFIED_NOT_WIRED',
  promotion_outbox_backlog_age_ms: 'SPECIFIED_NOT_WIRED',
  rollback_duration_ms: 'SPECIFIED_NOT_WIRED',
  promotion_db_connection_saturation_ratio: 'SPECIFIED_NOT_WIRED',
};

export interface SloMetricEmissionV1 {
  metric: SloMetricV1;
  value: number;
  dimensions: Record<string, string>;
  /** Always the pending-baseline marker today; a real threshold is an
   *  operational rollout decision, never a value this module supplies. */
  threshold: typeof THRESHOLD_PENDING_ROLLOUT_BASELINE;
  timestamp: string;
}

/** The narrowest possible emission port. Implementations decide where a
 *  measurement goes; this module only decides what gets measured. */
export interface SloMetricSinkV1 {
  record(emission: SloMetricEmissionV1): void;
}

export class NoopSloMetricSinkV1 implements SloMetricSinkV1 {
  record(): void {
    // Intentionally does nothing. The correct default until a real sink is
    // configured — instrumenting a code path must never fail or slow it down
    // because nobody has wired a backend yet.
  }
}

/** Safe everywhere, including disposable rehearsals: writes one structured
 *  line per emission, nothing more. Not a production emitter — there is no
 *  production Phase 7 deployment yet for one to send to. */
export class ConsoleSloMetricSinkV1 implements SloMetricSinkV1 {
  record(emission: SloMetricEmissionV1): void {
    console.log(
      JSON.stringify({
        sloMetric: emission.metric,
        value: emission.value,
        unit: SLO_METRIC_UNIT_V1[emission.metric],
        dimensions: emission.dimensions,
        threshold: emission.threshold,
        timestamp: emission.timestamp,
      }),
    );
  }
}

export interface SloMetricRecorderOptionsV1 {
  sink: SloMetricSinkV1;
  now: () => Date;
}

/**
 * The one object every instrumented call site depends on. Keeping `record`
 * narrow (metric + value + dimensions) rather than exposing the sink directly
 * is what stops a call site from also having to know about the threshold
 * marker or the emission envelope shape.
 */
export class SloMetricRecorderV1 {
  constructor(private readonly options: SloMetricRecorderOptionsV1) {}

  record(metric: SloMetricV1, value: number, dimensions: Record<string, string>): void {
    this.options.sink.record({
      metric,
      value,
      dimensions,
      threshold: THRESHOLD_PENDING_ROLLOUT_BASELINE,
      timestamp: this.options.now().toISOString(),
    });
  }

  /** Measures the wrapped async call's wall-clock duration and records it,
   *  even if the call throws — a slow refusal is still a latency fact. */
  async timeAsync<T>(
    metric: SloMetricV1,
    dimensions: Record<string, string>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const start = this.options.now().getTime();
    try {
      return await fn();
    } finally {
      this.record(metric, this.options.now().getTime() - start, dimensions);
    }
  }
}

export const NOOP_SLO_METRIC_RECORDER_V1 = new SloMetricRecorderV1({
  sink: new NoopSloMetricSinkV1(),
  now: () => new Date(),
});
