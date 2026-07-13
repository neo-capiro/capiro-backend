/**
 * Context Compiler v1 — the shared context CONTRACT (blueprint §4.6.4, G1).
 *
 * Every Meri surface requests its steering context (firm identity, user
 * voice, client steering, firm playbook) through this one contract instead of
 * hand-rolling its own memory_items loader. Five independent loader copies
 * drifted into three real production bugs (GA-chat voice RLS regression,
 * workspace steering loader dead-on-arrival via a Clerk-id ::uuid cast,
 * outreach clientContext silent-drop) — the compiler exists to make that
 * class of drift structurally impossible and to make WHAT reached a prompt,
 * and what was withheld and why, a first-class persisted record.
 *
 * This subpath is deliberately ZOD-FREE and dependency-free: apps/workspace
 * imports meriv2-core via deep subpaths precisely because the barrel pulls
 * zod (which its jest resolver cannot handle). Keep it that way.
 */

/** Surfaces that compile context. Mirrors meri_audit_ledger's surface values. */
export type ContextSurface =
  | 'chat' // legacy in-process chat (apps/api)
  | 'ga-chat' // MeriV2 orchestrator chat
  | 'outreach'
  | 'memo' // alert-memo
  | 'district-brief'
  | 'research'
  | 'workspace-gen';

/**
 * The steering layers v1 compiles. Layer membership is decided by the
 * memory_items `type` (see LAYER_BY_TYPE) — one canonical mapping, not five.
 */
export type SteeringLayer =
  | 'firm-identity' // firm-soul + firm-compass (slug='firm')
  | 'firm-playbook' // playbook (slug='firm') — alert-memo steering
  | 'user-voice' // user-voice + user-profile (owner-scoped, RLS 1C)
  | 'client-steering' // client-soul + client-compass (by client_id)
  | 'client-people'; // client-people (by client_id) — alert-memo only today

/** memory_items.type → layer. The single source of truth for classification. */
export const LAYER_BY_TYPE: Readonly<Record<string, SteeringLayer>> = {
  'firm-soul': 'firm-identity',
  'firm-compass': 'firm-identity',
  playbook: 'firm-playbook',
  'user-voice': 'user-voice',
  'user-profile': 'user-voice',
  'client-soul': 'client-steering',
  'client-compass': 'client-steering',
  'client-people': 'client-people',
};

/** layer → memory_items.type[] (adapters build their WHERE clauses from this
 *  so the type lists can never drift per-app again). */
export const TYPES_BY_LAYER: Readonly<Record<SteeringLayer, readonly string[]>> = {
  'firm-identity': ['firm-soul', 'firm-compass'],
  'firm-playbook': ['playbook'],
  'user-voice': ['user-voice', 'user-profile'],
  'client-steering': ['client-soul', 'client-compass'],
  'client-people': ['client-people'],
};

/** Flattened type list for a layer selection (dedup-preserving order). */
export function typesForLayers(layers: readonly SteeringLayer[]): string[] {
  const out: string[] = [];
  for (const layer of layers) {
    for (const t of TYPES_BY_LAYER[layer]) if (!out.includes(t)) out.push(t);
  }
  return out;
}

export interface ContextRequest {
  tenantId: string;
  /**
   * The CAPIRO users.id uuid (NOT a Clerk subject id — resolving Clerk→Capiro
   * is the adapter's job where needed). null = no user-scoped layers.
   */
  userId: string | null;
  clientId?: string | null;
  surface: ContextSurface;
  /** Which layers this surface wants. Order is preserved in the output. */
  layers: readonly SteeringLayer[];
  /**
   * Section rendering mode. 'human' (default): only human-owned sections,
   * "Heading: body" lines — the voice/steering discipline of chat, outreach
   * and workspace. 'all': every non-empty section body, no heading prefix —
   * alert-memo's historical full-file steering shape. Pick deliberately;
   * 'human' is the norm.
   */
  render?: 'human' | 'all';
  /**
   * Optional total char budget across all rendered bodies. Items that would
   * exceed it are dropped rear-first and recorded as 'over-budget'
   * exclusions — never silently truncated.
   */
  charBudget?: number;
  /** Surface-local reference for the trace (conversationId, draftId, …). */
  ref?: Record<string, string | null | undefined>;
}

/** One memory_items row as the adapter returns it. */
export interface SteeringRow {
  id: string;
  type: string;
  slug: string;
  /** memory_items.title — surfaces use it for display labels (e.g. legacy
   *  chat's `Client memory (<title>)` block header). */
  title: string | null;
  clientId: string | null;
  /** memory_items.status — 'active' | 'superseded' | 'revoked'. */
  status: string;
  /** sections_jsonb, unparsed. */
  sections: unknown;
}

/** An item that made it into the compiled packet. */
export interface ContextPacketItem {
  layer: SteeringLayer;
  /** memory_items identity so UIs can deep-link ("Context used" panel). */
  id: string;
  type: string;
  slug: string;
  chars: number;
  /** Human-readable inclusion rationale, stable per layer. */
  rationale: string;
}

export type ExclusionReason =
  | 'revoked'
  | 'superseded'
  | 'empty' // no human-owned section bodies rendered
  | 'over-budget'
  | 'unauthorized'; // reserved for G2 in-code scope checks

/** A row the compiler saw and deliberately withheld — the §6.2 exclusions view. */
export interface ContextExclusion {
  layer: SteeringLayer;
  id: string;
  type: string;
  slug: string;
  reason: ExclusionReason;
}

/** A rendered, included steering body (human-owned sections only). */
export interface RenderedSteeringItem {
  layer: SteeringLayer;
  id: string;
  type: string;
  slug: string;
  title: string | null;
  body: string;
}

export interface CompiledContextPacket {
  packetId: string;
  version: 1;
  surface: ContextSurface;
  tenantId: string;
  userId: string | null;
  clientId: string | null;
  ref: Record<string, string | null | undefined>;
  /** Included items, in layer-order then row-order. */
  items: ContextPacketItem[];
  exclusions: ContextExclusion[];
  /** The rendered bodies surfaces compose their prompt blocks from. */
  rendered: RenderedSteeringItem[];
  compiledAt: string;
}

/**
 * Each app implements this with ITS OWN tenancy discipline — the exact thing
 * that historically drifted, now pinned per-app by adapter contract tests:
 *  - apps/api: withTenantUser (both GUCs via PrismaService)
 *  - orchestrator: its PrismaService withTenant/withTenantUser
 *  - workspace: manual $transaction + dual set_config + clerk→users.id resolve
 *
 * The adapter query MUST NOT filter on status: the compiler needs to SEE
 * superseded/revoked rows to record them as exclusions. RLS still applies —
 * rows the caller cannot see at the DB boundary are simply absent (and that
 * is correct: an unauthorized row's existence is not for this caller to know).
 */
export interface ContextStoreAdapter {
  loadSteeringRows(req: ContextRequest): Promise<SteeringRow[]>;
  /**
   * Persist the packet trace (context_packet table). Implementations must be
   * fail-open: a trace-persistence failure must never break generation. The
   * compiler calls this fire-and-forget.
   */
  persistPacket?(packet: CompiledContextPacket): Promise<void>;
}
