// Phase B — ClioMemory -> MemoryItem adapter (unification, pure functions).
//
// Decision A (unify): ClioMemory stays the source of truth for key/value
// memories; Meri keeps writing to it unchanged. This adapter PROJECTS a
// clio_memory row into a MemoryItem so existing + new memories appear in the
// knowledge graph, linked (via wikilinks) to the clients/bills/people they
// mention.
//
// Scope mapping: clio scope 'firm' -> visibility 'tenant'; 'user_private' ->
// visibility 'user' (owner = ownerUserId). Stable slug 'clio:<id>' guarantees
// idempotent upserts (re-running never duplicates).

import type { MemoryItem } from './memory.types.js';
import { MEMORY_SCHEMA_VERSION, defaultMemoryGovernanceFields } from './memory.types.js';

export interface ClioMemoryRow {
  id: string;
  tenantId: string;
  scope: string; // 'firm' | 'user_private' | 'client' (G2)
  ownerUserId: string | null;
  /** G2: set iff scope='client'. */
  clientId?: string | null;
  key: string;
  value: string;
  source: string;
  metadata: Record<string, unknown> | null;
  /** G2 ephemeral: carried onto the memory_items projection unchanged. */
  expiresAt?: string | Date | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Optional resolver: map an entity NAME mentioned in memory text to a typed
 * wikilink target (e.g. a client name -> client:<id>). The ingestion worker
 * supplies this from the tenant's client/person tables so memories connect to
 * real nodes. When omitted, no name-based links are added (slug-form
 * [[type:slug]] tokens already present in the text are still captured by the
 * store's own wikilink extractor on upsert).
 */
export type NameResolver = (name: string) => { type: string; slug: string } | null;

/** Build a deterministic, idempotent slug for a clio memory item. */
export function clioMemorySlug(id: string): string {
  return `clio:${id}`;
}

/**
 * Project a ClioMemory row into a MemoryItem. The value becomes a human-owned
 * 'memory' section (provenance stays human — it's user/firm-authored content,
 * not engine-generated). Any names the resolver recognizes are appended as a
 * "Related" line of typed wikilinks so the store derives graph edges on upsert.
 */
export function clioMemoryToItem(row: ClioMemoryRow, resolveName?: NameResolver): MemoryItem {
  const links: string[] = [];
  if (resolveName) {
    const seen = new Set<string>();
    for (const token of extractCandidateNames(row.value)) {
      const hit = resolveName(token);
      if (hit) {
        const key = `${hit.type}:${hit.slug}`;
        if (!seen.has(key)) {
          seen.add(key);
          links.push(`[[${hit.type}:${hit.slug}]]`);
        }
      }
    }
  }

  const body = links.length
    ? `${row.value.trim()}\n\nRelated: ${links.join(' ')}`
    : row.value.trim();

  return {
    id: '',
    tenantId: row.tenantId,
    // G2: client-scoped memories carry their client; firm/user rows stay null.
    clientId: row.scope === 'client' ? (row.clientId ?? null) : null,
    ownerUserId: row.scope === 'user_private' ? row.ownerUserId : null,
    type: 'note',
    // client scope projects as tenant-visible + client-keyed (a RELEVANCE
    // boundary — see the G2 plan; no per-user client ACL exists).
    visibility: row.scope === 'user_private' ? 'user' : 'tenant',
    entityId: null,
    slug: clioMemorySlug(row.id),
    title: row.key,
    aliases: [],
    tags: ['memory', row.source || 'conversation'],
    source: 'manual',
    sourceRef: row.id,
    provenance: 'human',
    sections: [{ key: 'memory', heading: 'Memory', owner: 'human', body }],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    ...defaultMemoryGovernanceFields(),
    // G2 ephemeral: the projection expires exactly when its source does.
    ...(row.expiresAt ? { expiresAt: new Date(row.expiresAt) } : {}),
    // Phase 4: carry auto-learn's extraction confidence (stored in
    // clio_memory.metadata_jsonb.confidence) onto the projected item so the
    // memory_items column mirrors the source. Absent/non-numeric ⇒ stays null
    // (neutral). This is the single link from metadata to the first-class column.
    ...(typeof row.metadata?.confidence === 'number' && Number.isFinite(row.metadata.confidence)
      ? { confidence: Math.min(1, Math.max(0, row.metadata.confidence as number)) }
      : {}),
  };
}

/**
 * Extract candidate entity names from free memory text: capitalized multi-word
 * spans (e.g. "Acme Corp", "Senator Jane Doe"). Intentionally conservative —
 * the resolver decides what actually matches a real entity. Pure + deterministic.
 */
export function extractCandidateNames(text: string): string[] {
  const matches = text.match(/\b([A-Z][a-zA-Z.&'-]+(?:\s+[A-Z][a-zA-Z.&'-]+){0,4})\b/g) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    const t = m.trim();
    if (t.length < 3) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}
