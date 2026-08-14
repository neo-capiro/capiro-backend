import { describe, expect, test } from '@jest/globals';
import type { MailboxMessageRecord, NormalizedMailboxMessage } from './mailbox-knowledge.types.js';
import { MailboxRelevanceService } from './mailbox-relevance.service.js';

function classifyInput(input: {
  body: string;
  subject?: string;
  clientId?: string | null;
  sender?: string;
}): { message: MailboxMessageRecord; normalized: NormalizedMailboxMessage } {
  const message = {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: '22222222-2222-4222-8222-222222222222',
    threadId: '33333333-3333-4333-8333-333333333333',
    threadExternalId: 'thread-1',
    threadSubject: input.subject ?? '',
    clientId: input.clientId ?? null,
    connectionId: null,
    connectionOwnerUserId: null,
    accountEmail: 'neo@capiro.ai',
    source: 'google',
    externalId: 'message-1',
    currentSourceRevision: 'a'.repeat(32),
    subject: input.subject ?? '',
    fromEmail: input.sender ?? 'jane@example.com',
    fromName: 'Jane',
    toRecipients: [{ email: 'neo@capiro.ai', name: 'Neo' }],
    ccRecipients: [],
    bccRecipients: [],
    sentAt: null,
    receivedAt: new Date(),
    bodyText: input.body,
    hasAttachments: false,
    removedAt: null,
    removedReason: null,
    metadata: {},
    raw: null,
    attachments: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  } satisfies MailboxMessageRecord;
  const normalized = {
    authoritativeText: input.body,
    normalizedText: input.body,
    authoritativeContentHash: 'a'.repeat(64),
    normalizedContentHash: 'a'.repeat(64),
    subject: input.subject ?? '',
    sender: { email: input.sender ?? 'jane@example.com', name: 'Jane' },
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
      source: input.body.length,
      authoritative: input.body.length,
      normalized: input.body.length,
    },
  } satisfies NormalizedMailboxMessage;
  return { message, normalized };
}

describe('MailboxRelevanceService', () => {
  const service = new MailboxRelevanceService();

  test('keeps substantive client government correspondence even from an alert sender', () => {
    const { message, normalized } = classifyInput({
      clientId: '44444444-4444-4444-8444-444444444444',
      sender: 'alerts@committee.gov',
      subject: 'NDAA committee hearing',
      body: 'The Senate committee scheduled a hearing on the NDAA and the relevant program element next week.',
    });
    const result = service.classify(message, normalized);
    expect(result.category).toBe('government_relevant');
    expect(result.eligible).toBe(true);
    expect(result.score).toBeGreaterThan(0.7);
  });

  test('rejects newsletters before government keywords can make them look relevant', () => {
    const { message, normalized } = classifyInput({
      subject: 'Weekly Congress and NDAA update',
      body: 'This week the Senate committee held a hearing on the NDAA. View this email in your browser or unsubscribe below.',
    });
    const result = service.classify(message, normalized);
    expect(result.category).toBe('newsletter');
    expect(result.eligible).toBe(false);
  });

  test('keeps a client-linked preference without requiring government keywords', () => {
    const { message, normalized } = classifyInput({
      clientId: '44444444-4444-4444-8444-444444444444',
      body: 'Please avoid describing the product as autonomous. We prefer mission-assurance language in all outreach.',
    });
    const result = service.classify(message, normalized);
    expect(result.category).toBe('client_relevant');
    expect(result.eligible).toBe(true);
  });

  test('rejects short snippets as insufficient evidence', () => {
    const { message, normalized } = classifyInput({ body: 'Sounds good.' });
    const result = service.classify(message, normalized);
    expect(result.category).toBe('insufficient_content');
    expect(result.eligible).toBe(false);
  });
});
