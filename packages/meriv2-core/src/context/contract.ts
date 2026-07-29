/**
 * Shared context contract.
 *
 * v1 remains available as a rollback contract. v2 adds governed-memory
 * provenance, authority-aware selection, packet health and budget evidence.
 * Mutable body text remains runtime-only in `rendered`; persisted packet items
 * contain hashes/metadata, not confidential content.
 */
import type {
  GovernedMemoryStatus,
  MemoryAuthority,
  MemoryClass,
  MemoryConflictStatus,
  MemorySensitivity,
} from '../memory/governance';

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

export type ContextContractVersion = 1 | 2;

export interface ContextRequest {
  tenantId: string;
  /** Effective tenant after any authorized impersonation. */
  effectiveTenantId?: string;
  /** Capiro users.id uuid, not a Clerk subject. */
  userId: string | null;
  /** Real actor when different from userId/effective scope. */
  actorUserId?: string | null;
  clientId?: string | null;
  surface: ContextSurface;
  layers: readonly SteeringLayer[];
  render?: 'human' | 'all';
  charBudget?: number;
  tokenBudget?: number;
  budgetUnit?: 'chars' | 'tokens';
  ref?: Record<string, string | null | undefined>;
  persistence?: 'required' | 'best-effort';
  /** Explicit contract choice; omitted preserves v1 behavior in core. */
  contractVersion?: ContextContractVersion;
  traceId?: string | null;
  promptVersion?: string | null;
  policyVersion?: string | null;
  compilerVersion?: string | null;
  /** Server-validated ids selected by the user in a Context Builder. */
  selectedItemIds?: readonly string[];
  /** Sensitivities the caller is authorized to include. */
  allowedSensitivities?: readonly MemorySensitivity[];
  /** Optional four-eyes policy for classes that require approval. */
  fourEyesEnabled?: boolean;
  /** Injectable clock for deterministic recall scoring in tests; defaults to real time. */
  now?: Date;
}

export interface SteeringRow {
  id: string;
  type: string;
  slug: string;
  title: string | null;
  clientId: string | null;
  ownerUserId?: string | null;
  visibility?: string | null;
  status: string;
  expiresAt?: string | Date | null;
  updatedAt?: string | Date | null;
  confirmedAt?: string | Date | null;
  authority?: string | null;
  sections: unknown;

  // Governed metadata populated by v2 adapters. All optional so v1 adapters can
  // continue operating and v2 can conservatively quarantine missing metadata.
  memoryClass?: MemoryClass | string | null;
  governedAuthority?: MemoryAuthority | string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  sourceRef?: string | null;
  sourceContentHash?: string | null;
  sourceVersion?: string | null;
  assertedByUserId?: string | null;
  approvedByUserId?: string | null;
  approvedAt?: string | Date | null;
  secondApprovedByUserId?: string | null;
  secondApprovedAt?: string | Date | null;
  asOf?: string | Date | null;
  effectiveFrom?: string | Date | null;
  validUntil?: string | Date | null;
  reviewDueAt?: string | Date | null;
  conflictStatus?: MemoryConflictStatus | string | null;
  conflictGroupId?: string | null;
  controllingItemId?: string | null;
  sensitivity?: MemorySensitivity | string | null;
  confidence?: number | null;
  instructionsAllowed?: boolean | null;
  reviewState?: string | null;
  originSurface?: string | null;
  originTraceId?: string | null;
  originContextPacketId?: string | null;
  originModel?: string | null;
  originPromptVersion?: string | null;
}

export interface ContextPacketItemV1 {
  layer: SteeringLayer;
  id: string;
  type: string;
  slug: string;
  chars: number;
  rationale: string;
  contentHash: string;
  omittedSections?: string[];
}
/** Backward-compatible v1 name. */
export type ContextPacketItem = ContextPacketItemV1;

export type ContextSelectionTier =
  | 'explicit'
  | 'authoritative_policy'
  | 'system_of_record'
  | 'human_confirmed'
  | 'source_backed_derived'
  | 'episodic_inferred';

export interface ContextPacketItemV2 {
  layer: SteeringLayer;
  id: string;
  type: string;
  slug: string;
  title: string | null;
  memoryClass: MemoryClass;
  scope: 'firm' | 'client' | 'user_private';
  clientId: string | null;
  ownerUserId: string | null;
  authority: MemoryAuthority;
  status: GovernedMemoryStatus;
  sourceType: string;
  sourceId: string | null;
  sourceRef: string | null;
  sourceContentHash: string | null;
  sourceVersion: string | null;
  asOf: string | null;
  effectiveFrom: string | null;
  validUntil: string | null;
  lastConfirmedAt: string | null;
  reviewDueAt: string | null;
  humanApproved: boolean;
  approvedByUserId: string | null;
  approvedAt: string | null;
  secondApprovedByUserId: string | null;
  secondApprovedAt: string | null;
  sensitivity: MemorySensitivity;
  instructionsAllowed: boolean;
  includedSections: string[];
  omittedSections: string[];
  inclusionScore: number;
  inclusionReason: string;
  selectionTier: ContextSelectionTier;
  contentHash: string;
  chars: number;
  tokens: number;
  confidence: number | null;
  conflictStatus: MemoryConflictStatus;
  conflictGroupId: string | null;
  controllingItemId: string | null;
  originSurface: string | null;
  originTraceId: string | null;
  originContextPacketId: string | null;
  originModel: string | null;
  originPromptVersion: string | null;
}

export type ExclusionReason =
  | 'revoked'
  | 'superseded'
  | 'rejected'
  | 'expired'
  | 'stale'
  | 'conflicted'
  | 'unapproved'
  | 'invalid-until'
  | 'source-missing'
  | 'legacy-unclassified'
  | 'sensitivity-denied'
  | 'wrong-client'
  | 'empty'
  | 'over-budget'
  | 'unauthorized'
  | 'unavailable';

export interface ContextExclusion {
  layer: SteeringLayer;
  /** Omitted for unauthorized rows so identity cannot be inferred. */
  id?: string;
  type?: string;
  slug?: string;
  reason: ExclusionReason;
  safeDetail?: string;
}

export interface RenderedSteeringItem {
  layer: SteeringLayer;
  id: string;
  type: string;
  slug: string;
  title: string | null;
  body: string;
  contentHash: string;
  instructionsAllowed?: boolean;
}

interface CompiledContextPacketBase {
  packetId: string;
  surface: ContextSurface;
  tenantId: string;
  effectiveTenantId: string;
  actorUserId: string | null;
  userId: string | null;
  clientId: string | null;
  ref: Record<string, string | null | undefined>;
  exclusions: ContextExclusion[];
  rendered: RenderedSteeringItem[];
  traceHash: string;
  persisted: boolean;
  compiledAt: string;
}

export interface CompiledContextPacketV1 extends CompiledContextPacketBase {
  version: 1;
  items: ContextPacketItemV1[];
}

export interface ContextPacketHealth {
  status: 'healthy' | 'degraded' | 'conflicted' | 'incomplete';
  missingRequiredLayers: SteeringLayer[];
  conflictCount: number;
  sourceFailureCount: number;
  reasons: string[];
}

export interface CompiledContextPacketV2 extends CompiledContextPacketBase {
  version: 2;
  traceId: string | null;
  promptVersion: string | null;
  policyVersion: string | null;
  compilerVersion: string;
  requiredLayers: SteeringLayer[];
  health: ContextPacketHealth;
  items: ContextPacketItemV2[];
  totalTokenBudget: number | null;
  usedTokens: number;
  truncated: boolean;
  incomplete: boolean;
}

export type CompiledContextPacket = CompiledContextPacketV1 | CompiledContextPacketV2;

export interface ContextStoreAdapter {
  loadSteeringRows(req: ContextRequest): Promise<SteeringRow[]>;
  /** Optional governed query. Core falls back to v1 rows and quarantines gaps. */
  loadGovernedSteeringRows?(req: ContextRequest): Promise<SteeringRow[]>;
  persistPacket?(packet: CompiledContextPacket): Promise<void>;
}
