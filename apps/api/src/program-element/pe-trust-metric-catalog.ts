/**
 * Bounded-cardinality PE trust CloudWatch metric + alarm catalog (Phase K).
 *
 * Dimensions are intentionally small and enum-like. Callers MUST NOT attach
 * free-text PE codes, tenant ids, or user ids as metric dimensions (cardinality
 * explosion / SOC cost risk). Deploy/schedule changes are OUT of scope here —
 * this file documents definitions only; CDK wires a subset.
 */
export const PE_TRUST_METRIC_NAMESPACE = 'Capiro/ProgramElementSync';

/** Allowed dimension keys for PE trust metrics. */
export const PE_TRUST_ALLOWED_DIMENSION_KEYS = ['source', 'family', 'severity'] as const;
export type PeTrustDimensionKey = (typeof PE_TRUST_ALLOWED_DIMENSION_KEYS)[number];

/** Allowed source dimension values (bounded). */
export const PE_TRUST_SOURCE_DIMENSION_VALUES = [
  'r_doc',
  'p_doc',
  'o_doc',
  'hasc_sasc',
  'approps',
  'ndaa',
  'sam',
  'derive_chain',
  'outbox',
  'aggregate',
  'unknown',
] as const;

export type PeTrustSourceDimension = (typeof PE_TRUST_SOURCE_DIMENSION_VALUES)[number];

export type PeTrustMetricUnit = 'Count' | 'Seconds' | 'None' | 'Percent';

export interface PeTrustMetricDefinition {
  /** CloudWatch metric name */
  name: string;
  unit: PeTrustMetricUnit;
  /** Human description */
  description: string;
  /** Dimension keys required when emitting (subset of allowed). */
  dimensions: readonly PeTrustDimensionKey[];
  /** Soft upper bound hint for dashboards (not enforced at emit). */
  cardinalityBound: number;
}

export const PE_TRUST_METRICS: readonly PeTrustMetricDefinition[] = [
  {
    name: 'pe_sync.error_count',
    unit: 'Count',
    description: 'PE sync error count per source family',
    dimensions: ['source'],
    cardinalityBound: PE_TRUST_SOURCE_DIMENSION_VALUES.length,
  },
  {
    name: 'pe_sync.rows_inserted',
    unit: 'Count',
    description: 'Rows inserted by PE sync',
    dimensions: ['source'],
    cardinalityBound: PE_TRUST_SOURCE_DIMENSION_VALUES.length,
  },
  {
    name: 'pe_sync.rows_updated',
    unit: 'Count',
    description: 'Rows updated by PE sync',
    dimensions: ['source'],
    cardinalityBound: PE_TRUST_SOURCE_DIMENSION_VALUES.length,
  },
  {
    name: 'pe_sync.duration_seconds',
    unit: 'Seconds',
    description: 'PE sync wall time',
    dimensions: ['source'],
    cardinalityBound: PE_TRUST_SOURCE_DIMENSION_VALUES.length,
  },
  {
    name: 'pe_sync.quarantine_count',
    unit: 'Count',
    description: 'Quarantined PE observations',
    dimensions: ['source'],
    cardinalityBound: PE_TRUST_SOURCE_DIMENSION_VALUES.length,
  },
  {
    name: 'pe_sync.rows_in_db',
    unit: 'Count',
    description: 'Total PE rows gauge',
    dimensions: ['source'],
    cardinalityBound: 1,
  },
  {
    name: 'pe_trust.duplicate_observation_groups',
    unit: 'Count',
    description: 'Duplicate observation groups detected by trust diagnostics',
    dimensions: ['severity'],
    cardinalityBound: 3,
  },
  {
    name: 'pe_trust.pending_outbox',
    unit: 'Count',
    description: 'Pending PE change-outbox depth',
    dimensions: ['severity'],
    cardinalityBound: 3,
  },
  {
    name: 'pe_trust.open_reconciliation',
    unit: 'Count',
    description: 'Open PE reconciliation items',
    dimensions: ['severity'],
    cardinalityBound: 3,
  },
  {
    name: 'pe_trust.sam_partial_runs',
    unit: 'Count',
    description: 'Partial/incomplete SAM window runs',
    dimensions: ['source'],
    cardinalityBound: 2,
  },
  {
    name: 'pe_trust.stale_cache_entries',
    unit: 'Count',
    description: 'Stale PE derive/intel cache entries',
    dimensions: ['family'],
    cardinalityBound: 8,
  },
  {
    name: 'pe_trust.coverage_gaps',
    unit: 'Count',
    description: 'Honest coverage-matrix gaps (panel/family)',
    dimensions: ['family'],
    cardinalityBound: 32,
  },
  {
    name: 'pe_trust.accuracy.precision',
    unit: 'None',
    description: 'Separated precision from human-reviewed golden harness',
    dimensions: ['family'],
    cardinalityBound: 16,
  },
  {
    name: 'pe_trust.accuracy.recall',
    unit: 'None',
    description: 'Separated recall from human-reviewed golden harness',
    dimensions: ['family'],
    cardinalityBound: 16,
  },
] as const;

export interface PeTrustAlarmDefinition {
  id: string;
  alarmNameSuffix: string;
  description: string;
  metricName: string;
  threshold: number;
  comparison: 'gt' | 'gte' | 'lt' | 'lte';
  evaluationPeriods: number;
  datapointsToAlarm: number;
  periodMinutes: number;
  /** Synthetic test event payload key for gate verification (no deploy). */
  syntheticTestEvent: string;
}

export const PE_TRUST_ALARM_DEFINITIONS: readonly PeTrustAlarmDefinition[] = [
  {
    id: 'PeSyncErrorAlarm',
    alarmNameSuffix: 'pe-sync-error',
    description: 'PE sync errors detected for 2 consecutive runs',
    metricName: 'pe_sync.error_count',
    threshold: 0,
    comparison: 'gt',
    evaluationPeriods: 2,
    datapointsToAlarm: 2,
    periodMinutes: 15,
    syntheticTestEvent: 'pe_trust.synthetic.pe_sync.error_count',
  },
  {
    id: 'PeSyncStaleBySourceAlarm',
    alarmNameSuffix: 'pe-sync-stale-by-source',
    description: 'PE sync had zero inserted+updated rows for 3 consecutive runs',
    metricName: 'pe_sync.rows_inserted',
    threshold: 0,
    comparison: 'lte',
    evaluationPeriods: 3,
    datapointsToAlarm: 3,
    periodMinutes: 15,
    syntheticTestEvent: 'pe_trust.synthetic.pe_sync.stale_rows',
  },
  {
    id: 'PeSyncDurationAlarm',
    alarmNameSuffix: 'pe-sync-duration',
    description: 'PE sync duration exceeded 1800 seconds',
    metricName: 'pe_sync.duration_seconds',
    threshold: 1800,
    comparison: 'gt',
    evaluationPeriods: 1,
    datapointsToAlarm: 1,
    periodMinutes: 15,
    syntheticTestEvent: 'pe_trust.synthetic.pe_sync.duration_seconds',
  },
  {
    id: 'PeTrustDuplicateObservationsAlarm',
    alarmNameSuffix: 'pe-trust-duplicate-observations',
    description: 'Duplicate PE observation groups > 0',
    metricName: 'pe_trust.duplicate_observation_groups',
    threshold: 0,
    comparison: 'gt',
    evaluationPeriods: 1,
    datapointsToAlarm: 1,
    periodMinutes: 60,
    syntheticTestEvent: 'pe_trust.synthetic.duplicate_observation_groups',
  },
  {
    id: 'PeTrustPendingOutboxAlarm',
    alarmNameSuffix: 'pe-trust-pending-outbox',
    description: 'Pending PE outbox depth above threshold',
    metricName: 'pe_trust.pending_outbox',
    threshold: 100,
    comparison: 'gt',
    evaluationPeriods: 2,
    datapointsToAlarm: 2,
    periodMinutes: 60,
    syntheticTestEvent: 'pe_trust.synthetic.pending_outbox',
  },
  {
    id: 'PeTrustSamPartialAlarm',
    alarmNameSuffix: 'pe-trust-sam-partial',
    description: 'Partial SAM runs detected',
    metricName: 'pe_trust.sam_partial_runs',
    threshold: 0,
    comparison: 'gt',
    evaluationPeriods: 1,
    datapointsToAlarm: 1,
    periodMinutes: 60,
    syntheticTestEvent: 'pe_trust.synthetic.sam_partial_runs',
  },
] as const;

/** Build a synthetic alarm test event (JSON-serializable). Does not publish. */
export function buildPeTrustSyntheticAlarmEvent(
  alarmId: string,
  overrides?: { value?: number; at?: string },
): {
  type: 'pe_trust.synthetic_alarm_test';
  alarmId: string;
  syntheticTestEvent: string;
  metricName: string;
  value: number;
  at: string;
  note: string;
} {
  const def = PE_TRUST_ALARM_DEFINITIONS.find((a) => a.id === alarmId);
  if (!def) {
    throw new Error(`Unknown PE trust alarm id: ${alarmId}`);
  }
  const value =
    overrides?.value ??
    (def.comparison === 'gt' || def.comparison === 'gte'
      ? def.threshold + 1
      : Math.max(0, def.threshold - 1));
  return {
    type: 'pe_trust.synthetic_alarm_test',
    alarmId: def.id,
    syntheticTestEvent: def.syntheticTestEvent,
    metricName: def.metricName,
    value,
    at: overrides?.at ?? new Date(0).toISOString(),
    note: 'SYNTHETIC test event only — not emitted to CloudWatch by the permanent gate. Operators may publish manually; Phase 8 does not deploy schedule changes.',
  };
}

/**
 * Validate emit dimensions stay inside the bounded catalog.
 * Free-text / high-cardinality values are rejected.
 */
export function assertBoundedPeTrustDimensions(
  metricName: string,
  dimensions: Record<string, string>,
): void {
  const metric = PE_TRUST_METRICS.find((m) => m.name === metricName);
  if (!metric) {
    throw new Error(`Unknown PE trust metric: ${metricName}`);
  }
  for (const key of Object.keys(dimensions)) {
    if (!(PE_TRUST_ALLOWED_DIMENSION_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Dimension key "${key}" is not allowed for PE trust metrics`);
    }
    if (!metric.dimensions.includes(key as PeTrustDimensionKey)) {
      throw new Error(`Metric ${metricName} does not declare dimension "${key}"`);
    }
  }
  if (dimensions.source) {
    if (!(PE_TRUST_SOURCE_DIMENSION_VALUES as readonly string[]).includes(dimensions.source)) {
      throw new Error(
        `source dimension "${dimensions.source}" is outside the bounded PE trust catalog`,
      );
    }
  }
  for (const [k, v] of Object.entries(dimensions)) {
    if (v.length > 64) {
      throw new Error(`Dimension ${k} value exceeds 64 chars (cardinality/safety bound)`);
    }
    // Block UUID-shaped / peCode-shaped runaway values on non-source keys lightly
    if (k !== 'source' && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v)) {
      throw new Error(`Dimension ${k} looks like a UUID — forbidden high-cardinality value`);
    }
  }
}

/** Total theoretical series upper bound (catalog × worst dimension fanout). */
export function peTrustCatalogSeriesUpperBound(): number {
  return PE_TRUST_METRICS.reduce((sum, m) => sum + m.cardinalityBound, 0);
}
