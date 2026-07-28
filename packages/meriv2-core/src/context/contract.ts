/**
 * Context Compiler v1 — shared, zod-free context contract.
 */

/** Surfaces that compile context. Mirrors persisted surface values. */
export type ContextSurface =
  | 'chat'
  | 'ga-chat'
  | 'tool-invoke'
  | 'in-editor'
  | 'strategy'
  | 'steward'
  | 'outreach'
  | 'memo'
  | 'district-brief'
  | 'research'
  | 'workspace-gen';

export type SteeringLayer =
  | 'firm-identity'
  | 'firm-playbook'
  | 'user-voice'
  | 'client-steering'
  | 'client-people';

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

export const TYPES_BY_LAYER: Readonly<Record<SteeringLayer, readonly string[]>> = {
  'firm-identity': ['firm-soul', 'firm-compass'],
  'firm-playbook': ['playbook'],
  'user-voice': ['user-voice', 'user-profile'],
  'client-steering': ['client-soul', 'client-compass'],
  'client-people': ['client-people'],
};

/**
 * Canonical rendering rank per steering type. Firm Soul precedes Firm Compass,
 * identity precedes steering, and client rows follow user rows — the order every
 * adapter's SQL `ORDER BY CASE type` already encodes and every prompt renders.
 *
 * The shared compiler sorts by THIS rank, not alphabetically: `type.localeCompare`
 * would put firm-compass ahead of firm-soul and client-compass ahead of
 * client-soul, silently inverting the prompt's institutional hierarchy while
 * still being "deterministic".
 */
export const TYPE_ORDER: Readonly<Record<string, number>> = {
  'firm-soul': 10,
  'firm-compass': 20,
  playbook: 30,
  'user-voice': 40,
  'user-profile': 50,
  'client-soul': 60,
  'client-compass': 70,
  'client-people': 80,
};

export function typeRank(type: string): number {
  return TYPE_ORDER[type] ?? 999;
}

export function typesForLayers(layers: readonly SteeringLayer[]): string[] {
  const out: string[] = [];
  for (const layer of layers) {
    for (const type of TYPES_BY_LAYER[layer]) if (!out.includes(type)) out.push(type);
  }
  return out;
}

export interface ContextRequest {
  tenantId: string;
  /** Capiro users.id uuid, not a Clerk subject. */
  userId: string | null;
  clientId?: string | null;
  surface: ContextSurface;
  layers: readonly SteeringLayer[];
  render?: 'human' | 'all';
  charBudget?: number;
  tokenBudget?: number;
  budgetUnit?: 'chars' | 'tokens';
  ref?: Record<string, string | null | undefined>;
  /**
   * required: packet persistence must succeed before compile resolves.
   * best-effort/default: persistence is awaited for ordering but failure is
   * swallowed; the returned packet marks the trace non-durable.
   */
  persistence?: 'required' | 'best-effort';
}

export interface SteeringRow {
  id: string;
  type: string;
  slug: string;
  title: string | null;
  clientId: string | null;
  status: string;
  expiresAt?: string | Date | null;
  /** Optional ordering/authority fields exposed by adapters when available. */
  updatedAt?: string | Date | null;
  confirmedAt?: string | Date | null;
  authority?: string | null;
  sections: unknown;
}

export interface ContextPacketItem {
  layer: SteeringLayer;
  id: string;
  type: string;
  slug: string;
  chars: number;
  rationale: string;
  /** Stable SHA-256 of the exact rendered body used by the prompt. */
  contentHash: string;
  /** Complete section labels omitted because the remaining budget was too small. */
  omittedSections?: string[];
}

export type ExclusionReason =
  | 'revoked'
  | 'superseded'
  | 'expired'
  | 'empty'
  | 'over-budget'
  | 'unauthorized';

export interface ContextExclusion {
  layer: SteeringLayer;
  id: string;
  type: string;
  slug: string;
  reason: ExclusionReason;
}

export interface RenderedSteeringItem {
  layer: SteeringLayer;
  id: string;
  type: string;
  slug: string;
  title: string | null;
  body: string;
  contentHash: string;
}

export interface CompiledContextPacket {
  packetId: string;
  version: 1;
  surface: ContextSurface;
  tenantId: string;
  userId: string | null;
  clientId: string | null;
  ref: Record<string, string | null | undefined>;
  items: ContextPacketItem[];
  exclusions: ContextExclusion[];
  rendered: RenderedSteeringItem[];
  /** Stable hash of surface/scope/included/excluded/rendered content (not id/time). */
  traceHash: string;
  /** True only when persistPacket completed successfully before return. */
  persisted: boolean;
  compiledAt: string;
}

export interface ContextStoreAdapter {
  loadSteeringRows(req: ContextRequest): Promise<SteeringRow[]>;
  persistPacket?(packet: CompiledContextPacket): Promise<void>;
}
