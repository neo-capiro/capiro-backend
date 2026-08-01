export const MERIV2_CONTROL_NAMESPACE = 'Capiro/MeriV2Control' as const;

export const MERIV2_CONTROL_METRIC_NAMES = [
  'PendingCandidateOldestAgeSeconds',
  'SelfReviewDenials',
  'EthicalWallDenials',
  'ConflictedMemoryCount',
  'ContextPacketPersistenceFailures',
  'AssuranceHeldOutcomes',
  'AssuranceDegradedOutcomes',
  'UnsupportedHighRiskClaimRate',
  'OutboxOldestAgeSeconds',
  'OutboxRetryingCount',
  'OutboxDeadLetterCount',
  'PolicyDriftInvalidations',
  'BackfillQuarantineCount',
  'BackfillDriftCount',
  'ControlMonitorFailures',
] as const;

export type MeriV2ControlMetricName = (typeof MERIV2_CONTROL_METRIC_NAMES)[number];
export type MeriV2ControlMetricValues = Partial<Record<MeriV2ControlMetricName, number>>;
export type MeriV2ControlEnvironment = 'dev' | 'staging' | 'prod' | 'test' | 'unknown';
export type MeriV2ControlMetricUnit = 'Count' | 'Seconds' | 'Percent';

const UNIT_BY_METRIC: Record<MeriV2ControlMetricName, MeriV2ControlMetricUnit> = {
  PendingCandidateOldestAgeSeconds: 'Seconds',
  SelfReviewDenials: 'Count',
  EthicalWallDenials: 'Count',
  ConflictedMemoryCount: 'Count',
  ContextPacketPersistenceFailures: 'Count',
  AssuranceHeldOutcomes: 'Count',
  AssuranceDegradedOutcomes: 'Count',
  UnsupportedHighRiskClaimRate: 'Percent',
  OutboxOldestAgeSeconds: 'Seconds',
  OutboxRetryingCount: 'Count',
  OutboxDeadLetterCount: 'Count',
  PolicyDriftInvalidations: 'Count',
  BackfillQuarantineCount: 'Count',
  BackfillDriftCount: 'Count',
  ControlMonitorFailures: 'Count',
};

interface CloudWatchMetricDefinition {
  Name: MeriV2ControlMetricName;
  Unit: MeriV2ControlMetricUnit;
}

export interface MeriV2ControlMetricEnvelope extends Record<string, unknown> {
  _aws: {
    Timestamp: number;
    CloudWatchMetrics: Array<{
      Namespace: typeof MERIV2_CONTROL_NAMESPACE;
      Dimensions: [['Environment']];
      Metrics: CloudWatchMetricDefinition[];
    }>;
  };
  Environment: MeriV2ControlEnvironment;
  event: 'meriv2.control.metrics';
}

export interface EmitMeriV2ControlMetricOptions {
  environment?: string;
  timestamp?: string | number | Date;
  /** Bypasses the test/runtime emission switch for explicit scheduled operators. */
  force?: boolean;
}

/**
 * The only CloudWatch dimension is a five-value deployment environment. Tenant,
 * user, client, model, prompt, policy version, tool, and source identifiers are
 * deliberately excluded so control evidence cannot create unbounded cardinality
 * or become a shadow customer-content log.
 */
export function normalizeMeriV2ControlEnvironment(raw: unknown): MeriV2ControlEnvironment {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === 'dev' || value === 'development' || value === 'local') return 'dev';
  if (value === 'stage' || value === 'staging') return 'staging';
  if (value === 'prod' || value === 'production') return 'prod';
  if (value === 'test' || value === 'testing' || value === 'ci') return 'test';
  return 'unknown';
}

export function meriV2ControlMetricsEnabled(
  env: Record<string, string | undefined> | undefined = runtimeEnvironment(),
): boolean {
  if (!env) return false;
  if (String(env.MERIV2_CONTROL_METRICS ?? '').trim().toLowerCase() === 'off') return false;
  return normalizeMeriV2ControlEnvironment(env.CAPIRO_ENV ?? env.NODE_ENV) !== 'test';
}

export function buildMeriV2ControlMetricEnvelope(
  values: MeriV2ControlMetricValues,
  options: EmitMeriV2ControlMetricOptions = {},
): MeriV2ControlMetricEnvelope {
  const metrics: CloudWatchMetricDefinition[] = [];
  const normalizedValues: Record<string, number> = {};

  for (const name of MERIV2_CONTROL_METRIC_NAMES) {
    const value = values[name];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const unit = UNIT_BY_METRIC[name];
    normalizedValues[name] =
      unit === 'Percent' ? Math.min(100, Math.max(0, value)) : Math.max(0, value);
    metrics.push({ Name: name, Unit: unit });
  }
  if (metrics.length === 0) throw new Error('At least one finite MeriV2 control metric is required.');

  const timestamp = normalizeTimestamp(options.timestamp);
  const environment = normalizeMeriV2ControlEnvironment(
    options.environment ?? runtimeEnvironment()?.CAPIRO_ENV ?? runtimeEnvironment()?.NODE_ENV,
  );

  return {
    _aws: {
      Timestamp: timestamp,
      CloudWatchMetrics: [
        {
          Namespace: MERIV2_CONTROL_NAMESPACE,
          Dimensions: [['Environment']],
          Metrics: metrics,
        },
      ],
    },
    Environment: environment,
    event: 'meriv2.control.metrics',
    ...normalizedValues,
  };
}

/** Best-effort observability must never change the release or authorization result. */
export function emitMeriV2ControlMetrics(
  values: MeriV2ControlMetricValues,
  options: EmitMeriV2ControlMetricOptions = {},
): MeriV2ControlMetricEnvelope | null {
  if (!options.force && !meriV2ControlMetricsEnabled()) return null;
  try {
    const envelope = buildMeriV2ControlMetricEnvelope(values, options);
    // One-line EMF JSON. No bodies, prompts, source excerpts, ids, or error text.
    console.log(JSON.stringify(envelope));
    return envelope;
  } catch {
    return null;
  }
}

export function emitAssuranceGateControlMetrics(input: {
  decision: 'deliver' | 'deliver_with_flags' | 'repair' | 'hold';
  claimCount: number;
  unsupportedHighRiskClaimCount: number;
}): MeriV2ControlMetricEnvelope | null {
  const values: MeriV2ControlMetricValues = {
    UnsupportedHighRiskClaimRate:
      input.claimCount > 0 ? (input.unsupportedHighRiskClaimCount / input.claimCount) * 100 : 0,
  };
  if (input.decision === 'hold' || input.decision === 'repair') {
    values.AssuranceHeldOutcomes = 1;
  }
  if (input.decision !== 'deliver') values.AssuranceDegradedOutcomes = 1;
  return emitMeriV2ControlMetrics(values);
}

function normalizeTimestamp(value: string | number | Date | undefined): number {
  if (value === undefined) return Date.now();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.getTime() : Date.now();
}

function runtimeEnvironment(): Record<string, string | undefined> | undefined {
  return typeof process !== 'undefined' && process.env ? process.env : undefined;
}
