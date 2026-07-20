/**
 * Phase 5 — canonical token estimator (zero-dependency, per this subpath's
 * no-dep rule). One source of truth so apps/api and the ContextCompiler budget
 * on the SAME unit instead of two independent char heuristics.
 *
 * There is no tokenizer in the repo (no tiktoken; @aws-sdk bedrock has no
 * count-tokens helper), so this is a deliberate ESTIMATE. CHARS_PER_TOKEN=3.8
 * is a conservative lower bound on chars-per-token for English + JSON (real
 * ratios run ~4.0-4.5), so estimateTokens OVER-estimates tokens slightly —
 * safe for a budget (you never blow the real limit). Swap in a real tokenizer
 * later behind this same seam without touching callers.
 */

/** Conservative chars-per-token ratio (over-estimates tokens ⇒ budget-safe). */
export const CHARS_PER_TOKEN = 3.8;

/** Estimated token count for a string (ceil so non-empty text is never 0 tokens). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Convert a token budget to an equivalent char budget (floor ⇒ budget-safe). */
export function tokensToChars(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return Math.floor(tokens * CHARS_PER_TOKEN);
}

/** Convert a char budget to an equivalent token budget (floor ⇒ budget-safe). */
export function charsToTokens(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.floor(chars / CHARS_PER_TOKEN);
}

/**
 * Truncate to an approximate token budget by cutting at the equivalent char
 * length. Returns the input unchanged when already within budget. Never throws.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (!text || !Number.isFinite(maxTokens) || maxTokens <= 0) return maxTokens <= 0 ? '' : text;
  const maxChars = tokensToChars(maxTokens);
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}
