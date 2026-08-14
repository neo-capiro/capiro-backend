import { describe, expect, jest, test } from '@jest/globals';
import { KnowledgeEvidenceValidatorService } from '../evidence/knowledge-evidence-validator.service.js';
import type {
  KnowledgeAssertionRecord,
  KnowledgeEventRecord,
  NormalizedKnowledgeAssertionInput,
  NormalizedKnowledgeEvidenceInput,
} from '../knowledge.types.js';
import { KNOWLEDGE_ASSERTION_CLASSES } from '../knowledge.types.js';
import { KnowledgeEventService } from '../events/knowledge-event.service.js';
import { sha256Text } from '../knowledge.helpers.js';
import { KnowledgeAssertionRepository } from './knowledge-assertion.repository.js';
import { KnowledgeAssertionService } from './knowledge-assertion.service.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const ASSERTION_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_EVENT_ID = '44444444-4444-4444-8444-444444444444';
const SOURCE_TEXT = 'The client prefers a direct appropriations strategy for FY28.';
const EXCERPT = 'direct appropriations strategy';
const START_OFFSET = SOURCE_TEXT.indexOf(EXCERPT);
const END_OFFSET = START_OFFSET + EXCERPT.length;
const CONTENT_HASH = sha256Text(SOURCE_TEXT);

const event: KnowledgeEventRecord = {
  id: EVENT_ID,
  tenantId: TENANT_ID,
  idempotencyKey: 'a'.repeat(64),
  sourceType: 'gmail_message',
  sourceId: 'message-123',
  sourceVersion: 'v1',
  sourceContentHash: CONTENT_HASH,
  eventType: 'email_received',
  occurredAt: new Date('2026-03-14T14:00:00.000Z'),
  observedAt: new Date('2026-03-14T14:05:00.000Z'),
  ingestedAt: new Date('2026-03-14T14:06:00.000Z'),
  actorRefs: [],
  entityRefs: [],
  clientRefs: [],
  sensitivity: 'normal',
  accessScope: { kind: 'tenant' },
  evidenceLocator: { provider: 'google', messageId: 'message-123' },
  metadata: {},
  originTraceId: null,
  status: 'active',
  createdAt: new Date('2026-03-14T14:06:00.000Z'),
};

function evidenceInput(eventId = EVENT_ID) {
  return {
    eventId,
    sourceType: 'gmail_message',
    sourceId: eventId === EVENT_ID ? 'message-123' : 'message-456',
    excerpt: EXCERPT,
    startOffset: START_OFFSET,
    endOffset: END_OFFSET,
    contentHash: CONTENT_HASH,
    sourceText: SOURCE_TEXT,
  };
}

function baseInput() {
  return {
    originEventId: EVENT_ID,
    subjectType: 'client',
    subjectId: 'overland-ai',
    predicate: 'prefers',
    objectType: 'strategy',
    objectValue: 'direct appropriations strategy',
    assertionClass: 'preference' as const,
    confidence: 0.93,
    authority: 'source_reported' as const,
    evidence: [evidenceInput()],
  };
}

function createHarness(eventsById: Record<string, KnowledgeEventRecord> = { [EVENT_ID]: event }) {
  const appendWithEvidence = jest.fn(
    async (
      tenantId: string,
      input: NormalizedKnowledgeAssertionInput,
      _evidence: readonly NormalizedKnowledgeEvidenceInput[],
    ) =>
      ({
        ...input,
        id: ASSERTION_ID,
        tenantId,
        createdAt: new Date('2026-03-14T14:07:00.000Z'),
      }) satisfies KnowledgeAssertionRecord,
  );
  const assertions = {
    appendWithEvidence,
    findById: jest.fn(async () => null),
  } as unknown as KnowledgeAssertionRepository;
  const events = {
    findById: jest.fn(async (_tenantId: string, eventId: string) => eventsById[eventId] ?? null),
  } as unknown as KnowledgeEventService;
  return {
    service: new KnowledgeAssertionService(
      assertions,
      events,
      new KnowledgeEvidenceValidatorService(),
    ),
    appendWithEvidence,
  };
}

describe('KnowledgeAssertionService', () => {
  test('keeps the initial assertion taxonomy intentionally bounded', () => {
    expect(KNOWLEDGE_ASSERTION_CLASSES).toEqual([
      'fact',
      'preference',
      'decision',
      'commitment',
      'position',
      'goal',
      'constraint',
      'relationship',
      'expertise',
      'influence',
      'risk',
      'strategy',
    ]);
  });

  test('requires an existing origin event', async () => {
    const { service } = createHarness({});
    await expect(service.append(TENANT_ID, baseInput())).rejects.toThrow(
      'Origin KnowledgeEvent not found',
    );
  });

  test('requires at least one exact evidence link', async () => {
    const { service } = createHarness();
    await expect(
      service.append(TENANT_ID, { ...baseInput(), evidence: [] }),
    ).rejects.toThrow('requires evidence');
  });

  test('requires an object and inherits source sensitivity and scope', async () => {
    const { service } = createHarness();
    await expect(
      service.append(TENANT_ID, {
        ...baseInput(),
        objectValue: undefined,
      }),
    ).rejects.toThrow('requires objectId or objectValue');

    await expect(
      service.append(TENANT_ID, {
        ...baseInput(),
        accessScope: { kind: 'public' },
      }),
    ).rejects.toThrow('must inherit from its origin KnowledgeEvent');
  });

  test('writes the assertion and normalized proof through one repository call', async () => {
    const { service, appendWithEvidence } = createHarness();
    await service.append(TENANT_ID, baseInput());

    expect(appendWithEvidence).toHaveBeenCalledTimes(1);
    expect(appendWithEvidence.mock.calls[0]?.[2]).toEqual([
      expect.objectContaining({
        eventId: EVENT_ID,
        excerpt: EXCERPT,
        startOffset: START_OFFSET,
        endOffset: END_OFFSET,
        contentHash: CONTENT_HASH,
      }),
    ]);
  });

  test('deduplicates a re-extraction of the same event and semantic assertion', async () => {
    const { service, appendWithEvidence } = createHarness();
    await service.append(TENANT_ID, baseInput());
    await service.append(TENANT_ID, {
      ...baseInput(),
      confidence: 0.81,
      authority: 'model_inferred',
    });

    const first = appendWithEvidence.mock.calls[0]?.[1];
    const second = appendWithEvidence.mock.calls[1]?.[1];
    expect(first?.idempotencyKey).toBe(second?.idempotencyKey);
    expect(first?.validFrom).toEqual(event.observedAt);
    expect(first?.sensitivity).toBe(event.sensitivity);
    expect(first?.accessScope).toEqual(event.accessScope);
  });

  test('requires the origin event itself to support the assertion', async () => {
    const otherEvent = {
      ...event,
      id: OTHER_EVENT_ID,
      sourceId: 'message-456',
    } satisfies KnowledgeEventRecord;
    const { service } = createHarness({
      [EVENT_ID]: event,
      [OTHER_EVENT_ID]: otherEvent,
    });

    await expect(
      service.append(TENANT_ID, {
        ...baseInput(),
        evidence: [evidenceInput(OTHER_EVENT_ID)],
      }),
    ).rejects.toThrow('must come from the origin KnowledgeEvent');
  });

  test('does not permit an ungrouped contradiction', async () => {
    const { service } = createHarness();
    await expect(
      service.append(TENANT_ID, {
        ...baseInput(),
        contradictsAssertionId: '55555555-5555-4555-8555-555555555555',
      }),
    ).rejects.toThrow('contradiction requires a conflict status');
  });
});
