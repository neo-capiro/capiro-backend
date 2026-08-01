import { describe, expect, test } from '@jest/globals';
import {
  PE_TRUST_ALARM_DEFINITIONS,
  PE_TRUST_METRICS,
  PE_TRUST_SOURCE_DIMENSION_VALUES,
  assertBoundedPeTrustDimensions,
  buildPeTrustSyntheticAlarmEvent,
  peTrustCatalogSeriesUpperBound,
} from './pe-trust-metric-catalog.js';

describe('pe-trust-metric-catalog (K5)', () => {
  test('catalog is bounded and names are unique', () => {
    const names = PE_TRUST_METRICS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
    expect(peTrustCatalogSeriesUpperBound()).toBeLessThanOrEqual(256);
    expect(PE_TRUST_SOURCE_DIMENSION_VALUES.length).toBeLessThanOrEqual(32);
  });

  test('assertBoundedPeTrustDimensions rejects free-text PE codes and unknown metrics', () => {
    expect(() =>
      assertBoundedPeTrustDimensions('pe_sync.error_count', { source: 'sam' }),
    ).not.toThrow();
    expect(() =>
      assertBoundedPeTrustDimensions('pe_sync.error_count', { source: '0604123A' }),
    ).toThrow(/bounded/);
    expect(() =>
      assertBoundedPeTrustDimensions('not.a.metric', { source: 'sam' }),
    ).toThrow(/Unknown/);
    expect(() =>
      assertBoundedPeTrustDimensions('pe_trust.coverage_gaps', {
        family: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      }),
    ).toThrow(/UUID/);
  });

  test('every alarm definition can build a synthetic test event', () => {
    for (const alarm of PE_TRUST_ALARM_DEFINITIONS) {
      const evt = buildPeTrustSyntheticAlarmEvent(alarm.id);
      expect(evt.type).toBe('pe_trust.synthetic_alarm_test');
      expect(evt.alarmId).toBe(alarm.id);
      expect(evt.syntheticTestEvent).toBe(alarm.syntheticTestEvent);
      expect(evt.note.toUpperCase()).toContain('SYNTHETIC');
      expect(evt.metricName).toBe(alarm.metricName);
    }
    expect(() => buildPeTrustSyntheticAlarmEvent('DoesNotExist')).toThrow(/Unknown/);
  });
});
