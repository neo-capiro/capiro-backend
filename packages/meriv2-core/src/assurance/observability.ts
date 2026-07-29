export const ASSURANCE_METRICS = [
  'unsupported_claim',
  'auditor_finding',
  'citation_failure',
  'jurisdiction_resolution_failure',
  'tool_selection_miss',
  'context_degraded',
  'context_conflicted',
  'user_correction',
  'proposal_execution_failure',
  'verification_latency',
  'generation_latency',
  'generation_cost',
  'cache_result',
  'provider_failover',
  'expert_quality',
  'canary_quality',
  'release_gate',
] as const;

export type AssuranceMetricName = (typeof ASSURANCE_METRICS)[number];

export interface AssuranceMetricEvent {
  namespace: 'Capiro/MeriAssurance';
  name: AssuranceMetricName;
  value: number;
  unit: 'Count' | 'Milliseconds' | 'Dollars' | 'Percent' | 'Score';
  at: string;
  dimensions: {
    surface?: string;
    domain?: string;
    category?: string;
    severity?: string;
    model?: string;
    provider?: string;
    outcome?: string;
    jurisdiction?: string;
    tenantCohort?: string;
  };
}

const FORBIDDEN_KEYS = new Set([
  'content',
  'body',
  'text',
  'prompt',
  'response',
  'excerpt',
  'message',
  'payload',
  'toolInput',
  'toolResult',
  'sourceExcerpt',
]);

/**
 * Build a metric event containing dimensions only. This deliberately rejects
 * content-shaped fields so SOC 2 evidence never becomes a shadow prompt log.
 */
export function assuranceMetric(input: {
  name: AssuranceMetricName;
  value?: number;
  unit?: AssuranceMetricEvent['unit'];
  at?: string | Date;
  dimensions?: AssuranceMetricEvent['dimensions'] & Record<string, unknown>;
}): AssuranceMetricEvent {
  const dimensions = input.dimensions ?? {};
  for (const key of Object.keys(dimensions)) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`Assurance metrics may not include content field: ${key}.`);
  }
  const safe: AssuranceMetricEvent['dimensions'] = {};
  for (const key of [
    'surface',
    'domain',
    'category',
    'severity',
    'model',
    'provider',
    'outcome',
    'jurisdiction',
    'tenantCohort',
  ] as const) {
    const value = dimensions[key];
    if (typeof value === 'string' && value.trim()) safe[key] = value.trim().slice(0, 120);
  }
  const date = input.at instanceof Date ? input.at : new Date(input.at ?? Date.now());
  return {
    namespace: 'Capiro/MeriAssurance',
    name: input.name,
    value: Number.isFinite(input.value) ? Number(input.value) : 1,
    unit: input.unit ?? 'Count',
    at: Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString(),
    dimensions: safe,
  };
}

export function metricLogLine(event: AssuranceMetricEvent): string {
  return JSON.stringify(event);
}
