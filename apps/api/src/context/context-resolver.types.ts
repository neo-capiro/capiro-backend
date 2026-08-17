import type { ContextSurface as CompilerContextSurface } from '@capiro/meriv2-core';
import type { EntityIdentifierInput } from '../knowledge/entities/entity-resolution.types.js';
import type { KnowledgeRef } from '../knowledge/knowledge.types.js';
import type { TemporalKnowledgeGraphPartition } from '../knowledge/graph/temporal-knowledge-graph.types.js';
import type {
  ExactLexicalQuery,
  RetrievalDomain,
  RetrievalQueryClass,
  RetrievalRequest,
  RetrievalResponse,
} from '../retrieval/retrieval-v2.types.js';

export const CONTEXT_SUBJECT_SCOPES = [
  'client',
  'portfolio',
  'external_entity',
  'general',
] as const;

export type ContextSubjectScope = (typeof CONTEXT_SUBJECT_SCOPES)[number];

/**
 * Additional product surfaces not yet represented by the existing compiler
 * contract. Existing compiler surface names remain canonical where available.
 */
export const CONTEXT_RESOLVER_ADDITIONAL_SURFACES = [
  'portfolio',
  'client-profile',
  'engagement',
  'program-elements',
  'legiwatch',
  'hearings',
  'grants',
  'contracts',
  'directory',
  'api',
] as const;

export type ContextSurface =
  | CompilerContextSurface
  | (typeof CONTEXT_RESOLVER_ADDITIONAL_SURFACES)[number];

/**
 * The proposed authorization envelope supplied to the resolver. It never
 * replaces source adapters' tenant, ownership, RLS, or ethical-wall checks.
 */
export interface ContextSecurityScope {
  authorizedClientIds?: readonly string[];
  authorizedMailboxConnectionIds?: readonly string[];
  graphPartitions?: readonly TemporalKnowledgeGraphPartition[];
  /** Policy gate: external lookup is disabled unless explicitly allowed. */
  allowExternalLookup?: boolean;
}

export interface ContextEntitySubjectInput {
  query?: string;
  entityTypeHint?: string;
  identifiers?: readonly EntityIdentifierInput[];
  maxCandidates?: number;
  /** Request-level opt-in; SecurityScope must independently permit it. */
  allowExternalLookup?: boolean;
}

export interface ContextCurrentObject {
  type: string;
  id: string;
}

/**
 * Optional retrieval directive. Phase 15 resolves scope before constructing
 * this request; ContextPacket V2 and token compilation remain Phase 17 work.
 */
export interface ContextRetrievalDirective {
  queryClass: RetrievalQueryClass;
  requestedDomains: readonly RetrievalDomain[];
  query?: string;
  exactLexical?: ExactLexicalQuery;
  asOf?: Date;
  windowStart?: Date;
  windowEnd?: Date;
  observedThrough?: Date;
  edgeTypes?: readonly string[];
  pageSize?: number;
  cursors?: RetrievalRequest['cursors'];
  requireComplete?: boolean;
}

export interface ContextResolutionRequest {
  tenantId: string;
  actorUserId: string;
  surface: ContextSurface;
  task: string;
  securityScope: ContextSecurityScope;
  subjectScope?: ContextSubjectScope;
  subject?: ContextEntitySubjectInput;
  focusEntityRefs?: readonly KnowledgeRef[];
  /** UI-selected client. It becomes subject only when subjectScope='client'. */
  clientId?: string;
  currentObject?: ContextCurrentObject;
  /** Current-object focus is opt-in; UI presence alone never promotes it. */
  includeCurrentObjectAsFocus?: boolean;
  sessionId?: string;
  asOf?: Date;
  maxTokens?: number;
  retrieval?: ContextRetrievalDirective;
}

export type ContextResolutionStatus = 'ready' | 'ambiguous' | 'unresolved' | 'error';

export interface ContextResolvedCandidate {
  canonicalEntityId: string | null;
  canonicalName: string;
  entityType: string;
  confidence: number;
  sourceType: string;
}

export interface ContextResolvedEntity {
  status: 'resolved' | 'ambiguous' | 'unresolved' | 'error';
  canonicalEntityId?: string;
  canonicalName?: string;
  entityType?: string;
  confidence: number;
  resolutionMethod: string;
  publicLookupRan: boolean;
  stopReason: string;
  candidates: ContextResolvedCandidate[];
}

export interface NormalizedContextSecurityScope {
  tenantId: string;
  actorUserId: string;
  authorizedClientIds: string[];
  authorizedMailboxConnectionIds: string[];
  graphPartitions: TemporalKnowledgeGraphPartition[];
  allowExternalLookup: boolean;
}

export interface ResolvedContextSubjectScope {
  kind: ContextSubjectScope;
  source: 'explicit' | 'explicit_subject_input' | 'default_general';
  clientIds: string[];
}

export interface ContextResolutionTrace {
  resolverVersion: 'phase15-v1';
  uiClientSelected: boolean;
  /** Envelope membership only; source adapters perform the actual access check. */
  uiClientWithinSecurityEnvelope: boolean;
  uiClientUsedAsSubject: boolean;
  currentObjectSelected: boolean;
  currentObjectUsedAsFocus: boolean;
  externalLookupPermitted: boolean;
  externalLookupRan: boolean;
  retrievalPlanned: boolean;
}

export interface ContextResolutionResult {
  status: ContextResolutionStatus;
  stopReason: string;
  securityScope: NormalizedContextSecurityScope;
  subjectScope: ResolvedContextSubjectScope;
  subjectEntity?: ContextResolvedEntity;
  focusEntityRefs: KnowledgeRef[];
  canonicalEntityIds: string[];
  uiContext: {
    clientId?: string;
    currentObject?: ContextCurrentObject;
  };
  sessionId?: string;
  asOf?: Date;
  maxTokens?: number;
  retrievalAllowed: boolean;
  retrievalRequest?: RetrievalRequest;
  trace: ContextResolutionTrace;
}

export interface ContextRetrievalResult {
  resolution: ContextResolutionResult;
  retrieval?: RetrievalResponse;
}
