/**
 * Pure, dependency-free helpers for Anthropic prompt caching on the MeriV2
 * orchestrator's raw-fetch client (request-scoped-llm.client.ts). Mirrors
 * apps/api's meri-prompt.helpers.ts P0-1 pattern so both Meri surfaces cache
 * the same way; ported here rather than imported because apps/api and
 * apps/meriv2-orchestrator are separate deployable apps that do not
 * cross-import each other's `src`.
 *
 * Anthropic caches the request prefix up to and including each
 * `cache_control: { type: 'ephemeral' }` breakpoint (render order: tools ->
 * system -> messages). We place breakpoints on (a) the last tool schema and
 * (b) the static system `base`, so repeated tool-loop rounds (same turn) and
 * repeated turns (same conversation) within the ~5-minute cache TTL reuse
 * that prefix instead of re-encoding it (response usage then reports
 * `cache_read_input_tokens > 0`). The per-turn/tenant `dynamic` system tail
 * (client focus, memory recall, roster, today's date, etc.) never carries a
 * breakpoint — it varies every call and must not pollute a long-lived cache
 * prefix with tenant-specific content.
 */

export interface EphemeralCacheControl {
  type: 'ephemeral';
}

export interface SystemTextBlock {
  type: 'text';
  text: string;
  cache_control?: EphemeralCacheControl;
}

/** The split system-prompt shape a prompt builder returns for the cached path. */
export interface SystemPromptParts {
  base: string;
  dynamic?: string;
}

const EPHEMERAL: EphemeralCacheControl = { type: 'ephemeral' };

/**
 * Build the `system` field as an array of content blocks. The static `base`
 * goes first and (when caching is enabled) carries the cache breakpoint; the
 * per-turn `dynamic` tail, if present, follows WITHOUT a breakpoint so it
 * never busts the cached prefix. When `dynamic` is empty/whitespace it is
 * omitted so the cached prefix is exactly `base`.
 */
export function buildSystemBlocks(opts: {
  base: string;
  dynamic?: string;
  cacheEnabled: boolean;
}): SystemTextBlock[] {
  const base: SystemTextBlock = { type: 'text', text: opts.base };
  if (opts.cacheEnabled && opts.base.length > 0) {
    base.cache_control = EPHEMERAL;
  }
  const blocks: SystemTextBlock[] = [base];
  if (opts.dynamic && opts.dynamic.trim().length > 0) {
    // Anthropic concatenates adjacent system text blocks with NO implicit
    // separator — without this leading newline, base's last character glues
    // directly onto dynamic's first (e.g. "...needs approval.Today's date").
    // Matches flattenSystemParts's `${base}\n${dynamic}` exactly, so the
    // block-array form and the flattened-string form always render the same.
    blocks.push({ type: 'text', text: `\n${opts.dynamic}` });
  }
  return blocks;
}

/**
 * Return a NEW tool array with a single cache breakpoint on the LAST tool, so
 * Anthropic caches the entire (static) tool block. Never mutates the input
 * array or its elements (every element is shallow-cloned). No-op shape when
 * caching is disabled or the list is empty.
 */
export function applyToolCacheControl<T extends object>(
  tools: T[],
  cacheEnabled: boolean,
): Array<T & { cache_control?: EphemeralCacheControl }> {
  const lastIndex = tools.length - 1;
  return tools.map((tool, index) => {
    if (cacheEnabled && index === lastIndex) {
      return { ...tool, cache_control: EPHEMERAL };
    }
    return { ...tool };
  });
}

/**
 * Flatten a split system (or pass a plain string through unchanged) into one
 * string — for callers that need a single string: the OpenAI adapter (no
 * Anthropic-style prompt caching) and one-off / not-reused synthesis prompts
 * where a cache breakpoint would never be read.
 */
export function flattenSystemParts(system: string | SystemPromptParts): string {
  if (typeof system === 'string') return system;
  return system.dynamic && system.dynamic.trim().length > 0
    ? `${system.base}\n${system.dynamic}`
    : system.base;
}

/**
 * Parse a boolean-ish config value the same way apps/api's config.schema.ts
 * parses CLIO_PROMPT_CACHE_ENABLED: false/0/no/off (case-insensitive, trimmed)
 * disable; anything else (including unset, which yields `defaultValue`)
 * enables.
 */
export function parseCacheEnabledFlag(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  return !['false', '0', 'no', 'off'].includes(raw.trim().toLowerCase());
}
