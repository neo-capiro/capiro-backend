/**
 * Institutional Memory governance contract (Phase 3).
 *
 * This module is pure and dependency-free so API, orchestrator, workspace,
 * strategy, Steward, UI fixtures, migrations and diagnostics share one set of
 * controlled vocabularies and ordering rules. It never contains memory bodies.
 */

export const MEMORY_CLASSES = [
  'institutional_authoritative',
  'client_steering',
  'user_preference',
  'episodic_working',
  // Transitional value for conservative migration. It is never eligible to
  // outrank or impersonate one of the governed classes.
  'legacy_unclassified',
] as const;
export type MemoryClass = (typeof MEMORY_CLASSES)[number];

export const MEMORY_AUTHORITIES = [
  'firm_approved',
  'client_approved',
  'external_authoritative',
  'user_asserted',
  'analyst_verified',
  'working_draft',
  'model_inferred',
  'legacy_unclassified',
] as const;
export type MemoryAuthority = (typeof MEMORY_AUTHORITIES)[number];

export const GOVERNED_MEMORY_STATUSES = [
  'suggested',
  'pending_review',
  'active',
  'stale',
  'conflicted',
  'superseded',
  'revoked',
  'rejected',
  'expired',
] as const;
export type GovernedMemoryStatus = (typeof GOVERNED_MEMORY_STATUSES)[number];

export const MEMORY_CONFLICT_STATUSES = ['none', 'open', 'resolved', 'controlling'] as const;
export type MemoryConflictStatus = (typeof MEMORY_CONFLICT_STATUSES)[number];

export const MEMORY_SCOPES = ['firm', 'client', 'user_private'] as const;
export type GovernedMemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_SENSITIVITIES = ['normal', 'confidential', 'restricted'] as const;
export type MemorySensitivity = (typeof MEMORY_SENSITIVITIES)[number];

export const MEMORY_SOURCE_TYPES = [
  'user_message',
  'approved_document_edit',
  'steward_extraction',
  'crm_record',
  'confirmed_meeting_outcome',
  'firm_playbook',
  'client_record',
  'external_primary_source',
  'legacy_projection',
  'unknown',
] as const;
export type GovernedMemorySourceType = (typeof MEMORY_SOURCE_TYPES)[number];

export const MEMORY_TRANSITION_REASONS = [
  'submitted_for_review',
  'approved',
  'rejected',
  'confirmed',
  'review_overdue',
  'corrected',
  'superseded',
  'revoked',
  'conflict_detected',
  'conflict_resolved',
  'ttl_expired',
  'backfill_classified',
  'backfill_quarantined',
  'legal_hold_blocked',
] as const;
export type MemoryTransitionReasonCode = (typeof MEMORY_TRANSITION_REASONS)[number];

export interface GovernedMemorySource {
  sourceType: GovernedMemorySourceType;
  sourceId?: string | null;
  sourceRef?: string | null;
  /** Direct excerpts are capped at the API boundary. Never log this value. */
  sourceExcerpt?: string | null;
  sourceContentHash?: string | null;
  sourceVersion?: string | null;
}

export interface GovernedMemoryApproval {
  assertedByUserId?: string | null;
  approvedByUserId?: string | null;
  approvedAt?: string | Date | null;
  secondApprovedByUserId?: string | null;
  secondApprovedAt?: string | Date | null;
}

export interface GovernedMemoryTemporal {
  asOf?: string | Date | null;
  effectiveFrom?: string | Date | null;
  validUntil?: string | Date | null;
  lastConfirmedAt?: string | Date | null;
  reviewCadenceDays?: number | null;
  reviewDueAt?: string | Date | null;
  expiresAt?: string | Date | null;
}

export interface GovernedMemoryOrigin {
  originSurface?: string | null;
  originTraceId?: string | null;
  originContextPacketId?: string | null;
  originModel?: string | null;
  originPromptVersion?: string | null;
}

export interface GovernedMemoryRecord
  extends GovernedMemorySource,
    GovernedMemoryApproval,
    GovernedMemoryTemporal,
    GovernedMemoryOrigin {
  id: string;
  tenantId: string;
  clientId?: string | null;
  ownerUserId?: string | null;
  memoryClass: MemoryClass;
  authority: MemoryAuthority;
  scope: GovernedMemoryScope;
  status: GovernedMemoryStatus;
  conflictStatus?: MemoryConflictStatus | null;
  conflictGroupId?: string | null;
  controllingItemId?: string | null;
  sensitivity?: MemorySensitivity | null;
  confidence?: number | null;
  instructionsAllowed?: boolean;
  explicitSelection?: boolean;
  legalHold?: boolean;
}

export interface MemoryClassPolicy {
  requiredScope: GovernedMemoryScope;
  requiresHumanApproval: boolean;
  requiresSource: boolean;
  requiresTtl: boolean;
  canInstructModel: boolean;
  externalDeliverableUse: 'allowed' | 'requires_corroboration' | 'forbidden';
}

export const MEMORY_CLASS_POLICIES: Readonly<Record<MemoryClass, MemoryClassPolicy>> = {
  institutional_authoritative: {
    requiredScope: 'firm',
    requiresHumanApproval: true,
    requiresSource: true,
    requiresTtl: false,
    canInstructModel: true,
    externalDeliverableUse: 'allowed',
  },
  client_steering: {
    requiredScope: 'client',
    requiresHumanApproval: true,
    requiresSource: true,
    requiresTtl: false,
    canInstructModel: false,
    externalDeliverableUse: 'allowed',
  },
  user_preference: {
    requiredScope: 'user_private',
    requiresHumanApproval: false,
    requiresSource: true,
    requiresTtl: false,
    canInstructModel: false,
    externalDeliverableUse: 'allowed',
  },
  episodic_working: {
    requiredScope: 'user_private',
    requiresHumanApproval: false,
    requiresSource: true,
    requiresTtl: true,
    canInstructModel: false,
    externalDeliverableUse: 'requires_corroboration',
  },
  legacy_unclassified: {
    requiredScope: 'user_private',
    requiresHumanApproval: true,
    requiresSource: true,
    requiresTtl: false,
    canInstructModel: false,
    externalDeliverableUse: 'forbidden',
  },
};

const TRANSITIONS: Readonly<Record<GovernedMemoryStatus, readonly GovernedMemoryStatus[]>> = {
  suggested: ['pending_review', 'rejected'],
  pending_review: ['active', 'rejected'],
  active: ['stale', 'superseded', 'revoked', 'conflicted', 'expired'],
  stale: ['active', 'superseded', 'revoked', 'conflicted', 'expired'],
  conflicted: ['active', 'superseded', 'revoked'],
  superseded: [],
  revoked: [],
  rejected: [],
  expired: ['pending_review'],
};

export interface MemoryTransitionDecision {
  allowed: boolean;
  from: GovernedMemoryStatus;
  to: GovernedMemoryStatus;
  reason?: string;
}

export function evaluateMemoryTransition(
  from: GovernedMemoryStatus,
  to: GovernedMemoryStatus,
): MemoryTransitionDecision {
  const allowed = TRANSITIONS[from].includes(to);
  return {
    allowed,
    from,
    to,
    ...(allowed ? {} : { reason: `Invalid memory transition: ${from} -> ${to}` }),
  };
}

export class InvalidMemoryTransitionError extends Error {
  constructor(
    readonly from: GovernedMemoryStatus,
    readonly to: GovernedMemoryStatus,
  ) {
    super(`Invalid memory transition: ${from} -> ${to}`);
    this.name = 'InvalidMemoryTransitionError';
  }
}

export function assertMemoryTransition(
  from: GovernedMemoryStatus,
  to: GovernedMemoryStatus,
): void {
  if (!evaluateMemoryTransition(from, to).allowed) {
    throw new InvalidMemoryTransitionError(from, to);
  }
}

export function classRequiresApproval(memoryClass: MemoryClass): boolean {
  return MEMORY_CLASS_POLICIES[memoryClass].requiresHumanApproval;
}

export function hasHumanApproval(record: Pick<GovernedMemoryRecord, 'approvedByUserId' | 'approvedAt'>): boolean {
  return Boolean(record.approvedByUserId && record.approvedAt);
}

export function fourEyesSatisfied(
  record: Pick<
    GovernedMemoryRecord,
    'assertedByUserId' | 'approvedByUserId' | 'secondApprovedByUserId' | 'secondApprovedAt'
  >,
  enabled: boolean,
): boolean {
  if (!enabled) return Boolean(record.approvedByUserId);
  return Boolean(
    record.approvedByUserId &&
      record.secondApprovedByUserId &&
      record.secondApprovedAt &&
      record.approvedByUserId !== record.secondApprovedByUserId &&
      record.assertedByUserId !== record.secondApprovedByUserId,
  );
}

export type MemorySuppressionReason =
  | 'wrong_tenant'
  | 'wrong_user'
  | 'wrong_client'
  | 'ethical_wall'
  | 'inactive_status'
  | 'invalid_until'
  | 'unapproved'
  | 'sensitivity_denied'
  | 'conflict_unresolved'
  | 'ttl_required'
  | 'source_missing'
  | 'legacy_unclassified';

export interface MemoryRecallAccess {
  tenantId: string;
  userId: string;
  clientId?: string | null;
  ethicalWallAllowed?: boolean;
  allowedSensitivities?: readonly MemorySensitivity[];
  fourEyesEnabled?: boolean;
  now?: Date;
}

export type MemoryFilterDecision =
  | { include: true }
  | { include: false; reason: MemorySuppressionReason };

export function filterGovernedMemory(
  record: GovernedMemoryRecord,
  access: MemoryRecallAccess,
): MemoryFilterDecision {
  const now = access.now ?? new Date();
  if (record.tenantId !== access.tenantId) return { include: false, reason: 'wrong_tenant' };
  if (record.scope === 'user_private' && record.ownerUserId !== access.userId) {
    return { include: false, reason: 'wrong_user' };
  }
  if (record.scope === 'client') {
    if (!access.clientId || record.clientId !== access.clientId) {
      return { include: false, reason: 'wrong_client' };
    }
    if (access.ethicalWallAllowed === false) return { include: false, reason: 'ethical_wall' };
  }
  if (!['active', 'stale'].includes(record.status)) {
    return { include: false, reason: 'inactive_status' };
  }
  if (record.validUntil && dateMs(record.validUntil) <= now.getTime()) {
    return { include: false, reason: 'invalid_until' };
  }
  if (record.expiresAt && dateMs(record.expiresAt) <= now.getTime()) {
    return { include: false, reason: 'inactive_status' };
  }
  const policy = MEMORY_CLASS_POLICIES[record.memoryClass];
  if (policy.requiresTtl && !record.expiresAt && !record.validUntil) {
    return { include: false, reason: 'ttl_required' };
  }
  if (policy.requiresSource && record.sourceType === 'unknown' && !record.sourceRef && !record.sourceId) {
    return { include: false, reason: 'source_missing' };
  }
  if (record.memoryClass === 'legacy_unclassified') {
    return { include: false, reason: 'legacy_unclassified' };
  }
  if (policy.requiresHumanApproval && !fourEyesSatisfied(record, access.fourEyesEnabled ?? false)) {
    return { include: false, reason: 'unapproved' };
  }
  if (
    record.conflictStatus === 'open' &&
    (!record.controllingItemId || record.controllingItemId !== record.id)
  ) {
    return { include: false, reason: 'conflict_unresolved' };
  }
  const allowed = new Set(access.allowedSensitivities ?? ['normal']);
  if (!allowed.has(record.sensitivity ?? 'normal')) {
    return { include: false, reason: 'sensitivity_denied' };
  }
  return { include: true };
}

export interface RecallScoreWeights {
  semantic: number;
  freshness: number;
  confirmation: number;
  confidence: number;
}

export interface RecallScoreInput {
  record: GovernedMemoryRecord;
  semanticSimilarity?: number | null;
  now?: Date;
  weights?: Partial<RecallScoreWeights>;
}

export interface RecallScoreExplanation {
  total: number;
  priorityBand: number;
  scopeMatch: number;
  classPriority: number;
  authorityPriority: number;
  approval: number;
  freshness: number;
  confirmation: number;
  semantic: number;
  confidence: number;
  conflictPenalty: number;
  reason: string;
}

const DEFAULT_RECALL_WEIGHTS: RecallScoreWeights = {
  semantic: 0.45,
  freshness: 0.2,
  confirmation: 0.2,
  confidence: 0.15,
};

const CLASS_PRIORITY: Readonly<Record<MemoryClass, number>> = {
  institutional_authoritative: 5,
  client_steering: 5,
  user_preference: 3,
  episodic_working: 1,
  legacy_unclassified: 0,
};

const AUTHORITY_PRIORITY: Readonly<Record<MemoryAuthority, number>> = {
  client_approved: 7,
  firm_approved: 7,
  external_authoritative: 6,
  analyst_verified: 5,
  user_asserted: 4,
  working_draft: 2,
  model_inferred: 1,
  legacy_unclassified: 0,
};

/**
 * Authority/scope produce a lexicographic priority band. Similarity and recency
 * only order rows inside that band, so a newer model inference can never outrank
 * approved client steering or firm doctrine merely by being semantically close.
 */
export function scoreGovernedMemory(input: RecallScoreInput): RecallScoreExplanation {
  const { record } = input;
  const now = input.now ?? new Date();
  const weights = normalizeScoreWeights(input.weights);
  const scopeMatch = record.explicitSelection
    ? 6
    : record.scope === 'client'
      ? 5
      : record.scope === 'user_private'
        ? 4
        : 3;
  const classPriority = CLASS_PRIORITY[record.memoryClass];
  const authorityPriority = AUTHORITY_PRIORITY[record.authority];
  const approval = hasHumanApproval(record) ? 1 : 0;
  const priorityBand =
    (record.explicitSelection ? 1_000_000 : 0) +
    classPriority * 100_000 +
    authorityPriority * 10_000 +
    scopeMatch * 1_000 +
    approval * 100;

  const semantic = clamp01(input.semanticSimilarity ?? 0);
  const freshest = newestDate(
    record.lastConfirmedAt,
    record.asOf,
    record.effectiveFrom,
  );
  const ageDays = freshest ? Math.max(0, (now.getTime() - freshest) / 86_400_000) : 365;
  const freshness = Math.pow(2, -ageDays / 180);
  const confirmation = record.lastConfirmedAt ? Math.pow(2, -ageDays / 365) : 0.5;
  const confidence = record.confidence == null ? 0.5 : clamp01(record.confidence);
  const conflictPenalty = record.conflictStatus === 'open' ? 1 : 0;
  const withinBand =
    semantic * weights.semantic +
    freshness * weights.freshness +
    confirmation * weights.confirmation +
    confidence * weights.confidence -
    conflictPenalty;
  const total = priorityBand + withinBand;
  return {
    total,
    priorityBand,
    scopeMatch,
    classPriority,
    authorityPriority,
    approval,
    freshness,
    confirmation,
    semantic,
    confidence,
    conflictPenalty,
    reason: recallReason(record),
  };
}

export function compareGovernedRecall(
  left: RecallScoreExplanation,
  right: RecallScoreExplanation,
): number {
  return right.total - left.total;
}

function recallReason(record: GovernedMemoryRecord): string {
  if (record.explicitSelection) return 'Explicitly selected by the user for this output.';
  if (record.memoryClass === 'client_steering') {
    return 'Approved client steering matched the active client scope.';
  }
  if (record.memoryClass === 'institutional_authoritative') {
    return 'Approved firm doctrine applies to this firm-scoped output.';
  }
  if (record.memoryClass === 'user_preference') {
    return 'The owner’s confirmed preference applies to this user.';
  }
  return 'A source-backed working memory matched the current task and remains valid.';
}

export interface LegacyMemoryShape {
  type?: string | null;
  visibility?: string | null;
  scope?: string | null;
  ownerUserId?: string | null;
  clientId?: string | null;
  provenance?: string | null;
  source?: string | null;
  slug?: string | null;
  expiresAt?: string | Date | null;
  legalHold?: boolean | null;
}

export interface LegacyClassification {
  memoryClass: MemoryClass;
  authority: MemoryAuthority;
  status: GovernedMemoryStatus;
  confidence: 'deterministic' | 'ambiguous';
  reason: string;
}

/** Conservative, idempotent migration classifier. It never invents approval. */
export function classifyLegacyMemory(row: LegacyMemoryShape): LegacyClassification {
  if (['firm-soul', 'firm-compass', 'playbook'].includes(row.type ?? '')) {
    return {
      memoryClass: 'institutional_authoritative',
      authority: row.provenance === 'human' ? 'user_asserted' : 'legacy_unclassified',
      status: 'pending_review',
      confidence: 'deterministic',
      reason: 'Firm steering type mapped without inventing firm approval.',
    };
  }
  if (['client-soul', 'client-compass', 'client-people'].includes(row.type ?? '') && row.clientId) {
    return {
      memoryClass: 'client_steering',
      authority: row.provenance === 'human' ? 'user_asserted' : 'legacy_unclassified',
      status: 'pending_review',
      confidence: 'deterministic',
      reason: 'Client steering type mapped while preserving approval uncertainty.',
    };
  }
  if (['user-voice', 'user-profile'].includes(row.type ?? '') || row.scope === 'user_private') {
    return {
      memoryClass: row.expiresAt ? 'episodic_working' : 'user_preference',
      authority: row.provenance === 'model' ? 'model_inferred' : 'user_asserted',
      status: row.provenance === 'model' ? 'pending_review' : 'active',
      confidence: 'deterministic',
      reason: 'Owner-scoped memory mapped to preference or expiring working context.',
    };
  }
  if ((row.slug ?? '').startsWith('clio:') && row.expiresAt && row.ownerUserId) {
    return {
      memoryClass: 'episodic_working',
      authority: row.provenance === 'model' ? 'model_inferred' : 'user_asserted',
      status: 'pending_review',
      confidence: 'deterministic',
      reason: 'Expiring private Clio projection quarantined as working memory.',
    };
  }
  return {
    memoryClass: 'legacy_unclassified',
    authority: 'legacy_unclassified',
    status: 'pending_review',
    confidence: 'ambiguous',
    reason: 'No safe class inference; quarantine for human review.',
  };
}

export function sourceCanAnchorCandidate(sourceType: GovernedMemorySourceType): boolean {
  return [
    'user_message',
    'approved_document_edit',
    'steward_extraction',
    'crm_record',
    'confirmed_meeting_outcome',
    'firm_playbook',
    'client_record',
    'external_primary_source',
  ].includes(sourceType);
}

export function instructionsAllowedFor(record: GovernedMemoryRecord): boolean {
  return Boolean(
    record.instructionsAllowed &&
      record.memoryClass === 'institutional_authoritative' &&
      record.authority === 'firm_approved' &&
      hasHumanApproval(record),
  );
}

function normalizeScoreWeights(input?: Partial<RecallScoreWeights>): RecallScoreWeights {
  const raw = {
    semantic: finiteNonNegative(input?.semantic, DEFAULT_RECALL_WEIGHTS.semantic),
    freshness: finiteNonNegative(input?.freshness, DEFAULT_RECALL_WEIGHTS.freshness),
    confirmation: finiteNonNegative(input?.confirmation, DEFAULT_RECALL_WEIGHTS.confirmation),
    confidence: finiteNonNegative(input?.confidence, DEFAULT_RECALL_WEIGHTS.confidence),
  };
  const total = raw.semantic + raw.freshness + raw.confirmation + raw.confidence;
  if (!(total > 0)) return { ...DEFAULT_RECALL_WEIGHTS };
  return {
    semantic: raw.semantic / total,
    freshness: raw.freshness / total,
    confirmation: raw.confirmation / total,
    confidence: raw.confidence / total,
  };
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function dateMs(value: string | Date): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function newestDate(...values: Array<string | Date | null | undefined>): number | null {
  const valid = values
    .filter((value): value is string | Date => Boolean(value))
    .map(dateMs)
    .filter(Number.isFinite);
  return valid.length ? Math.max(...valid) : null;
}
