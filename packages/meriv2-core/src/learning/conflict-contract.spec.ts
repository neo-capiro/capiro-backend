import { describe, expect, it } from '@jest/globals';
import {
  classifyMemoryConflictMatch,
  describeMemoryConflictMatch,
  normalizeFactText,
  MEMORY_CONFLICT_SIMILARITY_THRESHOLDS,
  MEMORY_CONFLICT_MATCH_KINDS,
} from './conflict-contract';

describe('classifyMemoryConflictMatch (Phase 27C)', () => {
  it('is a closed vocabulary of exactly the four documented kinds', () => {
    expect([...MEMORY_CONFLICT_MATCH_KINDS].sort()).toEqual(
      ['duplicate', 'possible_related', 'probable_contradiction', 'unrelated'].sort(),
    );
  });

  it('high score + equal text = duplicate (corroboration, not a new candidate)', () => {
    expect(classifyMemoryConflictMatch({ score: 0.95, textsEqual: true })).toBe('duplicate');
  });

  it('CORE EXAMPLE: high score + different text (monthly vs weekly) = probable_contradiction, never silently overwritten', () => {
    expect(classifyMemoryConflictMatch({ score: 0.93, textsEqual: false })).toBe(
      'probable_contradiction',
    );
  });

  it('mid score = possible_related regardless of text equality — insufficient confidence to assert a specific relationship', () => {
    expect(classifyMemoryConflictMatch({ score: 0.8, textsEqual: true })).toBe('possible_related');
    expect(classifyMemoryConflictMatch({ score: 0.8, textsEqual: false })).toBe('possible_related');
  });

  it('low score = unrelated', () => {
    expect(classifyMemoryConflictMatch({ score: 0.3, textsEqual: false })).toBe('unrelated');
  });

  it('never returns a MORE confident relationship than the score justifies — exact threshold boundaries', () => {
    const { CONTRADICTION_MIN, REVIEW_MIN } = MEMORY_CONFLICT_SIMILARITY_THRESHOLDS;
    expect(classifyMemoryConflictMatch({ score: CONTRADICTION_MIN, textsEqual: false })).toBe(
      'probable_contradiction',
    );
    expect(
      classifyMemoryConflictMatch({ score: CONTRADICTION_MIN - 0.001, textsEqual: false }),
    ).toBe('possible_related');
    expect(classifyMemoryConflictMatch({ score: REVIEW_MIN, textsEqual: false })).toBe(
      'possible_related',
    );
    expect(classifyMemoryConflictMatch({ score: REVIEW_MIN - 0.001, textsEqual: false })).toBe(
      'unrelated',
    );
  });
});

describe('normalizeFactText', () => {
  it('collapses whitespace and case so "Weekly updates" and "weekly   updates" compare equal', () => {
    expect(normalizeFactText('Weekly updates')).toBe(normalizeFactText('weekly   updates'));
  });

  it('does NOT consider "monthly" and "weekly" equal — the core example must classify as a real difference', () => {
    expect(normalizeFactText('Client wants monthly congressional updates')).not.toBe(
      normalizeFactText('Client wants weekly congressional updates'),
    );
  });
});

describe('describeMemoryConflictMatch', () => {
  it('every message fits the 240-char reason cap', () => {
    for (const kind of MEMORY_CONFLICT_MATCH_KINDS) {
      const msg = describeMemoryConflictMatch(
        kind,
        'memory_items 11111111-1111-4111-8111-111111111111',
        0.934,
      );
      expect(msg.length).toBeLessThanOrEqual(240);
    }
  });

  it('a probable_contradiction message never claims the conflict was already resolved/applied', () => {
    const msg = describeMemoryConflictMatch('probable_contradiction', 'memory_items abc', 0.95);
    expect(msg).not.toMatch(/\b(resolved|superseded|overwritten|updated)\b/i);
    expect(msg).toMatch(/flagged/i);
  });
});
