import type {
  CanonicalEntityRecord,
  EntityAliasInput,
  EntityIdentifierRegistrationInput,
  EntityResolutionProvenance,
  ResolveEntityInput,
} from './entity-resolution.types.js';
import type {
  EntityResolutionEvidenceKind,
  EntityResolutionStage,
} from './entity-resolution-stage-policy.js';

export const ENTITY_RESOLUTION_FALLBACK_PROVIDERS = Symbol(
  'ENTITY_RESOLUTION_FALLBACK_PROVIDERS',
);

export type EntityResolutionSourceStatus =
  | 'complete'
  | 'partial'
  | 'error'
  | 'unavailable';

export interface EntityResolutionFallbackCandidate {
  /** Stable within the provider response; not necessarily a canonical UUID. */
  candidateKey: string;
  canonicalEntity?: CanonicalEntityRecord | null;
  canonicalName: string;
  entityType: string;
  aliases?: readonly EntityAliasInput[];
  identifiers?: readonly EntityIdentifierRegistrationInput[];
  evidenceKinds: readonly EntityResolutionEvidenceKind[];
  sourceType: string;
  sourceId?: string | null;
  sourceUrl?: string | null;
  observedAt: Date;
  confidence: number;
}

export interface EntityResolutionFallbackLookupInput {
  tenantId: string;
  actorUserId: string | null;
  query: string;
  normalizedQuery: string;
  entityTypeHint: string | null;
  identifiers: ReadonlyArray<{
    type: string;
    value: string;
    normalizedValue: string;
  }>;
  priorCandidates: readonly EntityResolutionOrchestrationCandidate[];
}

export interface EntityResolutionFallbackResult {
  stage: EntityResolutionStage;
  sourceStatus: EntityResolutionSourceStatus;
  candidates: readonly EntityResolutionFallbackCandidate[];
  provenance?: readonly EntityResolutionProvenance[];
  conflictingIdentifiers?: boolean;
  stopReason?: string | null;
}

/**
 * Provider implementations read approved public/structured sources and return
 * candidates. They never write the canonical registry directly.
 */
export interface EntityResolutionFallbackProvider {
  readonly stage: EntityResolutionStage;
  lookup(
    input: EntityResolutionFallbackLookupInput,
  ): Promise<EntityResolutionFallbackResult>;
}

export interface EntityResolutionStageTrace {
  stage: EntityResolutionStage;
  sourceStatus: EntityResolutionSourceStatus;
  status: 'resolved' | 'ambiguous' | 'unresolved';
  candidateCount: number;
  resolutionMethod: string;
  stopReason: string | null;
}

export interface EntityResolutionOrchestrationCandidate {
  candidateKey: string;
  entityId: string | null;
  canonicalName: string;
  entityType: string;
  confidence: number;
  stage: EntityResolutionStage;
  sourceType: string;
  sourceId: string | null;
  sourceUrl: string | null;
  evidenceKinds: readonly EntityResolutionEvidenceKind[];
  provenance: readonly EntityResolutionProvenance[];
}

export interface UniversalEntityResolutionOrchestrationResult {
  resolutionId: string | null;
  status: 'resolved' | 'ambiguous' | 'unresolved';
  entity: CanonicalEntityRecord | null;
  confidence: number;
  resolutionMethod: string;
  candidates: EntityResolutionOrchestrationCandidate[];
  provenance: EntityResolutionProvenance[];
  requiresUserConfirmation: boolean;
  attemptedStages: EntityResolutionStageTrace[];
  publicLookupRan: boolean;
  stopReason: string;
}

export interface ResolveEntityAcrossSourcesInput extends ResolveEntityInput {
  /**
   * False by default. When false, authoritative public providers may identify
   * candidates but cannot create a new global canonical entity.
   */
  allowAuthoritativePublicRegistration?: boolean;
  /**
   * True by default for explicit identity/research flows. Set false when the
   * input originates in private evidence (for example mailbox extraction) so
   * names/emails cannot implicitly leave Capiro via website search, public web,
   * or model-assisted reconciliation. Canonical/private and approved structured
   * authoritative stages still run through this same orchestrator.
   */
  allowExternalLookup?: boolean;
}
