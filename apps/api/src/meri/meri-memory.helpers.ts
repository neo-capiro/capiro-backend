/**
 * Pure helpers for the `save_memory` Meri tool — normalizing an explicit
 * "remember this" request into a ClioMemory row shape.
 *
 * Kept pure (no I/O) so it is unit-tested under the repo's `src/**.spec.ts`
 * matcher. The tool handler in meri-tools.service.ts owns the DB write + embed.
 *
 * The key scheme MUST match MeriService.userScopedMemoryKey so explicit and
 * auto-extracted memories share one namespace, and so the embedding UPDATE
 * (which matches on tenant_id + key only) targets exactly one row.
 */

export type MeriMemoryScope = 'firm' | 'user_private' | 'client';

export interface MeriMemoryRecord {
  scope: MeriMemoryScope;
  ownerUserId: string | null;
  /** G2: set iff scope='client'. */
  clientId?: string | null;
  /** Tenant-unique storage key (user-scoped keys are namespaced by userId;
   *  client-scoped keys by clientId). */
  key: string;
  value: string;
  source: string;
  /** G2 ephemeral: when set, the memory expires and is later purged. */
  expiresAt?: Date | null;
}

/** Mirror of MeriService.userScopedMemoryKey — keep the format identical. */
export function userScopedMemoryKey(userId: string, key: string): string {
  return `user:${userId}:${key}`;
}

/** Slugify a topic/key into a stable, bounded token. */
export function memoryKeySlug(raw: string): string {
  const slug = raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'note';
}

/** Client-scoped storage key — namespaced by clientId, mirroring the user scheme. */
export function clientScopedMemoryKey(clientId: string, key: string): string {
  return `client:${clientId}:${key}`;
}

/**
 * Build a normalized ClioMemory record from a `save_memory` request. Returns
 * null when there is no usable content. `scope` of "firm" stores firm-wide;
 * "client" stores against opts.clientId (falls back to user-private when no
 * client is in scope — never silently firm-wide); anything else (default)
 * stores as this user's private memory. G2: `ttlDays` makes the memory
 * EPHEMERAL — it expires (hidden from recall, later purged) instead of
 * becoming durable operating memory ("use once / working memory",
 * blueprint §3.5).
 */
export function buildSavedMemoryRecord(opts: {
  content: string;
  key?: string | null;
  scope?: string | null;
  userId: string;
  clientId?: string | null;
  ttlDays?: number | null;
}): MeriMemoryRecord | null {
  const value = (opts.content ?? '').trim();
  if (!value) return null;

  const requested = (opts.scope ?? '').trim().toLowerCase();
  const scope: MeriMemoryScope =
    requested === 'firm'
      ? 'firm'
      : requested === 'client' && opts.clientId
        ? 'client'
        : 'user_private';

  // Explicit key wins; otherwise derive a slug from the first words of content.
  const rawKey = opts.key && opts.key.trim() ? opts.key : value.split(/\s+/).slice(0, 8).join(' ');
  const baseKey = memoryKeySlug(rawKey);
  const key =
    scope === 'user_private'
      ? userScopedMemoryKey(opts.userId, baseKey)
      : scope === 'client'
        ? clientScopedMemoryKey(opts.clientId as string, baseKey)
        : baseKey;

  const ttlDays =
    typeof opts.ttlDays === 'number' && Number.isFinite(opts.ttlDays) && opts.ttlDays > 0
      ? Math.min(opts.ttlDays, 365)
      : null;

  return {
    scope,
    ownerUserId: scope === 'user_private' ? opts.userId : null,
    clientId: scope === 'client' ? (opts.clientId as string) : null,
    key,
    value: value.slice(0, 4000),
    source: 'user_requested',
    expiresAt: ttlDays ? new Date(Date.now() + ttlDays * 86_400_000) : null,
  };
}

/** Extract lowercase keyword tokens (>=5 chars) from a query for memory matching. */
export function extractMemoryKeywords(text: string): string[] {
  return Array.from(
    new Set(
      (text ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((word) => word.length >= 5),
    ),
  ).slice(0, 20);
}

export interface RankableMemory {
  key: string;
  value: string;
}

/**
 * Keyword-rank a set of memories against a query, used as the fallback when the
 * semantic (embedding) search is unavailable or returns nothing — so a stored
 * memory is NEVER silently invisible just because embeddings failed.
 *
 * Behaviour:
 *  - Score each memory by how many distinct query keywords appear in its
 *    `key + value`; higher overlap ranks first, ties broken by input order
 *    (callers pass memories already sorted newest-first).
 *  - If NOTHING matches (no keywords, or no overlap), fall back to the most
 *    recent `limit` memories rather than returning an empty list. Recent firm
 *    knowledge is better than nothing and matches user expectation that Meri
 *    "remembers".
 */
export function rankMemoriesByKeyword<T extends RankableMemory>(
  memories: T[],
  query: string,
  limit = 8,
): T[] {
  const words = extractMemoryKeywords(query);
  if (words.length === 0) return memories.slice(0, limit);

  const scored = memories
    .map((m, index) => {
      const haystack = `${m.key} ${m.value}`.toLowerCase();
      let score = 0;
      for (const w of words) if (haystack.includes(w)) score++;
      return { m, score, index };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((s) => s.m);

  if (scored.length > 0) return scored.slice(0, limit);
  // Nothing matched — never go fully blind; return the most recent memories.
  return memories.slice(0, limit);
}

/**
 * Reconstruct a clio memory's `value` from its memory_items projection sections
 * (Phase 1 SSOT projection recall). clioMemoryToItem stores the value in the
 * 'memory' section body, optionally suffixed with a "\n\nRelated: [[..]] .."
 * wikilink line (memory-clio-adapter.helpers.ts) — strip that graph suffix so
 * the recalled value matches the original clio_memory.value. Tolerant of a
 * missing/oddly-shaped sections array (returns '' rather than throwing).
 */
export function memorySectionValue(sections: unknown): string {
  if (!Array.isArray(sections)) return '';
  const mem = sections.find(
    (s): s is { key?: unknown; body?: unknown } =>
      !!s && typeof s === 'object' && (s as { key?: unknown }).key === 'memory',
  );
  const body = mem && typeof mem.body === 'string' ? mem.body : '';
  // Drop a trailing "\n\nRelated: …" line appended by the projection.
  return body.replace(/\n\nRelated:[^\n]*$/, '').trim();
}
