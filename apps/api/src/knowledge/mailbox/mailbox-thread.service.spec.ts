import { describe, expect, test } from '@jest/globals';
import type {
  MailboxMessageRecord,
  MailboxRelevanceResult,
  NormalizedMailboxMessage,
} from './mailbox-knowledge.types.js';
import {
  MailboxThreadService,
  mailboxEventType,
  mailboxSourceType,
} from './mailbox-thread.service.js';

const message = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  threadId: '33333333-3333-4333-8333-333333333333',
  threadExternalId: 'thread-external',
  threadSubject: 'NDAA priorities',
  clientId: '44444444-4444-4444-8444-444444444444',
  connectionId: '55555555-5555-4555-8555-555555555555',
  connectionOwnerUserId: '66666666-6666-4666-8666-666666666666',
  accountEmail: 'neo@capiro.ai',
  source: 'outlook',
  externalId: 'outlook-message',
  currentSourceRevision: 'a'.repeat(32),
  subject: 'NDAA priorities',
  fromEmail: 'neo@capiro.ai',
  fromName: 'Neo',
  toRecipients: [{ email: 'staffer@senate.gov', name: 'Staffer' }],
  ccRecipients: [],
  bccRecipients: [],
  sentAt: new Date('2026-08-14T13:00:00Z'),
  receivedAt: null,
  bodyText: 'Please review the proposed committee report language.',
  hasAttachments: true,
  removedAt: null,
  removedReason: null,
  metadata: { webLink: 'https://outlook.office.com/mail/id' },
  raw: { sensitivity: 'confidential' },
  attachments: [{
    id: '77777777-7777-4777-8777-777777777777',
    fileName: 'language.docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    byteSize: 1200,
    lifecycleStatus: 'ready',
  }],
  createdAt: new Date('2026-08-14T13:00:01Z'),
  updatedAt: new Date('2026-08-14T13:00:02Z'),
} satisfies MailboxMessageRecord;

const normalized = {
  authoritativeText: message.bodyText,
  normalizedText: message.bodyText,
  authoritativeContentHash: 'a'.repeat(64),
  normalizedContentHash: 'a'.repeat(64),
  subject: message.subject,
  sender: { email: message.fromEmail, name: message.fromName },
  toRecipients: message.toRecipients,
  ccRecipients: [],
  bccRecipients: [],
  stripped: {
    html: false,
    quotedHistory: false,
    signature: false,
    confidentialityNotice: false,
  },
  lengths: {
    source: message.bodyText.length,
    authoritative: message.bodyText.length,
    normalized: message.bodyText.length,
  },
} satisfies NormalizedMailboxMessage;

const relevance = {
  category: 'government_relevant',
  eligible: true,
  score: 0.9,
  reasons: ['government term: committee'],
  signals: {
    clientLinked: true,
    governmentTerms: ['committee'],
    relationshipTerms: [],
    automatedSender: false,
    newsletterMarkers: [],
    marketingMarkers: [],
  },
} satisfies MailboxRelevanceResult;

describe('MailboxThreadService', () => {
  test('fails closed to the mailbox owner and preserves client scope and sensitivity', () => {
    const context = new MailboxThreadService().buildContext(message, normalized, relevance);
    expect(context.accessScope).toEqual({
      kind: 'user',
      userId: message.connectionOwnerUserId,
      clientIds: [message.clientId],
    });
    expect(context.sensitivity).toBe('confidential');
    expect(context.clientRefs).toEqual([{ type: 'client', id: message.clientId }]);
    expect(context.entityRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'mail_message', id: message.id }),
        expect.objectContaining({ type: 'mail_thread', id: message.threadId }),
        expect.objectContaining({ type: 'mail_attachment', id: message.attachments[0]?.id }),
      ]),
    );
  });

  test('refuses to create a tenant-wide fallback when mailbox ownership is missing', () => {
    expect(() =>
      new MailboxThreadService().buildContext(
        { ...message, connectionOwnerUserId: null },
        normalized,
        relevance,
      ),
    ).toThrow('Mailbox owner is required');
  });

  test('maps provider source and direction deterministically', () => {
    expect(mailboxSourceType('google')).toBe('gmail_message');
    expect(mailboxSourceType('outlook')).toBe('microsoft_mail_message');
    expect(mailboxEventType(message)).toBe('email_sent');
  });
});
