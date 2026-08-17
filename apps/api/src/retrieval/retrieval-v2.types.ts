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

/**
 * Phase 11 deterministic exact-retrieval vocabulary. Callers must name the
 * identifier/name family they intend; Retrieval V2 never guesses that an
 * arbitrary 5/10/12-character token is CAGE/CIK/UEI.
 */
export const EXACT_LEXICAL_KINDS = [
  'canonical_name',
  'domain',
  'uei',
  'cage',
  'cik',
  'contract_id',
  'bill_id',
  'pe_code',
  'program_name',
  'appropriation_account',
] as const;

export type ExactLexicalKind = (typeof EXACT_LEXICAL_KINDS)[number];

export interface ExactLexicalQuery {
  kind: ExactLexicalKind;
  value: string;
  /** Optional disambiguator for display-form federal bill ids such as H.R. 8800. */
  congress?: number;
}

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
 * Retrieval caller context after Phase 15 scope resolution.
 *
 * `authorized*` fields are explicit SecurityScope envelopes. They never grant
 * access: adapters must intersect them with tenant/RLS/ownership/ethical-wall
 * rules and fail closed on a mismatch. `clientIds` remains SubjectScope—the
 * subset the question is about—and must never be inferred from UI selection.
 */
export interface RetrievalCallerContext {
  tenantId: string;
  userId: string;
  authorizedClientIds?: readonly string[];
  authorizedMailboxConnectionIds?: readonly string[];
  /** Optional client subset selected by explicit SubjectScope. */
  clientIds?: readonly string[];
  /** Exact already-authorized Phase 8 graph partitions. */
  graphPartitions?: readonly TemporalKnowledgeGraphPartition[];
}

export interface RetrievalRequest {
  queryClass: RetrievalQueryClass;
  requestedDomains: readonly RetrievalDomain[];
  caller: RetrievalCallerContext;
  query?: string;
  /** Phase 11 typed exact/lexical lookup. Valid only with queryClass=lookup. */
  exactLexical?: ExactLexicalQuery;
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

/**
 * Phase 14 provider-neutral ranking hints emitted by retrieval rails. These
 * signals are operational relevance inputs only; they are not evidence,
 * coverage proof, source authority, or factual confidence and never belong in
 * the durable payload/provenance body.
 */
export interface RetrievalRecordSignals {
  lexicalExactness?: number;
  semanticSimilarity?: number;
  entityMatchConfidence?: number;
  graphRelationshipRelevance?: number;
  clientRelevance?: number;
  temporalValidity?: number;
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
  retrievalSignals?: RetrievalRecordSignals;
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

export type RetrievalRerankingStatus = 'disabled' | 'skipped' | 'applied' | 'fallback';

/** Score trace only. Scores are relevance signals and carry no factual authority. */
export interface RetrievalRerankingScore {
  domain: RetrievalDomain;
  recordId: string;
  originalRank: number;
  finalRank: number;
  score: number;
}

export interface RetrievalRerankingObservability {
  status: RetrievalRerankingStatus;
  provider: string | null;
  model: string | null;
  candidateCount: number;
  rerankedCount: number;
  durationMs: number;
  scores: RetrievalRerankingScore[];
  fallbackReason?: string;
  usage?: {
    promptTokens?: number;
    totalTokens?: number;
  };
}

export const RETRIEVAL_SCORING_SIGNALS = [
  'lexical_exactness',
  'semantic_similarity',
  'entity_match_confidence',
  'source_authority',
  'freshness',
  'graph_relationship_relevance',
  'client_relevance',
  'temporal_validity',
] as const;

export type RetrievalScoringSignal = (typeof RETRIEVAL_SCORING_SIGNALS)[number];

export type RetrievalScoringSignalClass =
  | 'relevance'
  | 'confidence'
  | 'authority'
  | 'freshness'
  | 'validity';

export interface RetrievalScoringComponent {
  signal: RetrievalScoringSignal;
  signalClass: RetrievalScoringSignalClass;
  /** Native value is used only to establish ordinal rank inside this signal. */
  rawValue: number;
  signalRank: number;
  /** Reciprocal Rank Fusion contribution = 1 / (k + signalRank). */
  contribution: number;
}

export interface RetrievalScoringScore {
  domain: RetrievalDomain;
  recordId: string;
  baselineRank: number;
  /** Candidate rank immediately before Phase 14 fusion. */
  currentRank: number;
  /** RRF-proposed rank before Phase 13 NVIDIA reranking. */
  proposedRank: number;
  /** Retrieval-priority score only; never factual confidence. */
  fusedScore: number;
  sourceAuthority: RetrievalAuthority;
  components: RetrievalScoringComponent[];
}

export interface RetrievalScoringObservability {
  status: 'disabled' | 'shadow' | 'applied';
  algorithm: 'rrf';
  rrfK: number;
  candidateCount: number;
  scoredCount: number;
  applied: boolean;
  signalsUsed: RetrievalScoringSignal[];
  scores: RetrievalScoringScore[];
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
  /** Phase 13 relevance-order trace; omitted only by legacy/direct test construction. */
  reranking?: RetrievalRerankingObservability;
  /** Phase 14 RRF decomposition; retrieval priority only, never source truth. */
  scoring?: RetrievalScoringObservability;
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
