import { describe, expect, jest, test } from '@jest/globals';
import type {
  KnowledgeAssertionRecord,
  KnowledgeEventRecord,
  NormalizedKnowledgeAssertionInput,
} from '../knowledge.types.js';
import { KNOWLEDGE_ASSERTION_CLASSES } from '../knowledge.types.js';
import { KnowledgeEventService } from '../events/knowledge-event.service.js';
import { KnowledgeAssertionRepository } from './knowledge-assertion.repository.js';
import { KnowledgeAssertionService } from './knowledge-assertion.service.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const ASSERTION_ID = '33333333-3333-4333-8333-333333333333';

const event: KnowledgeEventRecord = {
  id: EVENT_ID,
  tenantId: TENANT_ID,
  idempotencyKey: 'a'.repeat(64),
  sourceType: 'gmail_message',
  sourceId: 'message-123',
  sourceVersion: 'v1',
  sourceContentHash: 'b'.repeat(64),
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
  };
}

function createHarness(origin: KnowledgeEventRecord | null = event) {
  const append = jest.fn(async (tenantId: string, input: NormalizedKnowledgeAssertionInput) =>
    ({
      ...input,
      id: ASSERTION_ID,
      tenantId,
      createdAt: new Date('2026-03-14T14:07:00.000Z'),
    }) satisfies KnowledgeAssertionRecord,
  );
  const assertions = {
    append,
    findById: jest.fn(async () => null),
  } as unknown as KnowledgeAssertionRepository;
  const events = {
    findById: jest.fn(async () => origin),
  } as unknown as KnowledgeEventService;
  return { service: new KnowledgeAssertionService(assertions, events), append };
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

  test('requires an existing evidence event', async () => {
    const { service } = createHarness(null);
    await expect(service.append(TENANT_ID, baseInput())).rejects.toThrow(
      'Origin KnowledgeEvent not found',
    );
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

  test('deduplicates a re-extraction of the same event and semantic assertion', async () => {
    const { service, append } = createHarness();
    await service.append(TENANT_ID, baseInput());
    await service.append(TENANT_ID, {
      ...baseInput(),
      confidence: 0.81,
      authority: 'model_inferred',
    });

    const first = append.mock.calls[0]?.[1];
    const second = append.mock.calls[1]?.[1];
    expect(first?.idempotencyKey).toBe(second?.idempotencyKey);
    expect(first?.validFrom).toEqual(event.observedAt);
    expect(first?.sensitivity).toBe(event.sensitivity);
    expect(first?.accessScope).toEqual(event.accessScope);
  });

  test('does not permit an ungrouped contradiction', async () => {
    const { service } = createHarness();
    await expect(
      service.append(TENANT_ID, {
        ...baseInput(),
        contradictsAssertionId: '44444444-4444-4444-8444-444444444444',
      }),
    ).rejects.toThrow('contradiction requires a conflict status');
  });
});
