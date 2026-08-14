import { createHash } from 'node:crypto';
import { describe, expect, jest, test } from '@jest/globals';
import type { KnowledgeEventRecord } from '../knowledge.types.js';
import { KnowledgeEventService, buildKnowledgeEventIdempotencyKey } from '../events/knowledge-event.service.js';
import { MailboxKnowledgeConsumer, hasAuthoritativeProviderBody } from './mailbox-knowledge.consumer.js';
import { MailboxKnowledgeFlagsService } from './mailbox-knowledge-flags.service.js';
import { MailboxKnowledgeRepository } from './mailbox-knowledge.repository.js';
import type { MailboxKnowledgeJobRecord, MailboxMessageRecord } from './mailbox-knowledge.types.js';
import { MailboxNormalizerService } from './mailbox-normalizer.service.js';
import { MailboxRelevanceService } from './mailbox-relevance.service.js';
import { MailboxThreadService } from './mailbox-thread.service.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const MESSAGE_ID = '22222222-2222-4222-8222-222222222222';
const JOB_ID = '33333333-3333-4333-8333-333333333333';
const CLIENT_ID = '44444444-4444-4444-8444-444444444444';
const EVENT_ID = '55555555-5555-4555-8555-555555555555';
const OWNER_ID = '88888888-8888-4888-8888-888888888888';

const GMAIL_BODY =
  'Please protect PE 0605053A and avoid leading with autonomy in our committee outreach.';
const GRAPH_BODY =
  'The House staff asked us to protect PE 0605053A and keep autonomy out of the opening. This is the complete Microsoft Graph body.';

function revisionFor(body: string, source: 'google' | 'outlook', subject = 'FY28 Ground Robotics strategy'): string {
  return createHash('md5')
    .update(
      [
        source,
        source === 'google' ? 'gmail-message-1' : 'outlook-message-1',
        subject,
        'jane@example.com',
        JSON.stringify([{ email: 'neo@capiro.ai', name: 'Neo' }]),
        '[]',
        '[]',
        '',
        String(Date.parse('2026-08-14T13:00:00Z') / 1000),
        body,
        'false',
      ].join('\u001f'),
    )
    .digest('hex');
}

function job(sourceRevision: string, id = JOB_ID): MailboxKnowledgeJobRecord {
  return {
    id,
    tenantId: TENANT_ID,
    mailMessageId: MESSAGE_ID,
    sourceRevision,
    status: 'processing',
    attemptCount: 1,
    availableAt: new Date('2026-08-14T13:00:00Z'),
    lockedAt: new Date('2026-08-14T13:01:00Z'),
    lockedBy: 'worker',
    lastError: null,
    relevance: null,
    resultEventId: null,
    processedContentHash: null,
    createdAt: new Date('2026-08-14T13:00:00Z'),
    updatedAt: new Date('2026-08-14T13:01:00Z'),
  };
}

function gmailMessage(overrides: Partial<MailboxMessageRecord> = {}): MailboxMessageRecord {
  const bodyText = overrides.bodyText ?? GMAIL_BODY;
  return {
    id: MESSAGE_ID,
    tenantId: TENANT_ID,
    threadId: '66666666-6666-4666-8666-666666666666',
    threadExternalId: 'gmail-thread-1',
    threadSubject: 'FY28 Ground Robotics strategy',
    clientId: CLIENT_ID,
    connectionId: '77777777-7777-4777-8777-777777777777',
    connectionOwnerUserId: OWNER_ID,
    accountEmail: 'neo@capiro.ai',
    source: 'google',
    externalId: 'gmail-message-1',
    currentSourceRevision: revisionFor(bodyText, 'google'),
    subject: 'FY28 Ground Robotics strategy',
    fromEmail: 'jane@example.com',
    fromName: 'Jane Smith',
    toRecipients: [{ email: 'neo@capiro.ai', name: 'Neo' }],
    ccRecipients: [],
    bccRecipients: [],
    sentAt: null,
    receivedAt: new Date('2026-08-14T13:00:00Z'),
    bodyText,
    hasAttachments: false,
    removedAt: null,
    removedReason: null,
    metadata: {
      internetMessageId: '<message-1@example.com>',
      bodyCompleteness: 'full',
    },
    raw: { snippet: 'Please protect PE 0605053A…' },
    attachments: [],
    createdAt: new Date('2026-08-14T13:00:30Z'),
    updatedAt: new Date('2026-08-14T13:01:00Z'),
    ...overrides,
  };
}

function outlookMessage(overrides: Partial<MailboxMessageRecord> = {}): MailboxMessageRecord {
  const bodyText = overrides.bodyText ?? GRAPH_BODY;
  return gmailMessage({
    source: 'outlook',
    externalId: 'outlook-message-1',
    currentSourceRevision: revisionFor(bodyText, 'outlook'),
    bodyText,
    metadata: {
      internetMessageId: '<outlook-1@example.com>',
      bodyCompleteness: 'full',
      bodyContentType: 'text',
    },
    raw: { body: { contentType: 'text' } },
    ...overrides,
  });
}

function harness(input: {
  jobs?: MailboxKnowledgeJobRecord[];
  messages?: MailboxMessageRecord[];
} = {}) {
  const jobs = input.jobs ?? [job(revisionFor(GMAIL_BODY, 'google'))];
  const messages = input.messages ?? [gmailMessage()];
  const created: KnowledgeEventRecord[] = [];
  const claimBatch = jest.fn(async () => jobs);
  const loadMessage = jest.fn(async (_tenantId: string, messageId: string) =>
    messages.find((candidate) => candidate.id === messageId) ?? null,
  );
  const complete = jest.fn(async () => undefined);
  const skip = jest.fn(async () => undefined);
  const fail = jest.fn(async () => undefined);
  const repository = {
    claimBatch,
    loadMessage,
    complete,
    skip,
    fail,
  } as unknown as MailboxKnowledgeRepository;
  const flags = {
    enabled: jest.fn(() => true),
    batchSize: jest.fn(() => 10),
    maxAttempts: jest.fn(() => 8),
  } as unknown as MailboxKnowledgeFlagsService;
  const append = jest.fn(async (tenantId: string, eventInput: Record<string, unknown>) => {
    const record = {
      id: `${EVENT_ID.slice(0, -1)}${created.length}`,
      tenantId,
      ...eventInput,
      idempotencyKey: buildKnowledgeEventIdempotencyKey({
        tenantId,
        sourceType: String(eventInput.sourceType),
        sourceId: String(eventInput.sourceId),
        sourceVersion: eventInput.sourceVersion ? String(eventInput.sourceVersion) : null,
        sourceContentHash: String(eventInput.sourceContentHash),
        eventType: String(eventInput.eventType),
      }),
      ingestedAt: new Date(),
      createdAt: new Date(),
    } as unknown as KnowledgeEventRecord;
    const existing = created.find((candidate) => candidate.idempotencyKey === record.idempotencyKey);
    if (existing) return existing;
    created.push(record);
    return record;
  });
  const events = { append } as unknown as KnowledgeEventService;
  const consumer = new MailboxKnowledgeConsumer(
    flags,
    repository,
    new MailboxNormalizerService(),
    new MailboxRelevanceService(),
    new MailboxThreadService(),
    events,
  );
  return { consumer, append, complete, skip, created };
}

describe('Phase 4 mailbox knowledge provider pipelines', () => {
  test('accepts an explicit full-body marker from either mailbox provider', () => {
    expect(hasAuthoritativeProviderBody(gmailMessage())).toBe(true);
    expect(hasAuthoritativeProviderBody(outlookMessage())).toBe(true);
    expect(
      hasAuthoritativeProviderBody(
        outlookMessage({
          metadata: { bodyCompleteness: 'preview' },
          bodyText: GRAPH_BODY,
        }),
      ),
    ).toBe(false);
  });

  test('Gmail sync -> durable job -> worker -> normalization -> relevance -> KnowledgeEvent', async () => {
    const sourceRevision = revisionFor(GMAIL_BODY, 'google');
    const { consumer, append, complete, created } = harness({
      jobs: [job(sourceRevision)],
      messages: [gmailMessage({ currentSourceRevision: sourceRevision })],
    });

    await expect(consumer.drainOnce()).resolves.toEqual({
      claimed: 1,
      succeeded: 1,
      skipped: 0,
      failed: 0,
    });
    expect(append).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({
        sourceType: 'gmail_message',
        sourceId: 'gmail-message-1',
        sourceVersion: sourceRevision,
        eventType: 'email_received',
      }),
    );
    expect(complete).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
  });

  test('Microsoft sync -> durable job -> worker -> normalization -> relevance -> KnowledgeEvent', async () => {
    const sourceRevision = revisionFor(GRAPH_BODY, 'outlook');
    const { consumer, append, created } = harness({
      jobs: [job(sourceRevision)],
      messages: [outlookMessage({ currentSourceRevision: sourceRevision })],
    });

    await expect(consumer.drainOnce()).resolves.toEqual({
      claimed: 1,
      succeeded: 1,
      skipped: 0,
      failed: 0,
    });
    expect(append).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({
        sourceType: 'microsoft_mail_message',
        sourceId: 'outlook-message-1',
        sourceVersion: sourceRevision,
        eventType: 'email_received',
      }),
    );
    expect(created).toHaveLength(1);
  });

  test('replaying the same provider message does not create a duplicate KnowledgeEvent', async () => {
    const sourceRevision = revisionFor(GMAIL_BODY, 'google');
    const first = harness({
      jobs: [job(sourceRevision)],
      messages: [gmailMessage({ currentSourceRevision: sourceRevision })],
    });
    await first.consumer.drainOnce();

    const replay = harness({
      jobs: [job(sourceRevision, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')],
      messages: [gmailMessage({ currentSourceRevision: sourceRevision })],
    });
    replay.append.mockImplementation(first.append);
    await replay.consumer.drainOnce();

    expect(first.append).toHaveBeenCalledTimes(2);
    expect(first.created).toHaveLength(1);
    expect(first.created[0]?.id).toBeDefined();
    expect(first.created[0]?.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    const firstInput = first.append.mock.calls[0]?.[1] as { sourceContentHash: string };
    const secondInput = first.append.mock.calls[1]?.[1] as { sourceContentHash: string };
    expect(firstInput.sourceContentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(secondInput.sourceContentHash).toBe(firstInput.sourceContentHash);
  });

  test('a material source update creates a new revision and event instead of mutating history', async () => {
    const originalBody = GMAIL_BODY;
    const updatedBody =
      'Updated after staff feedback: protect PE 0605053A and add report language on testing, not autonomy.';
    const originalRevision = revisionFor(originalBody, 'google');
    const updatedRevision = revisionFor(updatedBody, 'google', 'Updated FY28 Ground Robotics strategy');
    expect(updatedRevision).not.toBe(originalRevision);

    const original = harness({
      jobs: [job(originalRevision)],
      messages: [gmailMessage({ currentSourceRevision: originalRevision, bodyText: originalBody })],
    });
    await original.consumer.drainOnce();

    const updated = harness({
      jobs: [job(updatedRevision, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')],
      messages: [
        gmailMessage({
          currentSourceRevision: updatedRevision,
          bodyText: updatedBody,
          subject: 'Updated FY28 Ground Robotics strategy',
        }),
      ],
    });
    await updated.consumer.drainOnce();

    expect(original.created[0]?.sourceVersion).toBe(originalRevision);
    expect(updated.created[0]?.sourceVersion).toBe(updatedRevision);
    expect(original.created[0]?.sourceContentHash).not.toBe(updated.created[0]?.sourceContentHash);
    expect(original.created[0]?.idempotencyKey).not.toBe(updated.created[0]?.idempotencyKey);
  });
});
