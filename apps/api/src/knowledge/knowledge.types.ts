/** JSON value types used by the Knowledge Plane's provenance and scope fields. */
export type KnowledgeJsonPrimitive = string | number | boolean | null;
export type KnowledgeJsonValue =
  | KnowledgeJsonPrimitive
  | KnowledgeJsonValue[]
  | { [key: string]: KnowledgeJsonValue };
export type KnowledgeJsonObject = { [key: string]: KnowledgeJsonValue };

/** A stable reference to an actor, entity, client, or other domain object. */
export interface KnowledgeRef {
  type: string;
  id: string;
  label?: string;
  metadata?: KnowledgeJsonObject;
}

export const KNOWLEDGE_EVENT_STATUSES = ['active', 'withdrawn'] as const;
export type KnowledgeEventStatus = (typeof KNOWLEDGE_EVENT_STATUSES)[number];

export const KNOWLEDGE_ASSERTION_CLASSES = [
  'fact',
  'preference',
  'decision',
  'commitment',
  'position',
  'goal',
  'constraint',
  'relationship',
  'expertise',
  'influence',
  'risk',
  'strategy',
] as const;
export type KnowledgeAssertionClass = (typeof KNOWLEDGE_ASSERTION_CLASSES)[number];

export const KNOWLEDGE_AUTHORITIES = [
  'model_inferred',
  'source_reported',
  'human_confirmed',
  'system_canonical',
] as const;
export type KnowledgeAuthority = (typeof KNOWLEDGE_AUTHORITIES)[number];

export const KNOWLEDGE_ASSERTION_STATUSES = ['active', 'withdrawn'] as const;
export type KnowledgeAssertionStatus = (typeof KNOWLEDGE_ASSERTION_STATUSES)[number];

export const KNOWLEDGE_CONFLICT_STATUSES = [
  'none',
  'potential',
  'confirmed',
  'resolved',
] as const;
export type KnowledgeConflictStatus = (typeof KNOWLEDGE_CONFLICT_STATUSES)[number];

export interface AppendKnowledgeEventInput {
  sourceType: string;
  sourceId: string;
  sourceVersion?: string | null;
  sourceContentHash: string;
  eventType: string;
  occurredAt: Date;
  observedAt?: Date;
  actorRefs?: KnowledgeRef[];
  entityRefs?: KnowledgeRef[];
  clientRefs?: KnowledgeRef[];
  sensitivity?: string;
  accessScope?: KnowledgeJsonObject;
  evidenceLocator: KnowledgeJsonObject;
  metadata?: KnowledgeJsonObject;
  originTraceId?: string | null;
  status?: KnowledgeEventStatus;
}

export interface NormalizedKnowledgeEventInput {
  idempotencyKey: string;
  sourceType: string;
  sourceId: string;
  sourceVersion: string | null;
  sourceContentHash: string;
  eventType: string;
  occurredAt: Date;
  observedAt: Date;
  actorRefs: KnowledgeRef[];
  entityRefs: KnowledgeRef[];
  clientRefs: KnowledgeRef[];
  sensitivity: string;
  accessScope: KnowledgeJsonObject;
  evidenceLocator: KnowledgeJsonObject;
  metadata: KnowledgeJsonObject;
  originTraceId: string | null;
  status: KnowledgeEventStatus;
}

export interface KnowledgeEventRecord extends NormalizedKnowledgeEventInput {
  id: string;
  tenantId: string;
  ingestedAt: Date;
  createdAt: Date;
}

export interface AppendKnowledgeAssertionInput {
  originEventId: string;
  subjectType: string;
  subjectId: string;
  predicate: string;
  objectType: string;
  objectId?: string | null;
  objectValue?: KnowledgeJsonValue;
  assertionClass: KnowledgeAssertionClass;
  confidence: number;
  authority: KnowledgeAuthority;
  observedAt?: Date;
  validFrom?: Date;
  validUntil?: Date | null;
  status?: KnowledgeAssertionStatus;
  conflictStatus?: KnowledgeConflictStatus;
  conflictGroupId?: string | null;
  supersedesAssertionId?: string | null;
  contradictsAssertionId?: string | null;
  sensitivity?: string;
  accessScope?: KnowledgeJsonObject;
  createdBy?: string | null;
}

export interface NormalizedKnowledgeAssertionInput {
  idempotencyKey: string;
  originEventId: string;
  subjectType: string;
  subjectId: string;
  predicate: string;
  objectType: string;
  objectId: string | null;
  objectValue: KnowledgeJsonValue | null;
  assertionClass: KnowledgeAssertionClass;
  confidence: number;
  authority: KnowledgeAuthority;
  observedAt: Date;
  validFrom: Date;
  validUntil: Date | null;
  status: KnowledgeAssertionStatus;
  conflictStatus: KnowledgeConflictStatus;
  conflictGroupId: string | null;
  supersedesAssertionId: string | null;
  contradictsAssertionId: string | null;
  sensitivity: string;
  accessScope: KnowledgeJsonObject;
  createdBy: string | null;
}

export interface KnowledgeAssertionRecord extends NormalizedKnowledgeAssertionInput {
  id: string;
  tenantId: string;
  createdAt: Date;
}
