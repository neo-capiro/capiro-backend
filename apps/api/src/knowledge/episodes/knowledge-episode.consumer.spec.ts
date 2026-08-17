import { describe, expect, jest, test } from '@jest/globals';
import type { KnowledgeAssertionRepository } from '../assertions/knowledge-assertion.repository.js';
import type { KnowledgeEventRepository } from '../events/knowledge-event.repository.js';
import type { KnowledgeAssertionRecord, KnowledgeEventRecord } from '../knowledge.types.js';
import { KnowledgeEpisodeProjectionConsumer } from './knowledge-episode.consumer.js';
import type { KnowledgeEpisodeWorkerConfigService } from './knowledge-episode-worker-config.service.js';
import type { KnowledgeEpisodeRepository } from './knowledge-episode.repository.js';
import type {
  KnowledgeEpisodeProjectionJobRecord,
  KnowledgeEpisodeRecord,
} from './knowledge-episode.types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = jest.Mock<any>;

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const EPISODE_ID = '33333333-3333-4333-8333-333333333333';
const CONNECTION_ID = '44444444-4444-4444-8444-444444444444';
const ASSERTION_ID = '55555555-5555-4555-8555-555555555555';
const ENTITY_ID = '66666666-6666-4666-8666-666666666666';

function event(overrides: Partial<KnowledgeEventRecord> = {}): KnowledgeEventRecord {
  return {
    id: EVENT_ID,
    tenantId: TENANT_ID,
    idempotencyKey: 'key-1',
    sourceType: 'gmail_message',
    sourceId: 'msg-1',
    sourceVersion: 'rev-1',
    sourceContentHash: 'a'.repeat(64),
    eventType: 'email_received',
    occurredAt: new Date('2026-01-01T00:00:00Z'),
    observedAt: new Date('2026-01-01T00:00:00Z'),
    ingestedAt: new Date('2026-01-01T00:00:00Z'),
    actorRefs: [],
    entityRefs: [],
    clientRefs: [],
    sensitivity: 'normal',
    accessScope: { kind: 'user', userId: 'user-1', clientIds: [] },
    evidenceLocator: { connectionId: CONNECTION_ID, providerThreadId: 'thread-1' },
    metadata: {},
    originTraceId: null,
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function job(
  overrides: Partial<KnowledgeEpisodeProjectionJobRecord> = {},
): KnowledgeEpisodeProjectionJobRecord {
  return {
    id: 'job-1',
    tenantId: TENANT_ID,
    eventId: EVENT_ID,
    status: 'processing',
    attemptCount: 1,
    availableAt: new Date(),
    lockedAt: new Date(),
    lockedBy: 'worker-1',
    lastError: null,
    episodeId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function episode(overrides: Partial<KnowledgeEpisodeRecord> = {}): KnowledgeEpisodeRecord {
  return {
    id: EPISODE_ID,
    tenantId: TENANT_ID,
    strategy: 'mailbox_thread_v1',
    identityKey: 'c'.repeat(64),
    status: 'open',
    sensitivity: 'normal',
    accessScope: { kind: 'user', userId: 'user-1', clientIds: [] },
    clientRefs: [],
    groupingKey: {},
    eventCount: 0,
    assertionCount: 0,
    entityCount: 0,
    firstEventAt: new Date('2026-01-01T00:00:00Z'),
    lastEventAt: new Date('2026-01-01T00:00:00Z'),
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function assertion(overrides: Partial<KnowledgeAssertionRecord> = {}): KnowledgeAssertionRecord {
  return {
    id: ASSERTION_ID,
    tenantId: TENANT_ID,
    idempotencyKey: 'akey-1',
    originEventId: EVENT_ID,
    subjectType: 'canonical_entity',
    subjectId: ENTITY_ID,
    predicate: 'stated',
    objectType: 'text',
    objectId: null,
    objectValue: 'hello',
    assertionClass: 'fact',
    confidence: 0.9,
    authority: 'source_reported',
    observedAt: new Date(),
    validFrom: new Date(),
    validUntil: null,
    status: 'active',
    conflictStatus: 'none',
    conflictGroupId: null,
    supersedesAssertionId: null,
    contradictsAssertionId: null,
    sensitivity: 'normal',
    accessScope: { kind: 'user', userId: 'user-1', clientIds: [] },
    createdBy: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function harness(input: {
  event?: KnowledgeEventRecord | null;
  episode?: KnowledgeEpisodeRecord;
  assertions?: KnowledgeAssertionRecord[];
  completeReturns?: boolean;
}) {
  const config = {
    batchSize: jest.fn(() => 10),
    maxAttempts: jest.fn(() => 6),
  } as unknown as KnowledgeEpisodeWorkerConfigService;

  const claimBatch = jest.fn(async () => [] as KnowledgeEpisodeProjectionJobRecord[]);
  const repository = {
    claimBatch,
    findOrCreateEpisode: jest.fn(async () => input.episode ?? episode()),
    addEventMembership: jest.fn(async () => ({ inserted: true })),
    addAssertionMembership: jest.fn(async () => ({ inserted: true })),
    addEntityMembership: jest.fn(async () => ({ inserted: true })),
    complete: jest.fn(async () => input.completeReturns ?? true),
    skip: jest.fn(async () => true),
    fail: jest.fn(async () => true),
  } as unknown as KnowledgeEpisodeRepository;

  const events = {
    findById: jest.fn(async () => (input.event === undefined ? event() : input.event)),
  } as unknown as KnowledgeEventRepository;

  const assertions = {
    findByOriginEvent: jest.fn(async () => input.assertions ?? []),
  } as unknown as KnowledgeAssertionRepository;

  const consumer = new KnowledgeEpisodeProjectionConsumer(config, repository, events, assertions);
  return { consumer, config, repository, events, assertions };
}

describe('KnowledgeEpisodeProjectionConsumer', () => {
  test('processes an eligible pending projection job normally', async () => {
    const { consumer, repository } = harness({});
    (repository.claimBatch as AnyMock).mockResolvedValue([job()]);
    const result = await consumer.drainOnce();
    expect(result).toEqual({ claimed: 1, succeeded: 1, skipped: 0, failed: 0 });
    expect(repository.addEventMembership).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_ID, episodeId: EPISODE_ID, eventId: EVENT_ID }),
    );
    expect(repository.complete).toHaveBeenCalledWith(expect.anything(), EPISODE_ID);
  });

  test('does no work when no projection job is pending', async () => {
    const { consumer, repository } = harness({});
    const result = await consumer.drainOnce();
    expect(result).toEqual({ claimed: 0, succeeded: 0, skipped: 0, failed: 0 });
    expect(repository.findOrCreateEpisode).not.toHaveBeenCalled();
  });

  test('uses the job tenant for the immutable event lookup and rejects a mismatched event tenant', async () => {
    const { consumer, repository, events } = harness({
      event: event({ tenantId: OTHER_TENANT_ID }),
    });
    (repository.claimBatch as AnyMock).mockResolvedValue([job()]);
    const result = await consumer.drainOnce();
    expect(events.findById).toHaveBeenCalledWith(TENANT_ID, EVENT_ID);
    expect(result).toEqual({ claimed: 1, succeeded: 0, skipped: 0, failed: 1 });
    expect(repository.findOrCreateEpisode).not.toHaveBeenCalled();
  });

  test('skips when the KnowledgeEvent no longer exists', async () => {
    const { consumer, repository } = harness({ event: null });
    (repository.claimBatch as AnyMock).mockResolvedValue([job()]);
    const result = await consumer.drainOnce();
    expect(result.skipped).toBe(1);
    expect(repository.skip).toHaveBeenCalledWith(
      expect.anything(),
      'KnowledgeEvent no longer exists',
    );
  });

  test('skips when the KnowledgeEvent is not active', async () => {
    const { consumer, repository } = harness({ event: event({ status: 'withdrawn' }) });
    (repository.claimBatch as AnyMock).mockResolvedValue([job()]);
    const result = await consumer.drainOnce();
    expect(result.skipped).toBe(1);
  });

  test('skips when the event has no connectionId/providerThreadId (no groupable strategy yet)', async () => {
    const { consumer, repository } = harness({ event: event({ evidenceLocator: {} }) });
    (repository.claimBatch as AnyMock).mockResolvedValue([job()]);
    const result = await consumer.drainOnce();
    expect(result.skipped).toBe(1);
    expect(repository.findOrCreateEpisode).not.toHaveBeenCalled();
  });

  test('derives assertion and canonical-entity membership only from already-resolved assertions (no new resolution)', async () => {
    const { consumer, repository, assertions } = harness({
      assertions: [
        assertion({
          subjectType: 'canonical_entity',
          subjectId: ENTITY_ID,
          objectType: 'text',
          objectId: null,
        }),
      ],
    });
    (repository.claimBatch as AnyMock).mockResolvedValue([job()]);
    await consumer.drainOnce();
    expect(assertions.findByOriginEvent).toHaveBeenCalledWith(TENANT_ID, EVENT_ID);
    expect(repository.addAssertionMembership).toHaveBeenCalledWith(
      expect.objectContaining({
        episodeId: EPISODE_ID,
        assertionId: ASSERTION_ID,
        originEventId: EVENT_ID,
      }),
    );
    expect(repository.addEntityMembership).toHaveBeenCalledWith(
      expect.objectContaining({ episodeId: EPISODE_ID, canonicalEntityId: ENTITY_ID }),
    );
  });

  test('adds entity membership for a canonical_entity object as well as subject', async () => {
    const objectEntityId = '77777777-7777-4777-8777-777777777777';
    const { consumer, repository } = harness({
      assertions: [
        assertion({
          subjectType: 'canonical_entity',
          subjectId: ENTITY_ID,
          objectType: 'canonical_entity',
          objectId: objectEntityId,
        }),
      ],
    });
    (repository.claimBatch as AnyMock).mockResolvedValue([job()]);
    await consumer.drainOnce();
    const calls = (repository.addEntityMembership as AnyMock).mock.calls.map(
      (call: unknown[]) => (call[0] as { canonicalEntityId: string }).canonicalEntityId,
    );
    expect(calls).toEqual(expect.arrayContaining([ENTITY_ID, objectEntityId]));
  });

  test('does not add entity membership for a non-canonical_entity subject/object', async () => {
    const { consumer, repository } = harness({
      assertions: [
        assertion({
          subjectType: 'email_address',
          subjectId: 'jane@example.com',
          objectType: 'text',
          objectId: null,
        }),
      ],
    });
    (repository.claimBatch as AnyMock).mockResolvedValue([job()]);
    await consumer.drainOnce();
    expect(repository.addEntityMembership).not.toHaveBeenCalled();
  });

  test('a fenced/reclaimed job (complete returns false) reports skipped, not succeeded', async () => {
    const { consumer, repository } = harness({ completeReturns: false });
    (repository.claimBatch as AnyMock).mockResolvedValue([job()]);
    const result = await consumer.drainOnce();
    expect(result).toEqual({ claimed: 1, succeeded: 0, skipped: 1, failed: 0 });
  });

  test('a thrown error during projection calls repository.fail with the job and error', async () => {
    const { consumer, repository, events } = harness({});
    (events.findById as AnyMock).mockRejectedValue(new Error('boom'));
    (repository.claimBatch as AnyMock).mockResolvedValue([job()]);
    const result = await consumer.drainOnce();
    expect(result.failed).toBe(1);
    expect(repository.fail).toHaveBeenCalled();
  });

  test('a re-entrant drainOnce call while already draining claims no work', async () => {
    const { consumer, repository } = harness({});
    let resolveFirstClaim: (value: KnowledgeEpisodeProjectionJobRecord[]) => void = () => {};
    (repository.claimBatch as AnyMock).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFirstClaim = resolve;
        }),
    );
    const firstDrain = consumer.drainOnce();
    const secondDrain = await consumer.drainOnce();
    expect(secondDrain).toEqual({ claimed: 0, succeeded: 0, skipped: 0, failed: 0 });
    resolveFirstClaim([]);
    await firstDrain;
  });
});
