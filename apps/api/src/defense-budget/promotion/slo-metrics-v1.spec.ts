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

  it('records eligibility and plan-load latency as measurement-implemented, matching what this pass wired', () => {
    expect(SLO_METRIC_WIRING_STATUS_V1.eligibility_evaluation_latency_ms).toBe(
      'MEASUREMENT_IMPLEMENTED',
    );
    expect(SLO_METRIC_WIRING_STATUS_V1.projection_plan_load_latency_ms).toBe(
      'MEASUREMENT_IMPLEMENTED',
    );
  });

  it('records every other metric as specified-not-wired, honestly, not as complete', () => {
    const notWired = SLO_METRIC_V1_VALUES.filter(
      (m) => m !== 'eligibility_evaluation_latency_ms' && m !== 'projection_plan_load_latency_ms',
    );
    for (const metric of notWired) {
      expect(SLO_METRIC_WIRING_STATUS_V1[metric]).toBe('SPECIFIED_NOT_WIRED');
    }
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
