import type { KnowledgeJsonObject, KnowledgeRef } from '../knowledge/knowledge.types.js';
import type { TemporalKnowledgeGraphPartition } from '../knowledge/graph/temporal-knowledge-graph.types.js';

export const RETRIEVAL_QUERY_CLASSES = [
  'lookup',
  'semantic_recall',
  'entity_history',
  'relationship_history',
  'temporal_state',
  'change_detection',
  'portfolio_scan',
  'exhaustive_search',
  'comparison',
  'federal_market_analysis',
] as const;

export type RetrievalQueryClass = (typeof RETRIEVAL_QUERY_CLASSES)[number];

export const RETRIEVAL_DOMAINS = [
  'clients',
  'contacts',
  'mail',
  'meetings',
  'tasks',
  'action_recommendations',
  'outreach',
  'strategies_work',
  'program_elements',
  'legiwatch_bills',
  'hearings',
  'grants',
  'contracts_opportunities',
  'federal_awards',
  'directory',
  'district_nexus',
  'institutional_knowledge',
] as const;

export type RetrievalDomain = (typeof RETRIEVAL_DOMAINS)[number];

export type RetrievalSourceStatus =
  | 'healthy'
  | 'degraded'
  | 'unavailable'
  | 'unauthorized'
  | 'unsupported'
  | 'error';

export type RetrievalAuthority =
  | 'tenant_system_of_record'
  | 'public_system_of_record'
  | 'knowledge_plane';

export type RetrievalTenantScope = 'tenant_private' | 'global_public' | 'mixed';

export interface RetrievalQueryCapabilities {
  exactFiltering: boolean;
  dateRange: boolean;
  pagination: boolean;
  exhaustiveScan: boolean;
  temporalHistory: boolean;
}

export interface SemanticDatasetDescriptor {
  domain: RetrievalDomain;
  label: string;
  description: string;
  entityKinds: readonly string[];
  sourceKind: 'live_structured' | 'knowledge_plane';
  authority: RetrievalAuthority;
  tenantScope: RetrievalTenantScope;
  temporalSemantics: string;
  supportedQueryClasses: readonly RetrievalQueryClass[];
  queryCapabilities: RetrievalQueryCapabilities;
  adapterKey: string;
  freshnessDescription: string;
}

/**
 * Phase 9 caller context only. This is deliberately not the future universal
 * ContextResolver SecurityScope/SubjectScope abstraction. It carries the
 * minimum authorization and exact graph-partition inputs required to keep
 * Retrieval V2 fail-closed today.
 */
export interface RetrievalCallerContext {
  tenantId: string;
  userId: string;
  /**
   * Optional client subset already selected by the caller. Adapters still
   * enforce tenant isolation and ethical-wall visibility; this is never an
   * authorization bypass.
   */
  clientIds?: readonly string[];
  /** Exact already-authorized Phase 8 graph partitions. */
  graphPartitions?: readonly TemporalKnowledgeGraphPartition[];
}

export interface RetrievalRequest {
  queryClass: RetrievalQueryClass;
  requestedDomains: readonly RetrievalDomain[];
  caller: RetrievalCallerContext;
  query?: string;
  canonicalEntityIds?: readonly string[];
  asOf?: Date;
  windowStart?: Date;
  windowEnd?: Date;
  observedThrough?: Date;
  edgeTypes?: readonly string[];
  pageSize?: number;
  /** Opaque per-domain cursor supplied by a previous Retrieval V2 response. */
  cursors?: Partial<Record<RetrievalDomain, string>>;
  /**
   * Forces Retrieval V2 to walk source pagination until complete or a hard
   * safety cap is reached. exhaustive_search always behaves this way.
   */
  requireComplete?: boolean;
  /** Optional metadata for deterministic observability, never model context. */
  metadata?: KnowledgeJsonObject;
}

export interface RetrievalRecord {
  domain: RetrievalDomain;
  recordId: string;
  entityRef?: KnowledgeRef;
  canonicalEntityIds?: readonly string[];
  occurredAt?: Date | null;
  updatedAt?: Date | null;
  payload: KnowledgeJsonObject;
  provenance?: KnowledgeJsonObject;
}

/**
 * Every adapter must state coverage explicitly. In particular,
 * `coverageComplete` may be true with zero records only when the adapter has
 * positively completed its authoritative scan. Returned=0 never implies it.
 */
export interface RetrievalSourceResult {
  domain: RetrievalDomain;
  records: RetrievalRecord[];
  total?: number;
  returned: number;
  hasMore: boolean;
  nextCursor?: string;
  truncated: boolean;
  sourceStatus: RetrievalSourceStatus;
  lastSyncAt?: Date;
  recordsEvaluated: number;
  requestedEntityCount: number;
  searchedEntityCount: number;
  pagesRead: number;
  paginationComplete: boolean;
  coverageComplete: boolean;
  stopReason: string;
}

export interface RetrievalSourceCoverage {
  domain: RetrievalDomain;
  sourceStatus: RetrievalSourceStatus;
  total?: number;
  returned: number;
  recordsEvaluated: number;
  requestedEntityCount: number;
  searchedEntityCount: number;
  pagesRead: number;
  hasMore: boolean;
  nextCursor?: string;
  truncated: boolean;
  paginationComplete: boolean;
  coverageComplete: boolean;
  lastSyncAt?: Date;
  stopReason: string;
}

export interface CoverageManifest {
  requestedDomains: RetrievalDomain[];
  searchedDomains: RetrievalDomain[];
  requestedEntityCount: number;
  searchedEntityCount: number;
  recordsEvaluated: number;
  recordsReturned: number;
  paginationComplete: boolean;
  unavailableSources: RetrievalDomain[];
  sources: RetrievalSourceCoverage[];
  complete: boolean;
  stopReason: string;
}

export interface RetrievalObservability {
  queryClass: RetrievalQueryClass;
  requestedDomains: RetrievalDomain[];
  queriedDatasets: RetrievalDomain[];
  requestedEntityCount: number;
  queriedEntityCount: number;
  pagesByDomain: Partial<Record<RetrievalDomain, number>>;
  sourceHealth: Partial<Record<RetrievalDomain, RetrievalSourceStatus>>;
  freshnessByDomain: Partial<Record<RetrievalDomain, Date | null>>;
  coverageComplete: boolean;
  stopReason: string;
}

export interface RetrievalResponse {
  records: RetrievalRecord[];
  coverage: CoverageManifest;
  observability: RetrievalObservability;
}

export interface RetrievalPlanEntry {
  dataset: SemanticDatasetDescriptor;
  supported: boolean;
  reason?: string;
}

export interface RetrievalPlan {
  queryClass: RetrievalQueryClass;
  requestedDomains: RetrievalDomain[];
  entries: RetrievalPlanEntry[];
}
