import type {
  CanonicalEntityRecord,
  CanonicalEntityType,
  EntityAliasInput,
  EntityIdentifierRegistrationInput,
  EntityResolutionCandidate,
} from './entity-resolution.types.js';

export const GLOBAL_AUTHORITATIVE_IDENTIFIER_TYPES = [
  'uei',
  'cage',
  'sam_entity_id',
  'usaspending_recipient_id',
  'cik',
  'congress_id',
  'bioguide_id',
  'committee_id',
  'legiscan_people_id',
  'openstates_person_id',
  'lda_client_id',
  'lda_registrant_id',
  'federal_contractor_id',
  'official_domain',
] as const;

export interface RegisterGlobalPublicEntityInput {
  actorUserId?: string | null;
  entityType: CanonicalEntityType | string;
  canonicalName: string;
  resolutionMethod: string;
  resolutionConfidence?: number;
  metadata?: Record<string, unknown>;
  aliases?: readonly EntityAliasInput[];
  identifiers: readonly EntityIdentifierRegistrationInput[];
}

export interface AttachEntityIdentityInput {
  aliases?: readonly EntityAliasInput[];
  identifiers?: readonly EntityIdentifierRegistrationInput[];
}

export interface LinkTenantIdentityInput extends AttachEntityIdentityInput {
  entityId: string;
}

export interface GlobalIdentifierLookupInput {
  type: string;
  normalizedValue: string;
}

export interface CanonicalSourceRegistrationResult {
  status: 'linked' | 'registered' | 'ambiguous' | 'not_found';
  entity: CanonicalEntityRecord | null;
  resolutionId: string | null;
  candidates: EntityResolutionCandidate[];
}

export interface MergeTenantPrivateEntityInput {
  sourceEntityId: string;
  targetEntityId: string;
  actorUserId?: string | null;
  reasonCode: string;
  reason?: string | null;
  provenance?: readonly Record<string, unknown>[];
}
