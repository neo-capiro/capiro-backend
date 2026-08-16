import { describe, expect, jest, test } from '@jest/globals';
import type { KnowledgeEventRecord } from '../knowledge.types.js';
import { KnowledgeEventService } from '../events/knowledge-event.service.js';
import { MailboxKnowledgeConsumer } from './mailbox-knowledge.consumer.js';
import { MailboxKnowledgeFlagsService } from './mailbox-knowledge-flags.service.js';
import { MailboxKnowledgeRepository } from './mailbox-knowledge.repository.js';
import type {
  MailboxKnowledgeJobRecord,
  MailboxMessageRecord,
} from './mailbox-knowledge.types.js';
import { MailboxNormalizerService } from './mailbox-normalizer.service.js';
import { MailboxRelevanceService } from './mailbox-relevance.service.js';
import { MailboxThreadService } from './mailbox-thread.service.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const MESSAGE_ID = '22222222-2222-4222-8222-222222222222';
const JOB_ID = '33333333-3333-4333-8333-333333333333';
const CLIENT_ID = '44444444-4444-4444-8444-444444444444';
const EVENT_ID = '55555555-5555-4555-8555-555555555555';

const job: MailboxKnowledgeJobRecord = {
  id: JOB_ID,
  tenantId: TENANT_ID,
  mailMessageId: MESSAGE_ID,
  sourceRevision: 'a'.repeat(32),
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

function message(bodyText: string): MailboxMessageRecord {
  return {
    id: MESSAGE_ID,
    tenantId: TENANT_ID,
    threadId: '66666666-6666-4666-8666-666666666666',
    threadExternalId: 'gmail-thread-1',
    threadSubject: 'FY28 Ground Robotics strategy',
    clientId: CLIENT_ID,
    connectionId: '77777777-7777-4777-8777-777777777777',
    connectionOwnerUserId: '88888888-8888-4888-8888-888888888888',
    accountEmail: 'neo@capiro.ai',
    source: 'google',
    externalId: 'gmail-message-1',
    currentSourceRevision: job.sourceRevision,
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
    metadata: { internetMessageId: '<message-1@example.com>', bodyCompleteness: 'full' },
    raw: { snippet: 'Please protect PE 0605053A…' },
    attachments: [],
    createdAt: new Date('2026-08-14T13:00:30Z'),
    updatedAt: new Date('2026-08-14T13:01:00Z'),
  };
}

function harness(input: {
  enabled?: boolean;
  message?: MailboxMessageRecord | null;
  appendError?: Error;
} = {}) {
  const claimBatch = jest.fn(async () => [job]);
  const loadMessage = jest.fn(async () =>
    input.message === undefined
      ? message('Please protect PE 0605053A and avoid leading with autonomy in our committee outreach.')
      : input.message,
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
    enabled: jest.fn(() => input.enabled ?? true),
    batchSize: jest.fn(() => 10),
    maxAttempts: jest.fn(() => 8),
  } as unknown as MailboxKnowledgeFlagsService;
  const append = jest.fn(async (_tenantId: string, eventInput: Record<string, unknown>) => {
    if (input.appendError) throw input.appendError;
    return {
      id: EVENT_ID,
      tenantId: TENANT_ID,
      ...eventInput,
      idempotencyKey: 'f'.repeat(64),
      ingestedAt: new Date(),
      createdAt: new Date(),
    } as unknown as KnowledgeEventRecord;
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
  return { consumer, claimBatch, loadMessage, complete, skip, fail, append };
}

describe('MailboxKnowledgeConsumer', () => {
  test('does no work unless both rollout flags are enabled', async () => {
    const { consumer, claimBatch } = harness({ enabled: false });
    await expect(consumer.drainOnce()).resolves.toEqual({
      claimed: 0,
      succeeded: 0,
      skipped: 0,
      failed: 0,
    });
    expect(claimBatch).not.toHaveBeenCalled();
  });

  test('creates an immutable tenant-scoped event from a relevant synced message', async () => {
    const { consumer, append, complete } = harness();
    const result = await consumer.drainOnce();

    expect(result).toEqual({ claimed: 1, succeeded: 1, skipped: 0, failed: 0 });
    expect(append).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({
        sourceType: 'gmail_message',
        sourceId: 'gmail-message-1',
        sourceVersion: job.sourceRevision,
        sourceContentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        eventType: 'email_received',
        originTraceId: JOB_ID,
        accessScope: {
          kind: 'user',
          userId: '88888888-8888-4888-8888-888888888888',
          clientIds: [CLIENT_ID],
        },
      }),
    );
    expect(complete).toHaveBeenCalledWith(
      job,
      EVENT_ID,
      expect.stringMatching(/^[0-9a-f]{64}$/),
      expect.objectContaining({ eligible: true }),
    );
  });

  test('skips newsletters before any event or model extraction', async () => {
    const { consumer, append, skip } = harness({
      message: message(
        'Here is our weekly roundup. View this email in your browser or unsubscribe using the link below.',
      ),
    });
    const result = await consumer.drainOnce();
    expect(result.skipped).toBe(1);
    expect(append).not.toHaveBeenCalled();
    expect(skip).toHaveBeenCalledWith(
      job,
      expect.objectContaining({ category: 'newsletter', eligible: false }),
      'relevance gate: newsletter',
      expect.stringMatching(/^[0-9a-f]{64}$/),
    );
  });

  test('skips a superseded outbox revision instead of reading newer content under an old identity', async () => {
    const newer = message(
      'The client changed the strategy after this job was queued and the old revision must not be processed.',
    );
    newer.currentSourceRevision = 'b'.repeat(32);
    const { consumer, append, skip } = harness({ message: newer });
    const result = await consumer.drainOnce();
    expect(result.skipped).toBe(1);
    expect(append).not.toHaveBeenCalled();
    expect(skip).toHaveBeenCalledWith(
      job,
      null,
      'mail message revision was superseded before processing',
    );
  });

  test('fails closed when the mailbox owner cannot be established', async () => {
    const ownerless = message(
      'Please protect PE 0605053A and avoid leading with autonomy in our committee outreach.',
    );
    ownerless.connectionOwnerUserId = null;
    const { consumer, append, skip } = harness({ message: ownerless });
    const result = await consumer.drainOnce();
    expect(result.skipped).toBe(1);
    expect(append).not.toHaveBeenCalled();
    expect(skip).toHaveBeenCalledWith(
      job,
      null,
      'mailbox owner is unavailable; access scope cannot be derived safely',
    );
  });

  test('refuses a Gmail provider snippet that was stored as body text', async () => {
    const preview = message('This is only a provider snippet and not the complete authoritative body.');
    preview.raw = { snippet: preview.bodyText };
    preview.metadata = { ...preview.metadata, bodyCompleteness: 'preview' };
    const { consumer, append, skip } = harness({ message: preview });
    const result = await consumer.drainOnce();
    expect(result.skipped).toBe(1);
    expect(append).not.toHaveBeenCalled();
    expect(skip).toHaveBeenCalledWith(
      job,
      expect.objectContaining({ category: 'insufficient_content' }),
      'provider row contains only a preview; full authoritative body is required',
    );
  });

  test('refuses Outlook preview-only rows as factual source content', async () => {
    const preview = message(
      'This is only the short Microsoft Graph body preview and not the authoritative message body.',
    );
    preview.source = 'outlook';
    preview.raw = { bodyPreview: preview.bodyText };
    preview.metadata = { ...preview.metadata, bodyCompleteness: 'preview' };
    const { consumer, append, skip } = harness({ message: preview });
    const result = await consumer.drainOnce();
    expect(result.skipped).toBe(1);
    expect(append).not.toHaveBeenCalled();
    expect(skip).toHaveBeenCalledWith(
      job,
      expect.objectContaining({ category: 'insufficient_content' }),
      'provider row contains only a preview; full authoritative body is required',
    );
  });

  test('retries safely when event persistence fails', async () => {
    const { consumer, complete, fail } = harness({ appendError: new Error('database unavailable') });
    const result = await consumer.drainOnce();
    expect(result.failed).toBe(1);
    expect(complete).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(job, expect.any(Error), 8);
  });
});
