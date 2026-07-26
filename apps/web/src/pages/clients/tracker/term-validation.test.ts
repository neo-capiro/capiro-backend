import { describe, expect, test } from 'vitest';
import { isAcceptableTerm, termRejectionReason, isShortExactTerm } from './term-validation.js';

/**
 * P0-05 — this web-side module must be byte-identical in behavior to
 * apps/intel-api/src/watchlist/term-validation.ts (see that file's
 * term-validation.spec.ts for the intel-api half of this table). If a change
 * to one side ever drifts from the other, the editor would accept a term the
 * server then silently rejects (or vice versa).
 */
describe('isAcceptableTerm — web/intel-api parity table', () => {
  test.each([
    ['AI', true],
    ['5G', true],
    ['VA', true],
    ['EU', true],
    ['UK', true],
    ['C2', true],
    ['C3', true],
    ['F-1', true],
    ['F-35', true],
    ['H.R. 1', true],
    ['0604256F', true],
    ['ai', false],
    ['of', false],
    ['to', false],
    ['an', false],
    ['a', false],
    ['', false],
    ['data center load', true],
  ])('isAcceptableTerm(%j) === %p', (input, expected) => {
    expect(isAcceptableTerm(input)).toBe(expected);
  });
});

describe('termRejectionReason', () => {
  test('empty term', () => {
    expect(termRejectionReason('')).toBe('Term cannot be empty.');
  });
  test('accepted term returns null', () => {
    expect(termRejectionReason('AI')).toBeNull();
  });
  test('rejected term names the shape rules', () => {
    expect(termRejectionReason('of')).toContain('too short');
  });
});

describe('isShortExactTerm', () => {
  test('short identifier-shaped terms require case-sensitive exact matching', () => {
    expect(isShortExactTerm('AI')).toBe(true);
    expect(isShortExactTerm('5G')).toBe(true);
    expect(isShortExactTerm('data')).toBe(false); // >= MIN_TERM_LEN, not "short"
    expect(isShortExactTerm('of')).toBe(false); // short but not identifier-shaped
  });
});
