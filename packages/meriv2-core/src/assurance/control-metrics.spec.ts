import { describe, expect, it, jest } from '@jest/globals';
import {
  buildMeriV2ControlMetricEnvelope,
  emitAssuranceGateControlMetrics,
  emitMeriV2ControlMetrics,
  meriV2ControlMetricsEnabled,
  normalizeMeriV2ControlEnvironment,
} from './control-metrics';

describe('MeriV2 control metrics', () => {
  it('normalizes deployment names to a bounded five-value dimension', () => {
    expect(normalizeMeriV2ControlEnvironment('development')).toBe('dev');
    expect(normalizeMeriV2ControlEnvironment('stage')).toBe('staging');
    expect(normalizeMeriV2ControlEnvironment('production')).toBe('prod');
    expect(normalizeMeriV2ControlEnvironment('ci')).toBe('test');
    expect(normalizeMeriV2ControlEnvironment('tenant-123')).toBe('unknown');
  });

  it('emits CloudWatch EMF with Environment as the only dimension', () => {
    const envelope = buildMeriV2ControlMetricEnvelope(
      {
        PendingCandidateOldestAgeSeconds: 90,
        ContextPacketPersistenceFailures: 1,
        UnsupportedHighRiskClaimRate: 25,
      },
      { environment: 'development', timestamp: '2026-08-01T00:00:00.000Z' },
    );
    expect(envelope.Environment).toBe('dev');
    expect(envelope._aws.CloudWatchMetrics[0]?.Dimensions).toEqual([['Environment']]);
    expect(envelope._aws.CloudWatchMetrics[0]?.Metrics).toEqual([
      { Name: 'PendingCandidateOldestAgeSeconds', Unit: 'Seconds' },
      { Name: 'ContextPacketPersistenceFailures', Unit: 'Count' },
      { Name: 'UnsupportedHighRiskClaimRate', Unit: 'Percent' },
    ]);
    expect(JSON.stringify(envelope)).not.toMatch(/tenant|user|client|prompt|content|sourceExcerpt/i);
  });

  it('clamps negative values and percentages without admitting arbitrary fields', () => {
    const envelope = buildMeriV2ControlMetricEnvelope(
      { OutboxRetryingCount: -9, UnsupportedHighRiskClaimRate: 140 },
      { environment: 'staging' },
    );
    expect(envelope.OutboxRetryingCount).toBe(0);
    expect(envelope.UnsupportedHighRiskClaimRate).toBe(100);
  });

  it('is disabled in tests unless an explicit operator forces emission', () => {
    expect(meriV2ControlMetricsEnabled({ NODE_ENV: 'test' })).toBe(false);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(emitMeriV2ControlMetrics({ SelfReviewDenials: 1 })).toBeNull();
    expect(
      emitMeriV2ControlMetrics(
        { SelfReviewDenials: 1 },
        { force: true, environment: 'test' },
      ),
    ).not.toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });

  it('maps hold/degraded outcomes and the unsupported high-risk claim rate', () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const envelope = emitAssuranceGateControlMetrics({
      decision: 'hold',
      claimCount: 4,
      unsupportedHighRiskClaimCount: 1,
    });
    expect(envelope).toEqual(
      expect.objectContaining({
        AssuranceHeldOutcomes: 1,
        AssuranceDegradedOutcomes: 1,
        UnsupportedHighRiskClaimRate: 25,
      }),
    );
    log.mockRestore();
    if (original === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = original;
  });
});
