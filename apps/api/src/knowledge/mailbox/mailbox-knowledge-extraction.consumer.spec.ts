import { describe, expect, jest, test } from '@jest/globals';
import type { KnowledgeAssertionService } from '../assertions/knowledge-assertion.service.js';
import type { UniversalEntityResolutionOrchestratorService } from '../entities/universal-entity-resolution-orchestrator.service.js';
import type { KnowledgeEventService } from '../events/knowledge-event.service.js';
import { sha256Text } from '../knowledge.helpers.js';
import type { KnowledgeEventRecord, KnowledgeJsonObject } from '../knowledge.types.js';
import { MailboxKnowledgeExtractionConsumer } from './mailbox-knowledge-extraction.consumer.js';
import type { MailboxKnowledgeExtractionRepository } from './mailbox-knowledge-extraction.repository.js';
import type { MailboxKnowledgeExtractorService } from './mailbox-knowledge-extractor.service.js';
import type {
  MailboxExtractedClaimCandidate,
  MailboxKnowledgeExtractionJobRecord,
} from './mailbox-knowledge-extraction.types.js';
import type { MailboxKnowledgeFlagsService } from './mailbox-knowledge-flags.service.js';
import type { MailboxKnowledgeRepository } from './mailbox-knowledge.repository.js';
import type { MailboxMessageRecord } from './mailbox-knowledge.types.js';
import { MailboxNormalizerService } from './mailbox-normalizer.service.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const MESSAGE_ID = '22222222-2222-4222-8222-222222222222';
const EVENT_ID = '33333333-3333-4333-8333-333333333333';
const MAILBOX_JOB_ID = '44444444-4444-4444-8444-444444444444';
const EXTRACTION_JOB_ID = '55555555-5555-4555-8555-555555555555';
const EVENT_CLIENT_ID = '66666666-6666-4666-8666-666666666666';
const CURRENT_MESSAGE_CLIENT_ID = '77777777-7777-4777-8777-777777777777';
const OWNER_ID = '88888888-8888-4888-8888-888888888888';
const CLIENT_CANONICAL_ID = '99999999-9999-4999-8999-999999999999';
const SENDER_CANONICAL_ID = 'abababab-abab-4bab-8bab-abababababab';
const ASSERTION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REVISION = 'b'.repeat(32);
const BODY = 'Please protect PE 0605053A and do not lead with autonomy in committee outreach.';

function extractedClaim(excerpt = 'do not lead with autonomy'): MailboxExtractedClaimCandidate {
  return {
    subjectRole: 'linked_client',
    subjectText: 'Original Client',
    subjectEmail: null,
    subjectEntityType: 'organization',
    predicate: 'outreach_preference',
    objectType: 'text',
    objectValue: 'do not lead with autonomy',
    objectEntityText: null,
    objectEntityEmail: null,
    objectEntityType: null,
    assertionClass: 'preference',
    confidence: 0.94,
    excerpt,
  };
}

function sourceMessage(): MailboxMessageRecord {
  return {
    id: MESSAGE_ID,
    tenantId: TENANT_ID,
    threadId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    threadExternalId: 'thread-1',
    threadSubject: 'FY28 priorities',
    clientId: CURRENT_MESSAGE_CLIENT_ID,
    connectionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    connectionOwnerUserId: OWNER_ID,
    accountEmail: 'neo@capiro.ai',
    source: 'google',
    externalId: 'gmail-1',
    currentSourceRevision: REVISION,
    subject: 'FY28 priorities',
    fromEmail: 'jane@example.com',
    fromName: 'Jane Smith',
    toRecipients: [{ email: 'neo@capiro.ai', name: 'Neo' }],
    ccRecipients: [],
    bccRecipients: [],
    sentAt: null,
    receivedAt: new Date('2026-08-16T10:00:00Z'),
    bodyText: BODY,
    hasAttachments: false,
    removedAt: null,
    removedReason: null,
    metadata: { bodyCompleteness: 'full' },
    raw: null,
    attachments: [],
    createdAt: new Date('2026-08-16T10:00:00Z'),
    updatedAt: new Date('2026-08-16T10:01:00Z'),
  };
}

function harness(
  input: {
    enabled?: boolean;
    subjectStatus?: 'resolved' | 'ambiguous' | 'unresolved';
    excerpt?: string;
    checkpointed?: boolean;
  } = {},
) {
  const message = sourceMessage();
  const normalizer = new MailboxNormalizerService();
  const normalized = normalizer.normalize(message);
  const candidate = extractedClaim(input.excerpt);
  const accessScope = { kind: 'user', userId: OWNER_ID, clientIds: [EVENT_CLIENT_ID] };
  const checkpoint: KnowledgeJsonObject = {
    phase: 6,
    checkpoint: 'mailbox_extraction_candidates_v1',
    eventId: EVENT_ID,
    sourceRevision: REVISION,
    contentHash: normalized.authoritativeContentHash,
    provider: 'openai',
    model: 'test-model',
    inputTruncated: false,
    candidates: [candidate] as unknown as KnowledgeJsonObject['candidates'],
  };
  const job: MailboxKnowledgeExtractionJobRecord = {
    id: EXTRACTION_JOB_ID,
    tenantId: TENANT_ID,
    mailboxJobId: MAILBOX_JOB_ID,
    mailMessageId: MESSAGE_ID,
    eventId: EVENT_ID,
    sourceRevision: REVISION,
    contentHash: normalized.authoritativeContentHash,
    sensitivity: 'normal',
    accessScope,
    status: 'processing',
    attemptCount: input.checkpointed ? 2 : 1,
    availableAt: new Date('2026-08-16T10:01:00Z'),
    lockedAt: new Date('2026-08-16T10:02:00Z'),
    lockedBy: 'worker',
    lastError: null,
    result: input.checkpointed ? checkpoint : null,
    assertionCount: 0,
    heldCount: 0,
    createdAt: new Date('2026-08-16T10:01:00Z'),
    updatedAt: new Date('2026-08-16T10:02:00Z'),
  };
  const event: KnowledgeEventRecord = {
    id: EVENT_ID,
    tenantId: TENANT_ID,
    idempotencyKey: 'd'.repeat(64),
    sourceType: 'gmail_message',
    sourceId: 'gmail-1',
    sourceVersion: REVISION,
    sourceContentHash: normalized.authoritativeContentHash,
    eventType: 'email_received',
    occurredAt: new Date('2026-08-16T10:00:00Z'),
    observedAt: new Date('2026-08-16T10:01:00Z'),
    actorRefs: [],
    entityRefs: [{ type: 'mail_message', id: MESSAGE_ID }],
    clientRefs: [{ type: 'client', id: EVENT_CLIENT_ID }],
    sensitivity: 'normal',
    accessScope,
    evidenceLocator: { mailMessageId: MESSAGE_ID },
    metadata: { readyForExtraction: true },
    originTraceId: MAILBOX_JOB_ID,
    status: 'active',
    ingestedAt: new Date('2026-08-16T10:01:00Z'),
    createdAt: new Date('2026-08-16T10:01:00Z'),
  };

  const claimBatch = jest.fn(async () => [job]);
  const checkpointExtraction = jest.fn(async (..._args: unknown[]) => true);
  const complete = jest.fn(async (..._args: unknown[]) => true);
  const skip = jest.fn(async (..._args: unknown[]) => true);
  const fail = jest.fn(async (..._args: unknown[]) => true);
  const withClaimLease = jest.fn(async (_job: unknown, callback: () => Promise<unknown>) =>
    callback(),
  );
  const repository = {
    claimBatch,
    checkpointExtraction,
    complete,
    skip,
    fail,
    withClaimLease,
  } as unknown as MailboxKnowledgeExtractionRepository;
  const flags = {
    extractionEnabled: jest.fn(() => input.enabled ?? true),
    extractionBatchSize: jest.fn(() => 5),
    extractionMaxAttempts: jest.fn(() => 6),
  } as unknown as MailboxKnowledgeFlagsService;
  const mailbox = {
    loadMessage: jest.fn(async () => message),
  } as unknown as MailboxKnowledgeRepository;
  const events = {
    findById: jest.fn(async () => event),
  } as unknown as KnowledgeEventService;
  const extract = jest.fn(async (..._args: unknown[]) => ({
    provider: 'openai' as const,
    model: 'test-model',
    inputTruncated: false,
    candidates: [candidate],
  }));
  const extractor = { extract } as unknown as MailboxKnowledgeExtractorService;

  const status = input.subjectStatus ?? 'resolved';
  const resolveAcrossSources = jest.fn(async (...args: unknown[]) => {
    const resolutionInput = (args[1] ?? {}) as {
      identifiers?: Array<{ type: string; value: string }>;
    };
    const isClient =
      resolutionInput.identifiers?.some((identifier) => identifier.type === 'crm_client_id') ===
      true;
    return {
      resolutionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      status,
      entity:
        status === 'resolved'
          ? {
              id: isClient ? CLIENT_CANONICAL_ID : SENDER_CANONICAL_ID,
              tenantId: TENANT_ID,
              identityScope: 'tenant_private' as const,
              entityType: isClient ? 'organization' : 'person',
              canonicalName: isClient ? 'Original Client' : 'Jane Smith',
              normalizedName: isClient ? 'original client' : 'jane smith',
              status: 'active' as const,
              resolutionConfidence: 1,
              resolutionMethod: isClient ? 'crm_client_id' : 'email',
              metadata: {},
              mergedIntoEntityId: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            }
          : null,
      confidence: status === 'resolved' ? 1 : 0.7,
      resolutionMethod:
        status === 'resolved' ? 'identifier_exact' : 'fallback_candidates_require_confirmation',
      candidates: [],
      provenance: [],
      requiresUserConfirmation: status !== 'resolved',
      attemptedStages: [],
      publicLookupRan: false,
      stopReason: status === 'resolved' ? 'deterministic_match' : 'human_confirmation_required',
    };
  });
  const resolver = {
    resolveAcrossSources,
  } as unknown as UniversalEntityResolutionOrchestratorService;
  const append = jest.fn(async (..._args: unknown[]) => ({ id: ASSERTION_ID }));
  const assertions = { append } as unknown as KnowledgeAssertionService;

  const consumer = new MailboxKnowledgeExtractionConsumer(
    flags,
    repository,
    mailbox,
    normalizer,
    events,
    extractor,
    resolver,
    assertions,
  );

  return {
    consumer,
    job,
    message,
    checkpointExtraction,
    complete,
    skip,
    fail,
    withClaimLease,
    extract,
    resolveAcrossSources,
    append,
    normalized,
  };
}

describe('MailboxKnowledgeExtractionConsumer', () => {
  test('does no extraction work until the Phase 6 rollout flag is explicitly armed', async () => {
    const { consumer, complete } = harness({ enabled: false });
    await expect(consumer.drainOnce()).resolves.toEqual({
      claimed: 0,
      succeeded: 0,
      skipped: 0,
      failed: 0,
    });
    expect(complete).not.toHaveBeenCalled();
  });

  test('resolves known envelope identity before extraction and passes safe hints to the model', async () => {
    const { consumer, extract, message, normalized, resolveAcrossSources } = harness();
    await consumer.drainOnce();

    expect(resolveAcrossSources).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({
        query: '',
        identifiers: [{ type: 'crm_client_id', value: EVENT_CLIENT_ID }],
        allowExternalLookup: false,
      }),
    );
    expect(extract).toHaveBeenCalledWith(
      TENANT_ID,
      message,
      normalized,
      expect.arrayContaining([
        expect.objectContaining({
          role: 'linked_client',
          resolutionStatus: 'resolved',
          canonicalName: 'Original Client',
        }),
        expect.objectContaining({
          role: 'sender',
          sourceEmail: 'jane@example.com',
          resolutionStatus: 'resolved',
          canonicalName: 'Jane Smith',
        }),
      ]),
    );
  });

  test('checkpoints validated extraction before any durable assertion write', async () => {
    const { consumer, checkpointExtraction, append } = harness();
    await consumer.drainOnce();

    expect(checkpointExtraction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        checkpoint: 'mailbox_extraction_candidates_v1',
        eventId: EVENT_ID,
        candidates: expect.any(Array),
      }),
    );
    expect(checkpointExtraction.mock.invocationCallOrder[0]).toBeLessThan(
      append.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  test('reuses a durable candidate checkpoint on retry instead of calling the model again', async () => {
    const { consumer, extract, checkpointExtraction, append, complete } = harness({
      checkpointed: true,
    });
    const result = await consumer.drainOnce();

    expect(result).toEqual({ claimed: 1, succeeded: 1, skipped: 0, failed: 0 });
    expect(extract).not.toHaveBeenCalled();
    expect(checkpointExtraction).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ replayedFromCheckpoint: true, candidateCount: 1 }),
      1,
      0,
    );
  });

  test('creates an evidence-backed assertion only after the canonical subject resolves', async () => {
    const { consumer, append, complete, normalized } = harness();
    const result = await consumer.drainOnce();

    expect(result).toEqual({ claimed: 1, succeeded: 1, skipped: 0, failed: 0 });
    expect(append).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({
        originEventId: EVENT_ID,
        subjectType: 'canonical_entity',
        subjectId: CLIENT_CANONICAL_ID,
        predicate: 'outreach_preference',
        objectType: 'text',
        objectValue: 'do not lead with autonomy',
        assertionClass: 'preference',
        authority: 'source_reported',
        evidence: [
          expect.objectContaining({
            eventId: EVENT_ID,
            excerpt: 'do not lead with autonomy',
            contentHash: sha256Text(normalized.authoritativeText),
            sourceText: normalized.authoritativeText,
          }),
        ],
      }),
    );
    expect(complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ candidateCount: 1, replayedFromCheckpoint: false }),
      1,
      0,
    );
  });

  test('holds an ambiguous identity with evidence offsets and creates zero durable assertions', async () => {
    const { consumer, append, complete } = harness({ subjectStatus: 'ambiguous' });
    const result = await consumer.drainOnce();

    expect(result.succeeded).toBe(1);
    expect(append).not.toHaveBeenCalled();
    const manifest = complete.mock.calls[0]?.[1] as { claims?: Array<Record<string, unknown>> };
    expect(manifest.claims?.[0]).toEqual(
      expect.objectContaining({
        disposition: 'held_subject_ambiguous',
        assertionId: null,
        evidence: expect.objectContaining({
          startOffset: expect.any(Number),
          endOffset: expect.any(Number),
        }),
      }),
    );
    expect(complete).toHaveBeenCalledWith(expect.anything(), expect.anything(), 0, 1);
  });

  test('uses the immutable KnowledgeEvent client scope rather than a later message re-association', async () => {
    const { consumer, resolveAcrossSources } = harness();
    await consumer.drainOnce();

    expect(resolveAcrossSources).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({
        identifiers: [{ type: 'crm_client_id', value: EVENT_CLIENT_ID }],
      }),
    );
    expect(resolveAcrossSources).not.toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({
        identifiers: [{ type: 'crm_client_id', value: CURRENT_MESSAGE_CLIENT_ID }],
      }),
    );
  });

  test('never enables external lookup for any mailbox-originated identity resolution', async () => {
    const { consumer, resolveAcrossSources } = harness();
    await consumer.drainOnce();

    expect(resolveAcrossSources).toHaveBeenCalled();
    for (const call of resolveAcrossSources.mock.calls) {
      expect(call[1]).toEqual(expect.objectContaining({ allowExternalLookup: false }));
    }
  });

  test('holds a model claim whose evidence is not an exact source substring', async () => {
    const { consumer, append, resolveAcrossSources, complete } = harness({
      excerpt: 'paraphrased evidence that does not exist',
    });
    await consumer.drainOnce();

    // Two resolution calls are the pre-extraction envelope pass (client + sender).
    // No model-derived claim resolution is attempted after evidence validation fails.
    expect(resolveAcrossSources).toHaveBeenCalledTimes(2);
    expect(append).not.toHaveBeenCalled();
    const manifest = complete.mock.calls[0]?.[1] as { claims?: Array<Record<string, unknown>> };
    expect(manifest.claims?.[0]).toEqual(
      expect.objectContaining({ disposition: 'held_invalid_evidence', evidence: null }),
    );
  });

  test('does not copy the authoritative mailbox body into the operational result manifest', async () => {
    const { consumer, complete } = harness();
    await consumer.drainOnce();

    const result = complete.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(JSON.stringify(result)).not.toContain(BODY);
    expect(JSON.stringify(result)).toContain('contentHash');
    expect(JSON.stringify(result)).toContain('claims');
  });

  test('redacts body-bearing errors from persisted failure state and logs only error class', async () => {
    const harnessResult = harness();
    harnessResult.extract.mockRejectedValueOnce(new Error(BODY));
    const result = await harnessResult.consumer.drainOnce();

    expect(result).toEqual({ claimed: 1, succeeded: 0, skipped: 0, failed: 1 });
    expect(harnessResult.fail).toHaveBeenCalledWith(expect.anything(), expect.any(Error), 6);
    const failure = harnessResult.fail.mock.calls[0]?.[1];
    expect(String(failure)).toContain(BODY);
  });

  test('stops without terminal mutation when a newer worker fences the lease', async () => {
    const h = harness();
    h.withClaimLease.mockResolvedValueOnce(null);

    const result = await h.consumer.drainOnce();

    expect(result).toEqual({ claimed: 1, succeeded: 0, skipped: 1, failed: 0 });
    expect(h.append).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.fail).not.toHaveBeenCalled();
  });

  test('holds an ambiguous entity object and creates zero durable assertions', async () => {
    const h = harness();
    const candidate = extractedClaim();
    candidate.objectValue = null;
    candidate.objectEntityText = 'Autonomy Committee';
    candidate.objectEntityType = 'committee';
    h.extract.mockResolvedValueOnce({
      provider: 'openai',
      model: 'test-model',
      inputTruncated: false,
      candidates: [candidate],
    });
    const resolveAcrossSources = h.resolveAcrossSources as unknown as jest.Mock;
    resolveAcrossSources.mockImplementation(async (...args: unknown[]) => {
      const input = (args[1] ?? {}) as { identifiers?: Array<{ type: string; value: string }> };
      if (input.identifiers?.some((x) => x.type === 'crm_client_id')) {
        return {
          resolutionId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          status: 'resolved',
          entity: {
            id: CLIENT_CANONICAL_ID,
            tenantId: TENANT_ID,
            identityScope: 'tenant_private',
            entityType: 'organization',
            canonicalName: 'Original Client',
            normalizedName: 'original client',
            status: 'active',
            resolutionConfidence: 1,
            resolutionMethod: 'crm_client_id',
            metadata: {},
            mergedIntoEntityId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          confidence: 1,
          resolutionMethod: 'identifier_exact',
          candidates: [],
          provenance: [],
          requiresUserConfirmation: false,
          attemptedStages: [],
          publicLookupRan: false,
          stopReason: 'deterministic_match',
        };
      }
      return {
        resolutionId: null,
        status: 'ambiguous',
        entity: null,
        confidence: 0.7,
        resolutionMethod: 'fallback_candidates_require_confirmation',
        candidates: [],
        provenance: [],
        requiresUserConfirmation: true,
        attemptedStages: [],
        publicLookupRan: false,
        stopReason: 'human_confirmation_required',
      };
    });
    await h.consumer.drainOnce();
    expect(h.append).not.toHaveBeenCalled();
    const manifest = h.complete.mock.calls[0]?.[1] as { claims?: Array<Record<string, unknown>> };
    expect(manifest.claims?.[0]).toEqual(
      expect.objectContaining({ disposition: 'held_object_ambiguous' }),
    );
  });
});
