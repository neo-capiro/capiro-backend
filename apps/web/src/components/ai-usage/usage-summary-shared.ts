/**
 * UI-free AI-usage summary types + formatters — extracted from
 * UsageSummaryPanels.tsx (antd + recharts) so the vNext Settings module shares
 * them (extraction pattern, purge Phase 2). UsageSummaryPanels re-exports;
 * its public API is unchanged.
 */

export interface UsageBucket {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  count: number;
}

export interface TenantUsageSummary {
  from: string;
  to: string;
  eventCount: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  tenantKeyEventCount: number;
  byWorkflow: Array<UsageBucket & { workflow: string }>;
  byModel: Array<UsageBucket & { model: string }>;
  byDay: Array<UsageBucket & { day: string }>;
}

export interface MaskedAiCredential {
  provider: string;
  last4: string;
  modelOverride: string | null;
  status: string;
  lastValidatedAt: string | null;
  updatedAt: string | null;
}

/** $12.35 above a dollar, $0.0123 below — generation costs are tiny. */
export function fmtUsd(value: number): string {
  return value >= 1 || value === 0 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`;
}

export function fmtTokens(value: number): string {
  return value.toLocaleString('en-US');
}
