import type { KnowledgeAssertionClass, KnowledgeJsonObject } from '../knowledge.types.js';

export const MAILBOX_KNOWLEDGE_EXTRACTION_JOB_STATUSES = [
  'pending',
  'processing',
  'succeeded',
  'skipped',
  'failed',
  'dead_letter',
] as const;
export type MailboxKnowledgeExtractionJobStatus =
  (typeof MAILBOX_KNOWLEDGE_EXTRACTION_JOB_STATUSES)[number];

export const MAILBOX_CLAIM_SUBJECT_ROLES = [
  'sender',
  'recipient',
  'linked_client',
  'named_entity',
] as const;
export type MailboxClaimSubjectRole = (typeof MAILBOX_CLAIM_SUBJECT_ROLES)[number];

export type MailboxClaimPrimitive = string | number | boolean | null;

export interface MailboxKnowledgeExtractionJobRecord {
  id: string;
  tenantId: string;
  mailboxJobId: string;
  mailMessageId: string;
  eventId: string;
  sourceRevision: string;
  contentHash: string;
  sensitivity: string;
  accessScope: KnowledgeJsonObject;
  status: MailboxKnowledgeExtractionJobStatus;
  attemptCount: number;
  availableAt: Date;
  lockedAt: Date | null;
  lockedBy: string | null;
  lastError: string | null;
  result: KnowledgeJsonObject | null;
  assertionCount: number;
  heldCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Safe identity context handed to the extractor after Phase 5 resolution has
 * already run for known envelope subjects. Canonical IDs are deliberately not
 * exposed to the model; the consumer retains the real resolution object and is
 * the only layer allowed to bind a claim to a canonical UUID.
 */
export interface MailboxExtractionIdentityHint {
  role: Extract<MailboxClaimSubjectRole, 'linked_client' | 'sender'>;
  sourceText: string | null;
  sourceEmail: string | null;
  resolutionStatus: 'resolved' | 'ambiguous' | 'unresolved';
  canonicalName: string | null;
  entityType: string | null;
  confidence: number;
  method: string;
}

/**
 * Narrow model output. It contains source-language mentions only; canonical IDs
 * are deliberately absent because identity is owned by the Phase 5 resolver.
 */
export interface MailboxExtractedClaimCandidate {
  subjectRole: MailboxClaimSubjectRole;
  subjectText: string | null;
  subjectEmail: string | null;
  subjectEntityType: string;
  predicate: string;
  objectType: string;
  objectValue: MailboxClaimPrimitive;
  objectEntityText: string | null;
  objectEntityEmail: string | null;
  objectEntityType: string | null;
  assertionClass: KnowledgeAssertionClass;
  confidence: number;
  excerpt: string;
}

export interface MailboxExtractionModelResult {
  provider: 'openai' | 'anthropic';
  model: string;
  inputTruncated: boolean;
  candidates: MailboxExtractedClaimCandidate[];
}

export interface MailboxEvidenceLocator {
  startOffset: number;
  endOffset: number;
  contentHash: string;
}

export type MailboxClaimDisposition =
  | 'asserted'
  | 'held_subject_ambiguous'
  | 'held_subject_unresolved'
  | 'held_object_ambiguous'
  | 'held_object_unresolved'
  | 'held_invalid_evidence'
  | 'held_invalid_subject';

export interface MailboxClaimResolutionManifest {
  index: number;
  disposition: MailboxClaimDisposition;
  assertionClass: KnowledgeAssertionClass;
  predicate: string;
  subject: {
    role: MailboxClaimSubjectRole;
    text: string | null;
    email: string | null;
    entityType: string;
    resolutionStatus: 'resolved' | 'ambiguous' | 'unresolved' | 'not_attempted';
    canonicalEntityId: string | null;
    resolutionId: string | null;
    confidence: number | null;
    method: string | null;
    stopReason: string | null;
  };
  object: {
    type: string;
    value: MailboxClaimPrimitive;
    entityText: string | null;
    entityEmail: string | null;
    entityType: string | null;
    resolutionStatus: 'resolved' | 'ambiguous' | 'unresolved' | 'not_applicable';
    canonicalEntityId: string | null;
    resolutionId: string | null;
    confidence: number | null;
    method: string | null;
    stopReason: string | null;
  };
  evidence: MailboxEvidenceLocator | null;
  assertionId: string | null;
}

export interface MailboxKnowledgeExtractionDrainResult {
  claimed: number;
  succeeded: number;
  skipped: number;
  failed: number;
}
