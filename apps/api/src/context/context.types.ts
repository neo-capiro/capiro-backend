import type { TemporalKnowledgeGraphPartition } from '../knowledge/graph/temporal-knowledge-graph.types.js';
import type { KnowledgeRef } from '../knowledge/knowledge.types.js';

export const CONTEXT_SURFACES = [
  'meri',
  'workspace',
  'client_profile',
  'portfolio',
  'outreach',
  'legiwatch',
  'program_elements',
  'intelligence',
  'meeting',
  'mailbox',
  'unknown',
] as const;

export type ContextSurface = (typeof CONTEXT_SURFACES)[number];

export const CONTEXT_SUBJECT_SCOPES = [
  'client',
  'portfolio',
  'external_entity',
  'person',
  'program_element',
  'bill',
  'federal_market_topic',
  'general',
] as const;

export type ContextSubjectScope = (typeof CONTEXT_SUBJECT_SCOPES)[number];

/**
 * Caller-provided security constraints are never trusted as an authorization
 * grant. ContextSecurityScopeService rechecks client/mailbox visibility against
 * the tenant database and treats these lists only as optional upper bounds.
 */
export interface ContextSecurityScopeInput {
  authorizedClientIds?: readonly string[];
  authorizedMailboxConnectionIds?: readonly string[];
  graphPartitions?: readonly TemporalKnowledgeGraphPartition[];
  allowGlobalPublic?: boolean;
  allowExternalResearch?: boolean;
}

export interface ContextCurrentObject {
  type: string;
  id: string;
  clientId?: string;
}

export interface ContextResolutionRequest {
  tenantId: string;
  actorUserId: string;
  surface: ContextSurface;
  task: string;
  securityScope: ContextSecurityScopeInput;

  /** Explicit subject intent. UI location never fills this field implicitly. */
  subjectScope?: ContextSubjectScope;
  /** Explicit client subject, separate from the client currently open in the UI. */
  subjectClientIds?: readonly string[];
  /** Entity/topic text used by the read-only canonical resolver. */
  subjectQuery?: string;
  subjectEntityTypeHint?: string;
  focusEntityRefs?: readonly KnowledgeRef[];

  /** UI hints only. Neither field is authorization or automatic subject scope. */
  clientId?: string;
  currentObject?: ContextCurrentObject;

  sessionId?: string;
  asOf?: Date;
  maxTokens?: number;
  requiresCurrentPublicData?: boolean;
}

export interface ResolvedContextSecurityScope {
  tenantId: string;
  actorUserId: string;
  authorizedClientIds: string[];
  authorizedMailboxConnectionIds: string[];
  graphPartitions: TemporalKnowledgeGraphPartition[];
  allowGlobalPublic: boolean;
  allowExternalResearch: boolean;
}

export interface ContextEntityResolutionCandidate {
  canonicalEntityId: string;
  canonicalName: string;
  entityType: string;
  identityScope: string;
  confidence: number;
  resolutionMethod: string;
}

export interface ContextEntityResolution {
  status: 'not_requested' | 'resolved' | 'ambiguous' | 'unresolved';
  query?: string;
  canonicalEntityId?: string;
  candidates: ContextEntityResolutionCandidate[];
  reason: string;
}

export interface ResolvedContextSubjectScope {
  kind: ContextSubjectScope;
  clientIds: string[];
  query?: string;
  canonicalEntityIds: string[];
  entityResolution: ContextEntityResolution;
}

/**
 * Explicit private-data scope for later Retrieval V2 enforcement. `none` is a
 * real deny-private state and must never be translated to an omitted clientIds
 * field, because today's Retrieval V2 interprets omission as all visible clients.
 */
export type ResolvedPrivateClientScope =
  | { mode: 'none'; clientIds: [] }
  | { mode: 'client'; clientIds: string[] }
  | { mode: 'portfolio'; clientIds: string[] };

export interface ContextUiHints {
  clientId?: string;
  currentObject?: ContextCurrentObject;
  clientIsAuthorized: boolean | null;
  usedForAuthorization: false;
  usedForSubjectInference: false;
}

export interface ContextPublicResearchDecision {
  allowed: boolean;
  shouldConsider: boolean;
  reason: string;
}

export interface ContextRetrievalSeed {
  tenantId: string;
  actorUserId: string;
  privateClientScope: ResolvedPrivateClientScope;
  authorizedMailboxConnectionIds: string[];
  canonicalEntityIds: string[];
  graphPartitions: TemporalKnowledgeGraphPartition[];
  asOf?: Date;
}

export interface ContextResolutionTrace {
  surface: ContextSurface;
  subjectInference: 'explicit' | 'focus_entities' | 'subject_query' | 'default_general';
  securityClientCount: number;
  securityMailboxCount: number;
  privateClientMode: ResolvedPrivateClientScope['mode'];
  focusEntityCount: number;
  reasonCodes: string[];
}

export interface ContextResolutionResult {
  securityScope: ResolvedContextSecurityScope;
  subjectScope: ResolvedContextSubjectScope;
  focusEntities: KnowledgeRef[];
  privateClientScope: ResolvedPrivateClientScope;
  retrievalSeed: ContextRetrievalSeed;
  uiHints: ContextUiHints;
  publicResearch: ContextPublicResearchDecision;
  trace: ContextResolutionTrace;
  sessionId?: string;
  maxTokens?: number;
}

export type ContextResolutionErrorCode =
  | 'invalid_context_request'
  | 'requested_client_scope_not_fully_authorized'
  | 'requested_mailbox_scope_not_fully_authorized'
  | 'client_subject_ids_required'
  | 'subject_client_not_authorized';

export class ContextResolutionError extends Error {
  constructor(
    readonly code: ContextResolutionErrorCode,
    message: string,
    readonly details: Readonly<Record<string, number | string | boolean>> = {},
  ) {
    super(message);
    this.name = 'ContextResolutionError';
  }
}
