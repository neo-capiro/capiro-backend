import { describe, expect, jest, test } from '@jest/globals';
import type { KnowledgeAssertionRecord } from '../knowledge.types.js';
import { KnowledgeAssertionService } from './knowledge-assertion.service.js';
import { AssertionConflictService } from './assertion-conflict.service.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';
const EVENT_ID = '33333333-3333-4333-8333-333333333333';
const GROUP_ID = '44444444-4444-4444-8444-444444444444';
const SOURCE_TEXT = 'The client opposes Section 421.';

const target = {
  id: TARGET_ID,
  tenantId: TENANT_ID,
  conflictGroupId: GROUP_ID,
} as KnowledgeAssertionRecord;

function contradictionInput() {
  return {
    originEventId: EVENT_ID,
    contradictsAssertionId: TARGET_ID,
    subjectType: 'client',
    subjectId: 'overland-ai',
    predicate: 'opposes',
    objectType: 'provision',
    objectId: 'section-421',
    assertionClass: 'position' as const,
    confidence: 0.95,
    authority: 'source_reported' as const,
    evidence: [
      {
        eventId: EVENT_ID,
        sourceType: 'gmail_message',
        sourceId: 'message-123',
        excerpt: SOURCE_TEXT,
        startOffset: 0,
        endOffset: SOURCE_TEXT.length,
        contentHash: 'a'.repeat(64),
        sourceText: SOURCE_TEXT,
      },
    ],
  };
}

describe('AssertionConflictService', () => {
  test('appends a confirmed contradiction in the target conflict group', async () => {
    const append = jest.fn(async () => ({ id: 'created' }) as KnowledgeAssertionRecord);
    const assertions = {
      findById: jest.fn(async () => target),
      append,
    } as unknown as KnowledgeAssertionService;
    const service = new AssertionConflictService(assertions);

    await service.contradict(TENANT_ID, contradictionInput());

    expect(append).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({
        contradictsAssertionId: TARGET_ID,
        conflictStatus: 'confirmed',
        conflictGroupId: GROUP_ID,
        evidence: contradictionInput().evidence,
      }),
    );
  });

  test('fails when the contradicted assertion is outside the tenant view', async () => {
    const assertions = {
      findById: jest.fn(async () => null),
      append: jest.fn(),
    } as unknown as KnowledgeAssertionService;
    const service = new AssertionConflictService(assertions);

    await expect(service.contradict(TENANT_ID, contradictionInput())).rejects.toThrow(
      'Contradicted KnowledgeAssertion not found',
    );
  });
});
