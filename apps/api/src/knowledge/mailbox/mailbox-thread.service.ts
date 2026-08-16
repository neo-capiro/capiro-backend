import { BadRequestException, Injectable } from '@nestjs/common';
import type { KnowledgeJsonObject, KnowledgeRef } from '../knowledge.types.js';
import type {
  MailboxKnowledgeContext,
  MailboxMessageRecord,
  MailboxRelevanceResult,
  NormalizedMailboxMessage,
} from './mailbox-knowledge.types.js';

/** Builds provenance-rich event context without duplicating the message body. */
@Injectable()
export class MailboxThreadService {
  buildContext(
    message: MailboxMessageRecord,
    normalized: NormalizedMailboxMessage,
    relevance: MailboxRelevanceResult,
  ): MailboxKnowledgeContext {
    if (!message.connectionOwnerUserId) {
      throw new BadRequestException(
        'Mailbox owner is required before a private knowledge access scope can be created.',
      );
    }

    const actorRefs: KnowledgeRef[] = [];
    if (normalized.sender) {
      actorRefs.push({
        type: 'email_address',
        id: normalized.sender.email,
        label: normalized.sender.name ?? undefined,
        metadata: { role: 'from' },
      });
    }
    for (const [role, recipients] of [
      ['to', normalized.toRecipients],
      ['cc', normalized.ccRecipients],
      ['bcc', normalized.bccRecipients],
    ] as const) {
      for (const recipient of recipients) {
        actorRefs.push({
          type: 'email_address',
          id: recipient.email,
          label: recipient.name ?? undefined,
          metadata: { role },
        });
      }
    }

    const entityRefs: KnowledgeRef[] = [
      {
        type: 'mail_message',
        id: message.id,
        label: normalized.subject || undefined,
        metadata: {
          provider: message.source,
          externalId: message.externalId,
        },
      },
      {
        type: 'mail_thread',
        id: message.threadId,
        label: message.threadSubject || undefined,
        metadata: { externalId: message.threadExternalId },
      },
      ...message.attachments.map((attachment) => ({
        type: 'mail_attachment',
        id: attachment.id,
        label: attachment.fileName,
        metadata: {
          contentType: attachment.contentType,
          byteSize: attachment.byteSize,
          lifecycleStatus: attachment.lifecycleStatus,
        },
      })),
    ];
    const clientRefs: KnowledgeRef[] = message.clientId
      ? [{ type: 'client', id: message.clientId }]
      : [];

    const rawSensitivity = readString(message.raw, 'sensitivity') ??
      readString(message.metadata, 'sensitivity');
    const sensitivity = normalizeSensitivity(rawSensitivity);
    const accessScope: KnowledgeJsonObject = {
      kind: 'user',
      userId: message.connectionOwnerUserId,
      clientIds: message.clientId ? [message.clientId] : [],
    };

    const evidenceLocator: KnowledgeJsonObject = {
      provider: message.source,
      mailMessageId: message.id,
      providerMessageId: message.externalId,
      threadId: message.threadId,
      providerThreadId: message.threadExternalId,
      connectionId: message.connectionId,
      webLink: readString(message.metadata, 'webLink'),
      canonicalization: 'mailbox-normalizer-v1',
    };

    const metadata: KnowledgeJsonObject = {
      phase: 4,
      pipeline: 'mailbox-knowledge-v1',
      subject: normalized.subject,
      direction: direction(message),
      accountEmail: message.accountEmail,
      sender: normalized.sender
        ? { email: normalized.sender.email, name: normalized.sender.name }
        : null,
      toRecipients: normalized.toRecipients.map((recipient) => ({
        email: recipient.email,
        name: recipient.name,
      })),
      ccRecipients: normalized.ccRecipients.map((recipient) => ({
        email: recipient.email,
        name: recipient.name,
      })),
      bccRecipients: normalized.bccRecipients.map((recipient) => ({
        email: recipient.email,
        name: recipient.name,
      })),
      hasAttachments: message.hasAttachments,
      attachments: message.attachments.map((attachment) => ({
        id: attachment.id,
        fileName: attachment.fileName,
        contentType: attachment.contentType,
        byteSize: attachment.byteSize,
        lifecycleStatus: attachment.lifecycleStatus,
      })),
      normalizedContentHash: normalized.normalizedContentHash,
      canonicalTextLength: normalized.lengths.authoritative,
      normalizedTextLength: normalized.lengths.normalized,
      stripped: {
        html: normalized.stripped.html,
        quotedHistory: normalized.stripped.quotedHistory,
        signature: normalized.stripped.signature,
        confidentialityNotice: normalized.stripped.confidentialityNotice,
      },
      relevance: relevance as unknown as KnowledgeJsonObject,
      readyForEntityResolution: true,
      readyForExtraction: true,
    };

    return {
      actorRefs: dedupeRefs(actorRefs),
      entityRefs,
      clientRefs,
      sensitivity,
      accessScope,
      evidenceLocator,
      metadata,
    };
  }
}

export function mailboxSourceType(source: string): string {
  switch (source) {
    case 'google':
      return 'gmail_message';
    case 'outlook':
      return 'microsoft_mail_message';
    default:
      return 'mail_message';
  }
}

export function mailboxEventType(message: MailboxMessageRecord): 'email_sent' | 'email_received' {
  return direction(message) === 'sent' ? 'email_sent' : 'email_received';
}

function direction(message: MailboxMessageRecord): 'sent' | 'received' {
  const account = message.accountEmail?.trim().toLowerCase();
  const sender = message.fromEmail?.trim().toLowerCase();
  if (account && sender === account) return 'sent';
  if (message.sentAt && !message.receivedAt) return 'sent';
  return 'received';
}

function normalizeSensitivity(value: string | null): string {
  switch (value?.trim().toLowerCase()) {
    case 'private':
    case 'personal':
    case 'confidential':
      return value.trim().toLowerCase();
    default:
      return 'normal';
  }
}

function readString(value: KnowledgeJsonObject | null, key: string): string | null {
  const candidate = value?.[key];
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
}

function dedupeRefs(values: KnowledgeRef[]): KnowledgeRef[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.type}:${value.id}:${String(value.metadata?.role ?? '')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
