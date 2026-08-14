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

export const DISALLOWED_KNOWLEDGE_FACTUAL_SOURCE_TYPES = [
  'assistant_answer',
  'llm_output',
  'meri_answer',
  'model_answer',
  'model_output',
] as const;
export type DisallowedKnowledgeFactualSourceType =
  (typeof DISALLOWED_KNOWLEDGE_FACTUAL_SOURCE_TYPES)[number];

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

/**
 * Exact source proof proposed for one assertion.
 *
 * `sourceText` is the canonical source text whose SHA-256 is stored on the
 * KnowledgeEvent. It is used only for validation and is never copied into the
 * evidence ledger. Offsets use JavaScript string (UTF-16 code-unit) semantics.
 */
export interface AppendKnowledgeEvidenceInput {
  eventId: string;
  sourceType: string;
  sourceId: string;
  excerpt: string;
  startOffset: number;
  endOffset: number;
  contentHash: string;
  sourceText: string;
}

export interface NormalizedKnowledgeEvidenceInput {
  eventId: string;
  sourceType: string;
  sourceId: string;
  excerpt: string;
  startOffset: number;
  endOffset: number;
  contentHash: string;
}

export interface KnowledgeEvidenceRecord extends NormalizedKnowledgeEvidenceInput {
  id: string;
  tenantId: string;
  assertionId: string;
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
  evidence: AppendKnowledgeEvidenceInput[];
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

export interface KnowledgeEvidenceProvenanceEntry {
  evidence: KnowledgeEvidenceRecord;
  event: KnowledgeEventRecord;
}

export interface KnowledgeAssertionProvenance {
  assertion: KnowledgeAssertionRecord;
  evidence: KnowledgeEvidenceProvenanceEntry[];
}
