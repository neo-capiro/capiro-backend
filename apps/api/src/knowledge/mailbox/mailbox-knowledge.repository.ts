import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { KnowledgeJsonObject } from '../knowledge.types.js';
import type {
  MailboxAttachmentRef,
  MailboxKnowledgeJobRecord,
  MailboxKnowledgeJobStatus,
  MailboxMessageRecord,
  MailboxRecipient,
  MailboxRelevanceResult,
} from './mailbox-knowledge.types.js';

interface MailboxKnowledgeJobRow {
  id: string;
  tenant_id: string;
  mail_message_id: string;
  source_revision: string;
  status: string;
  attempt_count: number;
  available_at: Date;
  locked_at: Date | null;
  locked_by: string | null;
  last_error: string | null;
  relevance: unknown;
  result_event_id: string | null;
  processed_content_hash: string | null;
  created_at: Date;
  updated_at: Date;
}

interface MailboxMessageRow {
  id: string;
  tenant_id: string;
  thread_id: string;
  thread_external_id: string | null;
  thread_subject: string;
  client_id: string | null;
  connection_id: string | null;
  connection_owner_user_id: string | null;
  account_email: string | null;
  source: string;
  external_id: string | null;
  current_source_revision: string;
  subject: string | null;
  from_email: string | null;
  from_name: string | null;
  to_recipients: unknown;
  cc_recipients: unknown;
  bcc_recipients: unknown;
  sent_at: Date | null;
  received_at: Date | null;
  body_text: string | null;
  has_attachments: boolean;
  removed_at: Date | null;
  removed_reason: string | null;
  metadata: unknown;
  raw: unknown;
  attachments: unknown;
  created_at: Date;
  updated_at: Date;
}

/** Durable transactional-outbox persistence for mailbox knowledge ingestion. */
@Injectable()
export class MailboxKnowledgeRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cross-tenant claim is the one intentional system operation. Every claimed
   * row carries its tenant id; all message reads and state transitions below
   * re-enter a tenant-bound transaction and repeat tenant_id in SQL.
   */
  async claimBatch(workerId: string, limit: number): Promise<MailboxKnowledgeJobRecord[]> {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRaw<MailboxKnowledgeJobRow[]>`
        WITH candidates AS (
          SELECT id
          FROM knowledge_mailbox_jobs
          WHERE (
            (status IN ('pending', 'failed') AND available_at <= CURRENT_TIMESTAMP)
            OR
            (status = 'processing' AND locked_at < CURRENT_TIMESTAMP - INTERVAL '15 minutes')
          )
          ORDER BY available_at ASC, created_at ASC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT ${boundedLimit}
        )
        UPDATE knowledge_mailbox_jobs AS jobs
        SET
          status = 'processing',
          attempt_count = jobs.attempt_count + 1,
          locked_at = CURRENT_TIMESTAMP,
          locked_by = ${workerId},
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
        FROM candidates
        WHERE jobs.id = candidates.id
        RETURNING
          jobs.id,
          jobs.tenant_id,
          jobs.mail_message_id,
          jobs.source_revision,
          jobs.status,
          jobs.attempt_count,
          jobs.available_at,
          jobs.locked_at,
          jobs.locked_by,
          jobs.last_error,
          jobs.relevance,
          jobs.result_event_id,
          jobs.processed_content_hash,
          jobs.created_at,
          jobs.updated_at
      `,
    );
    return rows.map(mapJob);
  }

  async loadMessage(tenantId: string, messageId: string): Promise<MailboxMessageRecord | null> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<MailboxMessageRow[]>`
        SELECT
          message.id,
          message.tenant_id,
          message.thread_id,
          thread.external_id AS thread_external_id,
          thread.subject AS thread_subject,
          thread.client_id,
          message.connection_id,
          connection.created_by_user_id AS connection_owner_user_id,
          connection.account_email::text AS account_email,
          message.source::text AS source,
          message.external_id,
          mailbox_knowledge_source_revision(
            message.source::text,
            message.external_id,
            message.subject,
            message.from_email::text,
            message.to_recipients_jsonb,
            message.cc_recipients_jsonb,
            message.bcc_recipients_jsonb,
            message.sent_at,
            message.received_at,
            message.body_text,
            message.has_attachments
          ) AS current_source_revision,
          message.subject,
          message.from_email::text AS from_email,
          message.from_name,
          message.to_recipients_jsonb AS to_recipients,
          message.cc_recipients_jsonb AS cc_recipients,
          message.bcc_recipients_jsonb AS bcc_recipients,
          message.sent_at,
          message.received_at,
          message.body_text,
          message.has_attachments,
          message.removed_at,
          message.removed_reason,
          message.metadata_jsonb AS metadata,
          message.raw_jsonb AS raw,
          COALESCE((
            SELECT jsonb_agg(
              jsonb_build_object(
                'id', attachment.id,
                'fileName', attachment.file_name,
                'contentType', attachment.content_type,
                'byteSize', attachment.byte_size,
                'lifecycleStatus', attachment.lifecycle_status
              )
              ORDER BY attachment.created_at ASC, attachment.id ASC
            )
            FROM engagement_attachments AS attachment
            WHERE attachment.tenant_id = ${tenantId}::uuid
              AND attachment.mail_message_id = message.id
          ), '[]'::jsonb) AS attachments,
          message.created_at,
          message.updated_at
        FROM mail_messages AS message
        JOIN mail_threads AS thread
          ON thread.id = message.thread_id
         AND thread.tenant_id = message.tenant_id
        LEFT JOIN engagement_connections AS connection
          ON connection.id = message.connection_id
         AND connection.tenant_id = message.tenant_id
        WHERE message.tenant_id = ${tenantId}::uuid
          AND message.id = ${messageId}::uuid
        LIMIT 1
      `;
      return rows[0] ? mapMessage(rows[0]) : null;
    });
  }

  async complete(
    job: MailboxKnowledgeJobRecord,
    eventId: string,
    contentHash: string,
    relevance: MailboxRelevanceResult,
  ): Promise<void> {
    await this.updateTerminal(job, 'succeeded', {
      eventId,
      contentHash,
      relevance,
      error: null,
    });
  }

  async skip(
    job: MailboxKnowledgeJobRecord,
    relevance: MailboxRelevanceResult | null,
    reason: string,
    contentHash: string | null = null,
  ): Promise<void> {
    await this.updateTerminal(job, 'skipped', {
      eventId: null,
      contentHash,
      relevance,
      error: reason,
    });
  }

  async fail(job: MailboxKnowledgeJobRecord, error: unknown, maxAttempts: number): Promise<void> {
    const terminal = job.attemptCount >= maxAttempts;
    const delaySeconds = Math.min(15 * 60, Math.max(30, 30 * 2 ** Math.max(0, job.attemptCount - 1)));
    const message = redactError(error);
    await this.prisma.withTenant(job.tenantId, async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE knowledge_mailbox_jobs
        SET
          status = ${terminal ? 'dead_letter' : 'failed'},
          available_at = CURRENT_TIMESTAMP + (${delaySeconds} * INTERVAL '1 second'),
          locked_at = NULL,
          locked_by = NULL,
          last_error = ${message},
          updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ${job.tenantId}::uuid
          AND id = ${job.id}::uuid
          AND status = 'processing'
      `;
      if (updated !== 1) {
        throw new InternalServerErrorException('Mailbox knowledge job failure transition lost.');
      }
    });
  }

  private async updateTerminal(
    job: MailboxKnowledgeJobRecord,
    status: Extract<MailboxKnowledgeJobStatus, 'succeeded' | 'skipped'>,
    input: {
      eventId: string | null;
      contentHash: string | null;
      relevance: MailboxRelevanceResult | null;
      error: string | null;
    },
  ): Promise<void> {
    await this.prisma.withTenant(job.tenantId, async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE knowledge_mailbox_jobs
        SET
          status = ${status},
          result_event_id = ${input.eventId}::uuid,
          processed_content_hash = ${input.contentHash},
          relevance = CAST(${input.relevance ? JSON.stringify(input.relevance) : null} AS jsonb),
          locked_at = NULL,
          locked_by = NULL,
          last_error = ${input.error},
          updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ${job.tenantId}::uuid
          AND id = ${job.id}::uuid
          AND status = 'processing'
      `;
      if (updated !== 1) {
        throw new InternalServerErrorException('Mailbox knowledge terminal transition lost.');
      }
    });
  }
}

function mapJob(row: MailboxKnowledgeJobRow): MailboxKnowledgeJobRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    mailMessageId: row.mail_message_id,
    sourceRevision: row.source_revision,
    status: row.status as MailboxKnowledgeJobStatus,
    attemptCount: Number(row.attempt_count),
    availableAt: row.available_at,
    lockedAt: row.locked_at,
    lockedBy: row.locked_by,
    lastError: row.last_error,
    relevance: isJsonObject(row.relevance) ? row.relevance : null,
    resultEventId: row.result_event_id,
    processedContentHash: row.processed_content_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row: MailboxMessageRow): MailboxMessageRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    threadId: row.thread_id,
    threadExternalId: row.thread_external_id,
    threadSubject: row.thread_subject,
    clientId: row.client_id,
    connectionId: row.connection_id,
    connectionOwnerUserId: row.connection_owner_user_id,
    accountEmail: row.account_email,
    source: row.source,
    externalId: row.external_id,
    currentSourceRevision: row.current_source_revision,
    subject: row.subject,
    fromEmail: row.from_email,
    fromName: row.from_name,
    toRecipients: parseRecipients(row.to_recipients),
    ccRecipients: parseRecipients(row.cc_recipients),
    bccRecipients: parseRecipients(row.bcc_recipients),
    sentAt: row.sent_at,
    receivedAt: row.received_at,
    bodyText: row.body_text,
    hasAttachments: Boolean(row.has_attachments),
    removedAt: row.removed_at,
    removedReason: row.removed_reason,
    metadata: isJsonObject(row.metadata) ? row.metadata : {},
    raw: isJsonObject(row.raw) ? row.raw : null,
    attachments: parseAttachments(row.attachments),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseRecipients(value: unknown): MailboxRecipient[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const record = candidate as Record<string, unknown>;
    const email = typeof record.email === 'string' ? record.email.trim().toLowerCase() : '';
    if (!email) return [];
    const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : null;
    return [{ email, name }];
  });
}

function parseAttachments(value: unknown): MailboxAttachmentRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const record = candidate as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.fileName !== 'string') return [];
    return [{
      id: record.id,
      fileName: record.fileName,
      contentType: typeof record.contentType === 'string' ? record.contentType : 'application/octet-stream',
      byteSize: typeof record.byteSize === 'number' ? record.byteSize : null,
      lifecycleStatus: typeof record.lifecycleStatus === 'string' ? record.lifecycleStatus : null,
    }];
  });
}

function isJsonObject(value: unknown): value is KnowledgeJsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function redactError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return raw
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, '[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 1_500);
}
