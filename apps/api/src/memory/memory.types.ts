// Institutional Memory — shared types for the dual-representation memory layer.
//
// Memory exists in two synchronized representations with one canonical owner:
//   1. MEMORY STORE (canonical)  — structured rows + graph edges, what the AI queries.
//   2. MARKDOWN PROJECTION        — Obsidian-format markdown served by the API and
//      edited via the Settings "Memory" UI. This is a RENDERED projection of the
//      store, not a synced file vault: there is no bidirectional .md file drop.
//
// These types describe the canonical store item. The renderer projects an item
// to markdown; the parser reads human edits back into an item. See
// memory-render.helpers.ts and memory-parse.helpers.ts.
//
// Design rules enforced here:
//   - tenant_id is ALWAYS present (scoping key; never optional).
//   - Each note region has exactly ONE writer: generated blocks are owned by the
//     engine (sourced from the store), human sections are owned by the analyst.
//   - Facts live in Postgres entity rows; memory references them via entityId.

/** Note/item kind. Mirrors the frontmatter `type` enum in the plan (§2). */
export type MemoryItemType =
  | 'firm-soul'
  | 'firm-compass'
  | 'playbook'
  | 'client-hub'
  | 'client-soul'
  | 'client-compass'
  | 'client-people'
  | 'client-profile'
  | 'meeting'
  | 'debrief'
  | 'thread'
  | 'meri-session'
  | 'person'
  | 'bill'
  | 'issue'
  | 'user-profile'
  | 'user-voice'
  | 'note';

/** firm-shared vs private-to-owner. */
export type MemoryVisibility = 'tenant' | 'user';

/** Provenance of the item's authoritative content. */
export type MemoryProvenance = 'human' | `ingest@${string}`;

/** Source system an ingested item was generated from. */
export type MemorySource =
  | 'graph-email'
  | 'meri'
  | 'manual'
  | 'meeting-service'
  | 'ingest';

/**
 * A typed, named section of a memory item.
 *
 * `owner` is the load-bearing field for the merge model (§0.5 concern 2):
 *   - 'engine'  — content is rendered from the store; the renderer overwrites it
 *                 on every projection; humans must NOT hand-edit it.
 *   - 'human'   — content is authored by the analyst; the engine NEVER regenerates
 *                 it; the parser reads it back into the store.
 *
 * Single-writer-per-section is what removes the "marker drift" tar pit.
 */
export interface MemorySection {
  /** Stable key, e.g. 'summary', 'strategic-read', 'red-lines'. */
  key: string;
  /** Human-facing heading rendered as `## ...`. */
  heading: string;
  owner: 'engine' | 'human';
  /** Markdown body of the section (no heading line). */
  body: string;
}

/** The canonical memory store item (one row in `memory_items`). */
export interface MemoryItem {
  id: string;
  tenantId: string;
  /** Client scope when applicable (null for firm-level / unscoped). */
  clientId: string | null;
  /** Required when visibility === 'user'; the owning user. */
  ownerUserId: string | null;
  type: MemoryItemType;
  visibility: MemoryVisibility;
  /** FK to the authoritative Postgres entity row this item narrates. */
  entityId: string | null;
  /** Slug used for the vault path + wikilink target. */
  slug: string;
  title: string;
  aliases: string[];
  tags: string[];
  source: MemorySource;
  /** Upstream id (message/session/meeting) this was generated from. */
  sourceRef: string | null;
  provenance: MemoryProvenance;
  sections: MemorySection[];
  createdAt: string; // ISO-8601
  updatedAt: string; // ISO-8601
  schemaVersion: number;
}

/** A typed wikilink target, e.g. { type: 'bill', slug: 'hr-1234' }. */
export interface WikiLink {
  type: string;
  slug: string;
}

/** A directed graph edge derived from a wikilink (or a DB FK). */
export interface MemoryEdge {
  tenantId: string;
  /** memory_item id the link originates from. */
  srcItemId: string;
  /** typed link relation, here always 'mentions' for wikilinks. */
  relation: string;
  /** target entity type + slug. */
  dstType: string;
  dstSlug: string;
}

export const MEMORY_SCHEMA_VERSION = 1;
