import type { KnowledgeJsonObject, KnowledgeRef } from '../knowledge.types.js';

export const MAILBOX_KNOWLEDGE_JOB_STATUSES = [
  'pending',
  'processing',
  'succeeded',
  'skipped',
  'failed',
  'dead_letter',
] as const;
export type MailboxKnowledgeJobStatus = (typeof MAILBOX_KNOWLEDGE_JOB_STATUSES)[number];

export const MAILBOX_RELEVANCE_CATEGORIES = [
  'business_relevant',
  'client_relevant',
  'government_relevant',
  'relationship_relevant',
  'administrative',
  'personal',
  'marketing',
  'automated',
  'newsletter',
  'spam',
  'insufficient_content',
] as const;
export type MailboxRelevanceCategory = (typeof MAILBOX_RELEVANCE_CATEGORIES)[number];

export interface MailboxRecipient {
  email: string;
  name: string | null;
}

export interface MailboxAttachmentRef {
  id: string;
  fileName: string;
  contentType: string;
  byteSize: number | null;
  lifecycleStatus: string | null;
}

export interface MailboxKnowledgeJobRecord {
  id: string;
  tenantId: string;
  mailMessageId: string;
  sourceRevision: string;
  status: MailboxKnowledgeJobStatus;
  attemptCount: number;
  availableAt: Date;
  lockedAt: Date | null;
  lockedBy: string | null;
  lastError: string | null;
  relevance: KnowledgeJsonObject | null;
  resultEventId: string | null;
  processedContentHash: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MailboxMessageRecord {
  id: string;
  tenantId: string;
  threadId: string;
  threadExternalId: string | null;
  threadSubject: string;
  clientId: string | null;
  connectionId: string | null;
  connectionOwnerUserId: string | null;
  accountEmail: string | null;
  source: string;
  externalId: string | null;
  currentSourceRevision: string;
  subject: string | null;
  fromEmail: string | null;
  fromName: string | null;
  toRecipients: MailboxRecipient[];
  ccRecipients: MailboxRecipient[];
  bccRecipients: MailboxRecipient[];
  sentAt: Date | null;
  receivedAt: Date | null;
  bodyText: string | null;
  hasAttachments: boolean;
  removedAt: Date | null;
  removedReason: string | null;
  metadata: KnowledgeJsonObject;
  raw: KnowledgeJsonObject | null;
  attachments: MailboxAttachmentRef[];
  createdAt: Date;
  updatedAt: Date;
}

export interface NormalizedMailboxMessage {
  authoritativeText: string;
  normalizedText: string;
  authoritativeContentHash: string;
  normalizedContentHash: string;
  subject: string;
  sender: MailboxRecipient | null;
  toRecipients: MailboxRecipient[];
  ccRecipients: MailboxRecipient[];
  bccRecipients: MailboxRecipient[];
  stripped: {
    html: boolean;
    quotedHistory: boolean;
    signature: boolean;
    confidentialityNotice: boolean;
  };
  lengths: {
    source: number;
    authoritative: number;
    normalized: number;
  };
}

export interface MailboxRelevanceResult {
  category: MailboxRelevanceCategory;
  eligible: boolean;
  score: number;
  reasons: string[];
  signals: {
    clientLinked: boolean;
    governmentTerms: string[];
    relationshipTerms: string[];
    automatedSender: boolean;
    newsletterMarkers: string[];
    marketingMarkers: string[];
  };
}

export interface MailboxKnowledgeContext {
  actorRefs: KnowledgeRef[];
  entityRefs: KnowledgeRef[];
  clientRefs: KnowledgeRef[];
  sensitivity: string;
  accessScope: KnowledgeJsonObject;
  evidenceLocator: KnowledgeJsonObject;
  metadata: KnowledgeJsonObject;
}

export interface MailboxKnowledgeDrainResult {
  claimed: number;
  succeeded: number;
  skipped: number;
  failed: number;
}
