import type {
  EntityAliasInput,
  EntityIdentifierRegistrationInput,
  EntityResolutionCandidate,
} from './entity-resolution.types.js';

export type CanonicalSourceKind =
  | 'client'
  | 'client_person'
  | 'engagement_contact'
  | 'confirmed_client_mapping';

export type CanonicalSourceSyncStatus =
  | 'linked'
  | 'created'
  | 'ambiguous'
  | 'skipped'
  | 'would_link'
  | 'would_create'
  | 'failed';

export interface CanonicalSourceSyncResult {
  sourceKind: CanonicalSourceKind;
  sourceId: string;
  status: CanonicalSourceSyncStatus;
  entityId: string | null;
  resolutionId: string | null;
  candidates: EntityResolutionCandidate[];
  reason: string | null;
}

export interface ClientIdentitySource {
  id: string;
  tenantId: string;
  name: string;
  website?: string | null;
  uei?: string | null;
  cageCode?: string | null;
  ldaClientIds?: readonly number[];
}

export interface ClientPersonIdentitySource {
  id: string;
  tenantId: string;
  clientId: string;
  name: string;
  email?: string | null;
  title?: string | null;
}

export interface EngagementContactIdentitySource {
  id: string;
  tenantId: string;
  clientId?: string | null;
  fullName?: string | null;
  email?: string | null;
  organization?: string | null;
  title?: string | null;
  directoryEntryId?: string | null;
  acquisitionPersonnelId?: string | null;
}

export interface ConfirmedClientMappingIdentitySource {
  id: string;
  tenantId: string;
  clientId: string;
  clientName: string;
  clientWebsite?: string | null;
  clientUei?: string | null;
  clientCageCode?: string | null;
  source: 'contracting' | 'lda';
  externalId: string;
  externalName: string;
  confirmed: boolean;
  reviewStatus: string;
  matchBasis?: string | null;
  matchTier?: number | null;
  publicIdentifiers: readonly EntityIdentifierRegistrationInput[];
  publicAliases?: readonly EntityAliasInput[];
}

export interface CanonicalSourceSyncOptions {
  dryRun?: boolean;
  actorUserId?: string | null;
}
