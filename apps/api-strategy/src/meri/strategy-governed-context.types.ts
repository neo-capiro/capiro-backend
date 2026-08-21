export type StrategyGovernedOperation =
  | 'strategies.generate'
  | 'workspace.generate'
  | 'outreach.generate';

export interface StrategyContextPacketSummary {
  packetId?: string | null;
  persisted?: boolean;
  persistenceErrorCode?: string | null;
  compiledAt?: string | null;
  surface?: string | null;
  clientId?: string | null;
  items: Array<Record<string, unknown>>;
  exclusions: Array<Record<string, unknown>>;
  unauthorizedCount: number;
  degraded: boolean;
  degradedReason?: string | null;
}

/**
 * Local wire mirror of the main API's MeriGovernedTurnContext projection.
 * api-strategy intentionally does not import the Context Plane implementation;
 * it validates this untrusted cross-service payload before forwarding it.
 */
export interface StrategyGovernedTurnContext {
  version: 1;
  operationId: StrategyGovernedOperation;
  prompt: string;
  contextPacket: StrategyContextPacketSummary;
  retrieval: {
    plan: {
      version: 1;
      queryClass: string;
      subjectScope: 'client' | 'portfolio' | 'external_entity' | 'general';
      targetHint: string | null;
      recipeTool: null;
      requireCompleteCoverage: boolean;
      requiredDomains: string[];
      timeWindow: { expression: string; withinDays: number } | null;
    };
    coverage: {
      version: 1;
      complete: boolean;
      requestedDomains: string[];
      searchedDomains: string[];
      missingDomains: string[];
      partialDomains: string[];
      requestedEntityCount: number | null;
      searchedEntityCount: number | null;
      recordsEvaluated: number;
      recordsReturned: number;
      paginationComplete: boolean;
      truncated: boolean;
      sourceHealth: Array<{
        source: string;
        status: 'complete' | 'partial' | 'error' | 'unavailable';
        lastSyncAt?: string;
        detail?: string;
      }>;
      unavailableSources: Array<{ source: string; reason: string }>;
      toolsInvoked: string[];
      stopReason: string;
    };
  };
}
