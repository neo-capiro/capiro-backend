import { describe, expect, test } from '@jest/globals';
import {
  recallOutcomeMetric,
  recallOutcomeSummary,
} from './meri-context-metrics.helpers.js';

const AT = '2026-07-20T00:00:00.000Z';

describe('recallOutcomeMetric (Phase 7A EMF)', () => {
  test('emits a Capiro/MeriContext EMF payload with the outcome + count', () => {
    const m = recallOutcomeMetric('hit', 'union', 5, AT);
    expect(m._aws.CloudWatchMetrics[0]?.Namespace).toBe('Capiro/MeriContext');
    expect(m.MetricName).toBe('memory.recall');
    expect(m.Value).toBe(1);
    expect(m.outcome).toBe('hit');
    expect(m.recallSource).toBe('union');
    expect(m.count).toBe(5);
    expect(m.Timestamp).toBe(AT);
    // JSON-serializable (it gets logged via JSON.stringify).
    expect(() => JSON.stringify(m)).not.toThrow();
  });

  test('the silent fail-open case is a first-class error outcome', () => {
    const m = recallOutcomeMetric('error', 'clio', 0, AT);
    expect(m.outcome).toBe('error');
    expect(m.count).toBe(0);
  });

  test('declares outcome + recallSource dimensions', () => {
    const dims = recallOutcomeMetric('empty', 'clio', 0, AT)._aws.CloudWatchMetrics[0]?.Dimensions;
    expect(dims).toContainEqual(['outcome']);
    expect(dims).toContainEqual(['outcome', 'recallSource']);
  });

  test('summary line is human-scannable', () => {
    expect(recallOutcomeSummary('error', 'projection', 0)).toBe(
      'meri.memory_recall outcome=error source=projection count=0',
    );
  });
});
