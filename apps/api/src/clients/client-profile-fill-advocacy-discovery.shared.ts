import type { TenantContext } from '@capiro/shared';
import type {
  AdvocacyBackfillOverallStatus,
  AdvocacySourceBackfillState,
} from './client-profile-fill-advocacy-health.js';

export const MAX_ADVOCACY_FINDINGS = 200;

export interface AdvocacyHistoryTaskResult {
  [key: string]: unknown;
  count: number;
  overallStatus: AdvocacyBackfillOverallStatus;
  sources: Record<string, AdvocacySourceBackfillState>;
}

export interface CompletionFindingInput {
  kind: string;
  targetKey: string;
  source: string;
  factKind: 'fact' | 'recommendation';
  currentValue: unknown;
  proposedValue: unknown;
  confidence: number;
  evidence: unknown[];
  status: 'pending' | 'informational';
}

export interface DiscoveryFinding {
  externalKey: string;
  isConfirmed: boolean;
  confidence: number;
  proposedValue: unknown;
  evidence: unknown[];
}

export interface AdvocacyDiscoveryPorts {
  resolveClientName(ctx: TenantContext, clientId: string): Promise<string | null>;
  confirmedMappingKeys(ctx: TenantContext, clientId: string, source: string): Promise<Set<string>>;
  emitFinding(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    input: DiscoveryFinding,
  ): Promise<boolean>;
  persistFinding(
    tenantId: string,
    clientId: string,
    runId: string,
    input: CompletionFindingInput,
  ): Promise<boolean>;
  warn(message: string): void;
  safeError(error: unknown): string;
}

export type PublicAdvocacyDiscoveryPorts = Pick<
  AdvocacyDiscoveryPorts,
  'resolveClientName' | 'confirmedMappingKeys' | 'emitFinding' | 'warn' | 'safeError'
>;

export type TenantAdvocacyDiscoveryPorts = Pick<
  AdvocacyDiscoveryPorts,
  'persistFinding' | 'warn' | 'safeError'
>;

export interface AdvocacyHistoryPorts extends AdvocacyDiscoveryPorts {
  readCursor(tenantId: string, clientId: string, source: string): Promise<Record<string, unknown>>;
  recordCursor(
    tenantId: string,
    clientId: string,
    source: string,
    watermark: Record<string, unknown>,
  ): Promise<void>;
  readSchedule(
    ctx: TenantContext,
    clientId: string,
  ): Promise<{ cadenceHours: number; nextRunAt: Date | null }>;
}
