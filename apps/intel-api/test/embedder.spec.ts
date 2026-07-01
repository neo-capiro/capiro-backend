import {
  EMBEDDING_MODEL,
  MAX_INPUT_CHARS,
  normalize,
  vectorLiteral,
} from '../src/embeddings/embedder.js';

/**
 * Phase 1 (plan §4 S3): query-side embedder helpers. No Bedrock call is made
 * here — `embedText` is exercised live by the `verify-sourcedata` task (S6).
 */
describe('embedder query-side helpers (Phase 1)', () => {
  it('vectorLiteral formats a bracketed CSV and preserves 1024 dims', () => {
    expect(vectorLiteral([1, 2, 3])).toBe('[1,2,3]');
    const v = new Array(1024).fill(0).map((_, i) => i / 1000);
    const lit = vectorLiteral(v);
    expect(lit.startsWith('[')).toBe(true);
    expect(lit.endsWith(']')).toBe(true);
    expect(lit.slice(1, -1).split(',')).toHaveLength(1024);
  });

  it('normalize collapses all whitespace runs and trims', () => {
    expect(normalize('  a\n\n  b\t c  ')).toBe('a b c');
  });

  it('normalize caps input at MAX_INPUT_CHARS', () => {
    const long = 'x'.repeat(MAX_INPUT_CHARS + 500);
    expect(normalize(long)).toHaveLength(MAX_INPUT_CHARS);
  });

  it('EMBEDDING_MODEL defaults to Titan Text Embeddings v2', () => {
    expect(EMBEDDING_MODEL).toContain('titan-embed-text-v2');
  });
});
