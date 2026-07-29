import { describe, expect, test } from '@jest/globals';
import { decideProducerAction } from './producer-decision.js';

const producerRow = {
  id: 'row-1',
  workflowStatus: 'suggested',
  userCreated: false,
  evidenceSourceType: 'deterministic_relevance_v1',
  staleAt: null,
};

describe('funding opportunity producer decisions', () => {
  test.each(['saved', 'pursuing', 'dismissed', 'won', 'lost'])(
    'preserves the human status %s',
    (workflowStatus) => {
      expect(
        decideProducerAction({
          existing: { ...producerRow, workflowStatus },
          relevanceScore: 0,
          meetsSuggestionFloor: false,
          minRelevance: 20,
        }),
      ).toEqual({ action: 'skip_human_decision', id: 'row-1' });
    },
  );

  test('preserves any user-created row even if its status is suggested', () => {
    expect(
      decideProducerAction({
        existing: { ...producerRow, userCreated: true },
        relevanceScore: 0,
        meetsSuggestionFloor: false,
        minRelevance: 20,
      }),
    ).toEqual({ action: 'skip_human_decision', id: 'row-1' });
  });

  test('refreshes a qualifying machine suggestion', () => {
    expect(
      decideProducerAction({
        existing: producerRow,
        relevanceScore: 45,
        meetsSuggestionFloor: true,
        minRelevance: 20,
      }),
    ).toEqual({ action: 'refresh', id: 'row-1', relevanceScore: 45 });
  });

  test('marks a machine suggestion stale once and then no-ops', () => {
    expect(
      decideProducerAction({
        existing: producerRow,
        relevanceScore: 0,
        meetsSuggestionFloor: false,
        minRelevance: 20,
      }),
    ).toEqual({ action: 'mark_stale', id: 'row-1' });
    expect(
      decideProducerAction({
        existing: { ...producerRow, staleAt: new Date() },
        relevanceScore: 0,
        meetsSuggestionFloor: false,
        minRelevance: 20,
      }),
    ).toEqual({ action: 'noop' });
  });
});
