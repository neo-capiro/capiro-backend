import {
  SLO_METRIC_V1_VALUES,
  SLO_METRIC_UNIT_V1,
  SLO_METRIC_DIMENSIONS_V1,
  SLO_METRIC_WIRING_STATUS_V1,
  THRESHOLD_PENDING_ROLLOUT_BASELINE,
  SloMetricRecorderV1,
  NoopSloMetricSinkV1,
  type SloMetricEmissionV1,
  type SloMetricSinkV1,
} from './slo-metrics-v1.js';

describe('SLO metric taxonomy', () => {
  it('names all nine metrics Neo specified', () => {
    expect(SLO_METRIC_V1_VALUES).toHaveLength(9);
  });

  it('every metric has a declared unit', () => {
    for (const metric of SLO_METRIC_V1_VALUES) {
      expect(SLO_METRIC_UNIT_V1[metric]).toBeDefined();
    }
  });

  it('every metric has at least one declared dimension', () => {
    for (const metric of SLO_METRIC_V1_VALUES) {
      expect(SLO_METRIC_DIMENSIONS_V1[metric].length).toBeGreaterThan(0);
    }
  });

  it('every metric has a recorded wiring status, and the map cannot drift from the taxonomy', () => {
    expect(Object.keys(SLO_METRIC_WIRING_STATUS_V1).sort()).toEqual(
      [...SLO_METRIC_V1_VALUES].sort(),
    );
  });

  /**
   * The eight with a real emission call site. Listed explicitly rather than
   * derived as "everything except the unwired one", so that adding a tenth
   * metric fails this test until someone states which side it belongs on —
   * a derived list would silently absorb it and report a lie.
   */
  const WIRED = [
    'eligibility_evaluation_latency_ms',
    'projection_plan_load_latency_ms',
    'snapshot_staging_duration_ms',
    'snapshot_activation_duration_ms',
    'snapshot_read_latency_ms',
    'shadow_read_mismatch_count',
    'promotion_outbox_backlog_age_ms',
    'rollback_duration_ms',
  ] as const;

  it('records every wired metric as measurement-implemented', () => {
    for (const metric of WIRED) {
      expect(SLO_METRIC_WIRING_STATUS_V1[metric]).toBe('MEASUREMENT_IMPLEMENTED');
    }
  });

  /**
   * `promotion_db_connection_saturation_ratio` is the only one left, and it is
   * not an oversight — there is no pool statistic in this repository to build a
   * ratio from, and every plausible source (Prisma's `metrics` preview feature,
   * polling `pg_stat_activity`) is a deployment decision with an operator in
   * the loop. Asserted rather than left as prose so that wiring it without
   * updating the status map fails here.
   */
  it('records db connection saturation as specified-not-wired, honestly, not as complete', () => {
    expect(SLO_METRIC_WIRING_STATUS_V1.promotion_db_connection_saturation_ratio).toBe(
      'SPECIFIED_NOT_WIRED',
    );
  });

  it('the wired list plus the unwired one accounts for every declared metric', () => {
    expect([...WIRED, 'promotion_db_connection_saturation_ratio'].sort()).toEqual(
      [...SLO_METRIC_V1_VALUES].sort(),
    );
  });
});

describe('SloMetricRecorderV1', () => {
  class CapturingSink implements SloMetricSinkV1 {
    readonly emissions: SloMetricEmissionV1[] = [];
    record(emission: SloMetricEmissionV1): void {
      this.emissions.push(emission);
    }
  }

  it('never emits a numeric threshold — only the pending-baseline marker', () => {
    const sink = new CapturingSink();
    const recorder = new SloMetricRecorderV1({
      sink,
      now: () => new Date('2027-01-01T00:00:00.000Z'),
    });
    recorder.record('eligibility_evaluation_latency_ms', 42, {
      cycleId: 'c',
      environment: 'dev',
      outcome: 'ALLOWED',
    });
    expect(sink.emissions[0]!.threshold).toBe(THRESHOLD_PENDING_ROLLOUT_BASELINE);
    expect(typeof sink.emissions[0]!.threshold).toBe('string');
  });

  it('timeAsync measures wall-clock duration around the wrapped call', async () => {
    const sink = new CapturingSink();
    let tick = 0;
    const clock = () => new Date((tick += 10));
    const recorder = new SloMetricRecorderV1({ sink, now: clock });
    const result = await recorder.timeAsync(
      'projection_plan_load_latency_ms',
      { family: 'om', environment: 'dev' },
      async () => 'ok',
    );
    expect(result).toBe('ok');
    expect(sink.emissions[0]!.value).toBe(10);
  });

  it('timeAsync still records latency when the wrapped call throws', async () => {
    const sink = new CapturingSink();
    const recorder = new SloMetricRecorderV1({ sink, now: () => new Date() });
    await expect(
      recorder.timeAsync(
        'projection_plan_load_latency_ms',
        { family: 'om', environment: 'dev' },
        async () => {
          throw new Error('boom');
        },
      ),
    ).rejects.toThrow('boom');
    expect(sink.emissions).toHaveLength(1);
  });

  it('the noop sink never throws and records nothing observable', () => {
    const recorder = new SloMetricRecorderV1({
      sink: new NoopSloMetricSinkV1(),
      now: () => new Date(),
    });
    expect(() =>
      recorder.record('shadow_read_mismatch_count', 1, {
        domain: 'd',
        environment: 'dev',
        method: 'x',
      }),
    ).not.toThrow();
  });
});
