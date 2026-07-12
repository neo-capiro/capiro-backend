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
  scope: string; // 'firm' | 'user_private'
  ownerUserId: string | null;
  key: string;
  value: string;
  source: string;
  metadata: Record<string, unknown> | null;
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
  const isFirm = row.scope === 'firm';
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
    clientId: null, // clio memories are not hard-scoped to a client row
    ownerUserId: isFirm ? null : row.ownerUserId,
    type: 'note',
    visibility: isFirm ? 'tenant' : 'user',
    entityId: null,
    slug: clioMemorySlug(row.id),
    title: row.key,
    aliases: [],
    tags: ['memory', row.source || 'conversation'],
    source: 'manual',
    sourceRef: row.id,
    provenance: 'human',
    sections: [
      { key: 'memory', heading: 'Memory', owner: 'human', body },
    ],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    ...defaultMemoryGovernanceFields(),
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
