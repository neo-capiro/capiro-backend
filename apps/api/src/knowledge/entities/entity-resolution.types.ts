export const CANONICAL_ENTITY_SCOPES = ['global_public', 'tenant_private'] as const;
export type CanonicalEntityScope = (typeof CANONICAL_ENTITY_SCOPES)[number];

export const CANONICAL_ENTITY_TYPES = [
  'organization',
  'person',
  'agency',
  'committee',
  'office',
  'bill',
  'program_element',
  'program',
  'contract',
  'grant',
  'opportunity',
  'district',
  'place',
  'other',
] as const;
export type CanonicalEntityType = (typeof CANONICAL_ENTITY_TYPES)[number];

export const ENTITY_RESOLUTION_STATUSES = [
  'resolved',
  'ambiguous',
  'unresolved',
  'rejected',
  'corrected',
] as const;
export type EntityResolutionStatus = (typeof ENTITY_RESOLUTION_STATUSES)[number];

export interface EntityIdentifierInput {
  type: string;
  value: string;
}

export interface EntityAliasInput {
  value: string;
  sourceType: string;
  sourceId?: string | null;
  confidence?: number;
  verifiedAt?: Date | null;
}

export interface EntityIdentifierRegistrationInput extends EntityIdentifierInput {
  sourceType: string;
  sourceId?: string | null;
  confidence?: number;
  verifiedAt?: Date | null;
}

export interface EntityResolutionProvenance {
  sourceType: string;
  sourceId?: string | null;
  identifierType?: string | null;
  matchValue?: string | null;
}

export interface CanonicalEntityRecord {
  id: string;
  tenantId: string | null;
  identityScope: CanonicalEntityScope;
  entityType: string;
  canonicalName: string;
  normalizedName: string;
  status: 'active' | 'merged' | 'withdrawn';
  resolutionConfidence: number;
  resolutionMethod: string;
  metadata: Record<string, unknown>;
  mergedIntoEntityId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EntityResolutionCandidate {
  entity: CanonicalEntityRecord;
  confidence: number;
  resolutionMethod: 'identifier_exact' | 'canonical_name_exact' | 'alias_exact';
  reasons: string[];
  provenance: EntityResolutionProvenance[];
}

export interface ResolveEntityInput {
  query: string;
  actorUserId?: string | null;
  entityTypeHint?: string | null;
  identifiers?: readonly EntityIdentifierInput[];
  maxCandidates?: number;
}

export interface EntityResolutionResult {
  resolutionId: string;
  status: 'resolved' | 'ambiguous' | 'unresolved';
  entity: CanonicalEntityRecord | null;
  confidence: number;
  resolutionMethod: string;
  candidates: EntityResolutionCandidate[];
  provenance: EntityResolutionProvenance[];
  requiresUserConfirmation: boolean;
}

export interface RegisterTenantPrivateEntityInput {
  actorUserId?: string | null;
  entityType: CanonicalEntityType | string;
  canonicalName: string;
  resolutionMethod: string;
  resolutionConfidence?: number;
  metadata?: Record<string, unknown>;
  aliases?: readonly EntityAliasInput[];
  identifiers?: readonly EntityIdentifierRegistrationInput[];
}

export interface CorrectEntityResolutionInput {
  resolutionId: string;
  selectedEntityId: string;
  actorUserId: string;
  reason?: string | null;
}

export interface NormalizedResolveEntityInput {
  rawInput: string;
  normalizedInput: string;
  actorUserId: string | null;
  entityTypeHint: string | null;
  identifiers: Array<{ type: string; value: string; normalizedValue: string }>;
  maxCandidates: number;
}

export interface AppendResolutionInput {
  idempotencyKey: string;
  actorUserId: string | null;
  rawInput: string;
  normalizedInput: string;
  entityTypeHint: string | null;
  candidateEntityIds: string[];
  selectedEntityId: string | null;
  status: EntityResolutionStatus;
  confidence: number;
  resolutionMethod: string;
  provenance: EntityResolutionProvenance[];
  correctionOfResolutionId: string | null;
}

export interface EntityResolutionRecord {
  id: string;
  tenantId: string;
  idempotencyKey: string;
  actorUserId: string | null;
  rawInput: string;
  normalizedInput: string;
  entityTypeHint: string | null;
  candidateEntityIds: string[];
  selectedEntityId: string | null;
  status: EntityResolutionStatus;
  confidence: number;
  resolutionMethod: string;
  provenance: EntityResolutionProvenance[];
  correctionOfResolutionId: string | null;
  createdAt: Date;
}
