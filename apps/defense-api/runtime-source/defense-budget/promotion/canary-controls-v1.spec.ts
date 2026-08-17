import { CanaryMismatchAggregatorV1, resolveCanaryRollbackV1 } from './canary-controls-v1.js';
import type { ShadowComparisonV1 } from './shadow-read-comparison-v1.js';

function comparison(
  severity: ShadowComparisonV1['severity'],
): Pick<ShadowComparisonV1, 'severity'> {
  return { severity };
}

describe('resolveCanaryRollbackV1', () => {
  it('defaults to not forcing legacy when the switch is off', () => {
    expect(resolveCanaryRollbackV1({ rollbackEngaged: false })).toEqual({
      forceLegacy: false,
      reason: 'rollback_not_engaged',
    });
  });

  it('forces legacy unconditionally when the switch is engaged', () => {
    expect(resolveCanaryRollbackV1({ rollbackEngaged: true })).toEqual({
      forceLegacy: true,
      reason: 'rollback_engaged',
    });
  });
});

describe('CanaryMismatchAggregatorV1', () => {
  it('reports a healthy, unblocked canary with no observations', () => {
    const report = new CanaryMismatchAggregatorV1().report();
    expect(report).toEqual({
      compared: 0,
      matched: 0,
      mismatched: 0,
      mismatchRate: 0,
      worstSeverity: 'none',
      shouldHaltCanary: false,
      severityCounts: { none: 0, p2: 0, p1: 0, p0: 0 },
    });
  });

  it('computes the mismatch rate over recorded comparisons', () => {
    const aggregator = new CanaryMismatchAggregatorV1();
    aggregator.record(comparison('none'));
    aggregator.record(comparison('none'));
    aggregator.record(comparison('p2'));
    aggregator.record(comparison('p1'));
    const report = aggregator.report();
    expect(report.compared).toBe(4);
    expect(report.matched).toBe(2);
    expect(report.mismatched).toBe(2);
    expect(report.mismatchRate).toBe(0.5);
  });

  it('reports the worst severity seen, not the most recent', () => {
    const aggregator = new CanaryMismatchAggregatorV1();
    aggregator.record(comparison('p0'));
    aggregator.record(comparison('none'));
    aggregator.record(comparison('p2'));
    expect(aggregator.report().worstSeverity).toBe('p0');
  });

  it('halts the canary the instant any observation blocks it, never diluted by an average', () => {
    const aggregator = new CanaryMismatchAggregatorV1();
    for (let i = 0; i < 99; i++) aggregator.record(comparison('none'));
    aggregator.record(comparison('p0'));
    const report = aggregator.report();
    expect(report.mismatchRate).toBeCloseTo(0.01);
    expect(report.shouldHaltCanary).toBe(true);
  });

  it('does not halt on p2-only mismatches, matching blocksCanaryV1', () => {
    const aggregator = new CanaryMismatchAggregatorV1();
    aggregator.record(comparison('p2'));
    expect(aggregator.report().shouldHaltCanary).toBe(false);
  });

  it('evicts the oldest observation once the window is full', () => {
    const aggregator = new CanaryMismatchAggregatorV1(3);
    aggregator.record(comparison('p0'));
    aggregator.record(comparison('none'));
    aggregator.record(comparison('none'));
    aggregator.record(comparison('none'));
    const report = aggregator.report();
    expect(report.compared).toBe(3);
    expect(report.worstSeverity).toBe('none');
    expect(report.shouldHaltCanary).toBe(false);
  });

  it('refuses a non-positive window size', () => {
    expect(() => new CanaryMismatchAggregatorV1(0)).toThrow();
    expect(() => new CanaryMismatchAggregatorV1(-1)).toThrow();
  });

  it('counts every severity bucket', () => {
    const aggregator = new CanaryMismatchAggregatorV1();
    aggregator.record(comparison('none'));
    aggregator.record(comparison('p2'));
    aggregator.record(comparison('p1'));
    aggregator.record(comparison('p0'));
    expect(aggregator.report().severityCounts).toEqual({ none: 1, p2: 1, p1: 1, p0: 1 });
  });
});
