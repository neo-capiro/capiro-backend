import { editRatio, normalizeForDistance, wordEditDistance } from './text-distance.js';

describe('text-distance (G3 edit-distance instrumentation)', () => {
  it('normalizes HTML + whitespace + case so formatting churn is not "editing"', () => {
    expect(normalizeForDistance('<p>Hello&nbsp;<b>World</b></p>')).toEqual(['hello', 'world']);
    expect(normalizeForDistance('  Hello   WORLD ')).toEqual(['hello', 'world']);
  });

  it('word-level distance: identical → 0, disjoint → length', () => {
    expect(wordEditDistance('the quick brown fox', 'The  quick <i>brown</i> fox')).toBe(0);
    expect(wordEditDistance('alpha beta', 'gamma delta epsilon')).toBe(3);
    expect(wordEditDistance('', 'one two three')).toBe(3);
  });

  it('editRatio: 0 = sent verbatim, 1 = full rewrite, proportional in between', () => {
    expect(editRatio('a b c d', 'a b c d')).toBe(0);
    expect(editRatio('a b c d', 'w x y z')).toBe(1);
    // one word changed out of four
    expect(editRatio('a b c d', 'a b c e')).toBeCloseTo(0.25);
    // pure insertion registers against the larger length
    expect(editRatio('a b', 'a b c d')).toBeCloseTo(0.5);
    expect(editRatio('', '')).toBe(0);
  });
});
