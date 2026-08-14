import { describe, expect, jest, test } from '@jest/globals';
import type { KnowledgeAssertionRecord } from '../knowledge.types.js';
import { KnowledgeAssertionService } from './knowledge-assertion.service.js';
import { AssertionConsolidationService } from './assertion-consolidation.service.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';
const EVENT_ID = '33333333-3333-4333-8333-333333333333';
const SOURCE_TEXT = 'The new goal is FY28 funding for PE 0605053A.';

function replacementInput() {
  return {
    originEventId: EVENT_ID,
    supersedesAssertionId: TARGET_ID,
    subjectType: 'client',
    subjectId: 'overland-ai',
    predicate: 'goal',
    objectType: 'program_element',
    objectId: '0605053A',
    assertionClass: 'goal' as const,
    confidence: 1,
    authority: 'human_confirmed' as const,
    evidence: [
      {
        eventId: EVENT_ID,
        sourceType: 'user_correction',
        sourceId: 'correction-123',
        excerpt: SOURCE_TEXT,
        startOffset: 0,
        endOffset: SOURCE_TEXT.length,
        contentHash: 'a'.repeat(64),
        sourceText: SOURCE_TEXT,
      },
    ],
  };
}

describe('AssertionConsolidationService', () => {
  test('appends a replacement while retaining the superseded assertion and new proof', async () => {
    const append = jest.fn(async () => ({ id: 'created' }) as KnowledgeAssertionRecord);
    const assertions = {
      findById: jest.fn(async () => ({ id: TARGET_ID }) as KnowledgeAssertionRecord),
      append,
    } as unknown as KnowledgeAssertionService;
    const service = new AssertionConsolidationService(assertions);

    await service.supersede(TENANT_ID, replacementInput());

    expect(append).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({
        supersedesAssertionId: TARGET_ID,
        evidence: replacementInput().evidence,
      }),
    );
  });

  test('fails when the superseded assertion is outside the tenant view', async () => {
    const assertions = {
      findById: jest.fn(async () => null),
      append: jest.fn(),
    } as unknown as KnowledgeAssertionService;
    const service = new AssertionConsolidationService(assertions);

    await expect(service.supersede(TENANT_ID, replacementInput())).rejects.toThrow(
      'Superseded KnowledgeAssertion not found',
    );
  });
});
