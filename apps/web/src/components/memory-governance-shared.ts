/**
 * UI-free Memory Governance types + pure helpers — extracted from
 * MemoryGovernanceCenter.tsx (antd) so the vNext Settings module shares them
 * (extraction pattern, purge Phase 2). MemoryGovernanceCenter re-exports;
 * its public API is unchanged.
 */

export type GovernanceTabKey =
  | 'overview'
  | 'active'
  | 'pending'
  | 'conflicts'
  | 'review_due'
  | 'history'
  | 'grants'
  | 'transitions'
  | 'projection';

export type GovernanceItemAction =
  | 'confirm'
  | 'mark_stale'
  | 'revoke'
  | 'second_approve'
  | 'correction'
  | 'restore'
  | 'resolve_conflict';

export interface GovernanceOverview {
  enabled: boolean;
  reviewEnabled?: boolean;
  counts: {
    active: number;
    pendingReview: number;
    conflicts: number;
    reviewDue: number;
    history: number;
    activeGrants: number;
    projectionAttention: number;
  };
}

export interface GovernanceCapabilities {
  confirm: boolean;
  markStale: boolean;
  revoke: boolean;
  proposeCorrection: boolean;
  restore: boolean;
  resolveConflict: boolean;
  secondApprove: boolean;
}

export interface GovernanceItem {
  id: string;
  title: string;
  type: string;
  clientId: string | null;
  clientName: string | null;
  ownerUserId: string | null;
  visibility: string;
  memoryClass: string;
  memoryAuthority: string;
  memoryScope: string;
  governedStatus: string;
  legacyStatus: string;
  reviewState: string;
  confidence: number | null;
  lastConfirmedAt: string | null;
  reviewDueAt: string | null;
  validUntil: string | null;
  expiresAt: string | null;
  legalHold: boolean;
  conflictStatus: string;
  conflictGroupId: string | null;
  controllingItemId: string | null;
  assertedByUserId: string | null;
  approvedByUserId: string | null;
  approvedAt: string | null;
  secondApprovedByUserId: string | null;
  secondApprovedAt: string | null;
  sourceType: string;
  sourceId: string | null;
  originSurface: string | null;
  updatedAt: string;
  capabilities: GovernanceCapabilities;
}

export interface GovernanceConflictMember {
  id: string;
  title: string;
  governedStatus: string;
  conflictStatus: string;
  controllingItemId: string | null;
  updatedAt: string;
}

export interface GovernanceDetailResponse {
  enabled: boolean;
  item:
    | (GovernanceItem & {
        slug: string;
        sections: Array<{ key?: string; heading?: string; owner?: string; body?: string }>;
        sourceEvidence?: {
          status: 'available' | 'unavailable';
          explanation: string;
          findingId?: string;
          runId?: string;
          factText?: string;
          acceptedAt?: string | null;
          links?: Array<{ label: string; url: string }>;
        } | null;
        provenance: Record<string, unknown>;
        temporal: Record<string, unknown>;
        approvals: Record<string, unknown>;
        governance: Record<string, unknown>;
        origin: Record<string, unknown>;
        actors: Record<string, { name: string; email: string }>;
        versions: Array<Record<string, unknown> & { id: string; createdAt: string }>;
        transitions: Array<Record<string, unknown> & { id: string; occurredAt: string }>;
        projection: Array<Record<string, unknown> & { id: string; createdAt: string }>;
        conflictMembers: GovernanceConflictMember[];
        createdAt: string;
      })
    | null;
}

export interface GovernanceTransition {
  id: string;
  memoryItemId: string | null;
  memoryCandidateId: string | null;
  actorUserId: string | null;
  clientId: string | null;
  fromStatus: string | null;
  toStatus: string;
  reasonCode: string;
  reason: string;
  occurredAt: string;
}

export interface ProjectionFailure {
  id: string;
  memoryItemId: string | null;
  title: string | null;
  operation: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

export interface ProjectionHealth {
  enabled: boolean;
  counts: {
    pending: number;
    running: number;
    failed: number;
    completed: number;
    deadLetter: number;
    superseded: number;
  };
  oldestDueAt: string | null;
  recentFailures: ProjectionFailure[];
}

export interface GovernanceClient {
  id: string;
  name: string;
  status: string;
  memoryWall: boolean;
}

export interface MemoryGrant {
  id: string;
  clientId: string | null;
  userId: string;
  permissions: string[];
  status: string;
  grantedByUserId: string | null;
  reason: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GovernanceActionValues {
  reason?: string;
  content?: string;
  controllingItemId?: string;
}

export function governanceBucketForTab(
  tab: GovernanceTabKey,
): 'active' | 'review_due' | 'conflicts' | 'history' | null {
  if (tab === 'active') return 'active';
  if (tab === 'review_due') return 'review_due';
  if (tab === 'conflicts') return 'conflicts';
  if (tab === 'history') return 'history';
  return null;
}

export function governanceStatusLabel(value: string | null | undefined): string {
  const labels: Record<string, string> = {
    active: 'Active',
    stale: 'Review due',
    conflicted: 'Conflicted',
    superseded: 'Superseded',
    revoked: 'Revoked',
    rejected: 'Rejected',
    expired: 'Expired',
    pending_review: 'Pending review',
    suggested: 'Suggested',
    completed: 'Completed',
    failed: 'Failed',
    dead_letter: 'Dead letter',
    running: 'Running',
    pending: 'Pending',
  };
  return labels[String(value ?? '')] ?? 'Unknown';
}

export function governanceAuthorityLabel(value: string | null | undefined): string {
  const labels: Record<string, string> = {
    firm_approved: 'Firm approved',
    client_approved: 'Client approved',
    external_authoritative: 'External authoritative',
    user_asserted: 'User asserted',
    analyst_verified: 'Analyst verified',
    working_draft: 'Working draft',
    model_inferred: 'Model inferred',
    legacy_unclassified: 'Unclassified',
  };
  return labels[String(value ?? '')] ?? 'Unknown';
}

export function isGovernanceActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' ' || key === 'Spacebar';
}

export function buildGovernanceActionRequest(
  action: GovernanceItemAction,
  itemId: string,
  values: GovernanceActionValues = {},
): { method: 'post'; path: string; body: Record<string, unknown> } {
  if (action === 'confirm') {
    return { method: 'post', path: `/api/memory/governance/items/${itemId}/confirm`, body: {} };
  }
  if (action === 'mark_stale') {
    return {
      method: 'post',
      path: `/api/memory/governance/items/${itemId}/mark-stale`,
      body: { reason: values.reason?.trim() ?? '' },
    };
  }
  if (action === 'revoke') {
    return {
      method: 'post',
      path: `/api/memory/governance/items/${itemId}/revoke`,
      body: { reason: values.reason?.trim() ?? '' },
    };
  }
  if (action === 'second_approve') {
    return {
      method: 'post',
      path: `/api/memory/governance/items/${itemId}/second-approve`,
      body: {},
    };
  }
  if (action === 'correction') {
    return {
      method: 'post',
      path: `/api/memory/items/${itemId}/corrections`,
      body: { content: values.content?.trim() ?? '' },
    };
  }
  if (action === 'restore') {
    return { method: 'post', path: `/api/memory/items/${itemId}/restores`, body: {} };
  }
  return {
    method: 'post',
    path: `/api/memory/items/${itemId}/conflicts/resolve`,
    body: {
      controllingItemId: values.controllingItemId ?? '',
      reason: values.reason?.trim() ?? '',
    },
  };
}

export function shouldRenderMemoryGovernanceCenter(
  isAdmin: boolean,
  overview: GovernanceOverview | undefined,
): boolean {
  return isAdmin && overview?.enabled === true;
}

export function governanceActionTitle(kind: GovernanceItemAction): string {
  const labels: Record<GovernanceItemAction, string> = {
    confirm: 'Confirm memory',
    mark_stale: 'Mark memory stale',
    revoke: 'Revoke memory',
    second_approve: 'Record second approval',
    correction: 'Suggest a correction',
    restore: 'Restore as a new version',
    resolve_conflict: 'Resolve memory conflict',
  };
  return labels[kind];
}

export function governanceActionOutcomeMessage(
  kind: GovernanceItemAction,
  result: Record<string, unknown>,
): string {
  const outcome = String(result.outcome ?? 'completed');
  if (outcome === 'pending_review') return 'Proposal submitted for independent review';
  if (outcome === 'duplicate') return 'Existing controlling memory was confirmed';
  if (outcome === 'already_stale') return 'Memory was already marked for review';
  if (outcome === 'already_second_approved') return 'Second approval was already recorded';
  return `${governanceActionTitle(kind)} completed`;
}

export function governanceHumanize(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
}

export function governanceWithActorNames(
  value: Record<string, unknown>,
  actors: Record<string, { name: string; email: string }>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (!key.toLowerCase().endsWith('userid') || typeof item !== 'string') return [key, item];
      const actor = actors[item];
      return [key.replace(/UserId$/, ''), actor ? `${actor.name} · ${actor.email}` : item];
    }),
  );
}

export function governanceErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const response = (error as { response?: { data?: { message?: unknown } } }).response;
    if (typeof response?.data?.message === 'string') return response.data.message;
  }
  return error instanceof Error ? error.message : 'Memory governance action failed';
}
