import type { EntityResolutionResult } from './entity-resolution.types.js';

export const ENTITY_GOVERNANCE_REASON_CODES = [
  'user_confirmed',
  'user_rejected',
  'incorrect_identity',
  'stale_source',
  'duplicate_identity',
  'privacy_request',
  'administrative_correction',
  'other',
] as const;

export type EntityGovernanceReasonCode =
  (typeof ENTITY_GOVERNANCE_REASON_CODES)[number];

export type EntityIdentityGovernanceAction =
  | 'resolution_confirmed'
  | 'resolution_rejected'
  | 'alias_confirmed'
  | 'alias_withdrawn'
  | 'identifier_confirmed'
  | 'identifier_withdrawn';

export interface ConfirmResolutionGovernanceInput {
  resolutionId: string;
  selectedEntityId: string;
  actorUserId: string;
  reason?: string | null;
}

export interface RejectResolutionGovernanceInput {
  resolutionId: string;
  actorUserId: string;
  reasonCode: EntityGovernanceReasonCode | string;
  reason?: string | null;
}

export interface GovernEntityLinkInput {
  linkId: string;
  actorUserId: string;
  reasonCode: EntityGovernanceReasonCode | string;
  reason?: string | null;
}

export interface EntityIdentityGovernanceEventRecord {
  id: string;
  tenantId: string;
  idempotencyKey: string;
  actionType: EntityIdentityGovernanceAction;
  subjectType: 'resolution' | 'alias' | 'identifier';
  subjectId: string;
  entityId: string | null;
  actorUserId: string;
  reasonCode: string;
  reason: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface RejectedEntityResolutionResult {
  resolutionId: string;
  status: 'rejected';
  governanceEventId: string;
}

export interface ConfirmedEntityResolutionGovernanceResult extends EntityResolutionResult {
  governanceEventId: string;
}
