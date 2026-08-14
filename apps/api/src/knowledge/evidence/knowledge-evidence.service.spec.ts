import { describe, expect, jest, test } from '@jest/globals';
import { KnowledgeAssertionRepository } from '../assertions/knowledge-assertion.repository.js';
import { KnowledgeEventService } from '../events/knowledge-event.service.js';
import type {
  KnowledgeAssertionRecord,
  KnowledgeEvidenceRecord,
  KnowledgeEventRecord,
} from '../knowledge.types.js';
import { KnowledgeEvidenceRepository } from './knowledge-evidence.repository.js';
import { KnowledgeEvidenceService } from './knowledge-evidence.service.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ASSERTION_ID = '22222222-2222-4222-8222-222222222222';
const EVENT_ID = '33333333-3333-4333-8333-333333333333';

const assertion = {
  id: ASSERTION_ID,
  tenantId: TENANT_ID,
  predicate: 'opposes',
} as KnowledgeAssertionRecord;
const evidence = {
  id: '44444444-4444-4444-8444-444444444444',
  tenantId: TENANT_ID,
  assertionId: ASSERTION_ID,
  eventId: EVENT_ID,
  sourceType: 'gmail_message',
  sourceId: 'message-123',
  excerpt: 'We oppose Section 421.',
  startOffset: 0,
  endOffset: 22,
  contentHash: 'a'.repeat(64),
  createdAt: new Date('2026-04-14T12:00:00.000Z'),
} satisfies KnowledgeEvidenceRecord;
const event = {
  id: EVENT_ID,
  tenantId: TENANT_ID,
  sourceType: 'gmail_message',
  sourceId: 'message-123',
  occurredAt: new Date('2026-04-14T11:00:00.000Z'),
} as KnowledgeEventRecord;

function harness(options?: {
  assertion?: KnowledgeAssertionRecord | null;
  evidence?: KnowledgeEvidenceRecord[];
  event?: KnowledgeEventRecord | null;
}) {
  const evidenceRepository = {
    findByAssertionId: jest.fn(async () => options?.evidence ?? [evidence]),
    findByEventId: jest.fn(async () => [evidence]),
    findBySource: jest.fn(async () => [evidence]),
  } as unknown as KnowledgeEvidenceRepository;
  const assertionRepository = {
    findById: jest.fn(async () =>
      options && 'assertion' in options ? options.assertion : assertion,
    ),
  } as unknown as KnowledgeAssertionRepository;
  const eventService = {
    findById: jest.fn(async () =>
      options && 'event' in options ? options.event : event,
    ),
  } as unknown as KnowledgeEventService;
  return new KnowledgeEvidenceService(
    evidenceRepository,
    assertionRepository,
    eventService,
  );
}

describe('KnowledgeEvidenceService', () => {
  test('returns assertion, exact excerpt, and source event provenance', async () => {
    await expect(harness().getAssertionProvenance(TENANT_ID, ASSERTION_ID)).resolves.toEqual({
      assertion,
      evidence: [{ evidence, event }],
    });
  });

  test('fails closed when the assertion is outside the tenant view', async () => {
    await expect(
      harness({ assertion: null }).getAssertionProvenance(TENANT_ID, ASSERTION_ID),
    ).rejects.toThrow('KnowledgeAssertion not found');
  });

  test('fails loudly if durable proof is unexpectedly missing', async () => {
    await expect(
      harness({ evidence: [] }).getAssertionProvenance(TENANT_ID, ASSERTION_ID),
    ).rejects.toThrow('no immutable evidence provenance');
  });

  test('fails loudly if a linked source event cannot be resolved', async () => {
    await expect(
      harness({ event: null }).getAssertionProvenance(TENANT_ID, ASSERTION_ID),
    ).rejects.toThrow('unavailable KnowledgeEvent');
  });
});
