import {
  CHARS_PER_TOKEN,
  charsToTokens,
  estimateTokens,
  tokensToChars,
  truncateToTokens,
} from './token-budget';

describe('token-budget estimator', () => {
  it('estimateTokens is 0 for empty and ceil(len/ratio) otherwise', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('x')).toBe(1);
    expect(estimateTokens('a'.repeat(38))).toBe(Math.ceil(38 / CHARS_PER_TOKEN));
  });

  it('chars<->tokens round-trip stays within one token (budget-safe, floored)', () => {
    for (const chars of [100, 9500, 19000]) {
      const t = charsToTokens(chars);
      expect(tokensToChars(t)).toBeLessThanOrEqual(chars);
      expect(chars - tokensToChars(t)).toBeLessThan(CHARS_PER_TOKEN + 1);
    }
  });

  it('a char->token budget flip is provably ~inert (token budget ≈ char budget)', () => {
    const tokenBudget = charsToTokens(19000);
    expect(tokensToChars(tokenBudget)).toBeGreaterThan(19000 - CHARS_PER_TOKEN * 2);
    expect(tokensToChars(tokenBudget)).toBeLessThanOrEqual(19000);
  });

  it('truncateToTokens cuts at the char-equivalent and is a no-op within budget', () => {
    const text = 'a'.repeat(1000);
    expect(truncateToTokens(text, 100000)).toBe(text);
    const cut = truncateToTokens(text, 10);
    expect(cut.length).toBe(tokensToChars(10));
    expect(estimateTokens(cut)).toBeLessThanOrEqual(10);
  });

  it('handles degenerate inputs without throwing', () => {
    expect(truncateToTokens('', 5)).toBe('');
    expect(truncateToTokens('abc', 0)).toBe('');
    expect(charsToTokens(-5)).toBe(0);
    expect(tokensToChars(NaN)).toBe(0);
  });
});
