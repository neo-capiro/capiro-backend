import { describe, expect, test } from '@jest/globals';
import { normalizeFeedback } from './meri-feedback.helpers.js';

describe('normalizeFeedback', () => {
  test('accepts up / down and defaults reasons to empty', () => {
    expect(normalizeFeedback({ rating: 'up' })).toEqual({ rating: 'up', reasons: [], note: null });
    expect(normalizeFeedback({ rating: 'down' }).rating).toBe('down');
  });

  test('coerces any other rating to null (clearing feedback)', () => {
    expect(normalizeFeedback({ rating: 'maybe' }).rating).toBeNull();
    expect(normalizeFeedback({ rating: null }).rating).toBeNull();
    expect(normalizeFeedback({}).rating).toBeNull();
    expect(normalizeFeedback({ rating: 5 }).rating).toBeNull();
  });

  test('accepts only bounded known reason codes and deduplicates them', () => {
    expect(
      normalizeFeedback({
        rating: 'down',
        reasons: ['factually_wrong', 'wrong_client_context', 'factually_wrong', 'forged_reason'],
      }).reasons,
    ).toEqual(['factually_wrong', 'wrong_client_context']);
    expect(normalizeFeedback({ rating: 'down', reasons: 'factually_wrong' }).reasons).toEqual([]);
  });

  test('trims a note, drops empties, strips control characters, and treats non-strings as null', () => {
    expect(normalizeFeedback({ rating: 'down', note: '  too\u0000 vague  ' }).note).toBe('too vague');
    expect(normalizeFeedback({ rating: 'down', note: '   ' }).note).toBeNull();
    expect(normalizeFeedback({ rating: 'down', note: 123 }).note).toBeNull();
    expect(normalizeFeedback({ rating: 'up' }).note).toBeNull();
  });

  test('clamps a long note to 1000 chars', () => {
    const note = normalizeFeedback({ rating: 'down', note: 'x'.repeat(5000) }).note;
    expect(note).not.toBeNull();
    expect(note!.length).toBe(1000);
  });
});
