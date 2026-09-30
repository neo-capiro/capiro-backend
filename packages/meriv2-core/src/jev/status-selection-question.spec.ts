import { describe, expect, it } from '@jest/globals';
import { buildStatusSelectionQuestion, selectedStatusSpan } from './status-selection-question';

describe('status selection question', () => {
  const candidates = [
    { id: 'candidate_1', span: 'Current status: Authorized – Moderate' },
    { id: 'candidate_2', span: 'Previously listed as Ready' },
  ];
  it('provides bounded candidates plus mandatory non-selection outcomes', () => {
    const question = buildStatusSelectionQuestion({
      entity: 'Example Cloud',
      program: 'Example Program',
      pageText: 'bounded page',
      candidates,
    });
    expect(question.questions.status_selection).toMatchObject({
      type: 'choice',
      criteria: {
        candidate_1: candidates[0]?.span,
        candidate_2: candidates[1]?.span,
        not_stated: expect.any(String),
        ambiguous: expect.any(String),
      },
    });
  });
  it('copies the selected span byte-for-byte and never composes status text', () => {
    expect(selectedStatusSpan(candidates, 'candidate_1')).toBe(candidates[0]?.span);
    expect(selectedStatusSpan(candidates, 'not_stated')).toBeNull();
    expect(selectedStatusSpan(candidates, 'invented')).toBeNull();
  });
});
