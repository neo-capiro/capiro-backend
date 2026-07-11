/**
 * Extract token usage from a raw AI provider response. Both the OpenAI
 * responses API and the Anthropic messages API report
 * `usage.input_tokens` / `usage.output_tokens`, so one parser covers both.
 * Pure + total: any malformed payload yields zeros — metering must never
 * throw into a generation path.
 */
export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  /** Prompt-cache HIT tokens (billed at a discount). Anthropic
   *  `cache_read_input_tokens`; OpenAI `input_tokens_details.cached_tokens`. */
  cacheReadTokens?: number;
  /** Prompt-cache WRITE tokens (Anthropic `cache_creation_input_tokens`; not
   *  reported by OpenAI). Used by the W3.3 cache-hit-rate telemetry. */
  cacheCreationTokens?: number;
}

export function parseProviderUsage(raw: unknown): ProviderUsage {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { inputTokens: 0, outputTokens: 0 };
  }
  const usage = (raw as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    return { inputTokens: 0, outputTokens: 0 };
  }
  const u = usage as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
    input_tokens_details?: unknown;
  };
  // OpenAI Responses nests the cache hit under input_tokens_details.cached_tokens;
  // Anthropic reports cache_read_input_tokens at the top of usage.
  const openaiCached = toRecordish(u.input_tokens_details)?.cached_tokens;
  const cacheReadTokens =
    toTokenCount(u.cache_read_input_tokens) || toTokenCount(openaiCached) || 0;
  const cacheCreationTokens = toTokenCount(u.cache_creation_input_tokens);
  return {
    inputTokens: toTokenCount(u.input_tokens),
    outputTokens: toTokenCount(u.output_tokens),
    ...(cacheReadTokens ? { cacheReadTokens } : {}),
    ...(cacheCreationTokens ? { cacheCreationTokens } : {}),
  };
}

function toRecordish(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function toTokenCount(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}
