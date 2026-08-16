import { createHash } from 'node:crypto';
import type {
  DraftApprovalStatus,
  DraftAuditStatus,
  DraftGenerationStatus,
} from '../../engagement/outreach-draft.types.js';

export const OUTREACH_V3_DRAFT_APPROVAL_VERSION = 'outreach_v3_draft_approval_v1' as const;

export type OutreachV3DraftLifecycleState =
  | 'ready_for_review'
  | 'approved'
  | 'held'
  | 'dirty'
  | 'stale'
  | 'failed'
  | 'audit_unavailable';

export interface OutreachV3DraftVersionIdentity {
  versionId: string;
  artifactId: string;
  generationKey: string;
  contentHash: string;
  planHash: string;
  generationStatus: DraftGenerationStatus;
  auditStatus: DraftAuditStatus;
  baseApprovalStatus: DraftApprovalStatus;
}

/** Separate from audit review: this is the author's exact-version send approval. */
export interface OutreachV3DraftApprovalSnapshot {
  schemaVersion: typeof OUTREACH_V3_DRAFT_APPROVAL_VERSION;
  sessionId: string;
  stateVersion: number;
  specHash: string;
  planHash: string;
  artifactId: string;
  generationKey: string;
  versionId: string;
  contentHash: string;
  approvalHash: string;
}

export interface OutreachV3DraftLifecycleInput {
  version: OutreachV3DraftVersionIdentity;
  currentPlanHash: string;
  localDirty: boolean;
  approval: OutreachV3DraftApprovalSnapshot | null;
}

export interface OutreachV3DraftLifecycle {
  state: OutreachV3DraftLifecycleState;
  exactVersionApproved: boolean;
  sendReviewEligible: boolean;
  reason:
    | 'local_edits_not_persisted'
    | 'generation_failed'
    | 'campaign_plan_changed'
    | 'audit_unavailable'
    | 'audit_pending'
    | 'audit_held'
    | 'review_rejected'
    | 'exact_version_approved'
    | 'awaiting_exact_version_approval';
}

export function createOutreachV3DraftApprovalSnapshot(input: {
  sessionId: string;
  stateVersion: number;
  specHash: string;
  planHash: string;
  version: OutreachV3DraftVersionIdentity;
}): OutreachV3DraftApprovalSnapshot {
  if (!auditAllowsAuthorApproval(input.version.auditStatus)) {
    throw new Error(`OUTREACH_V3_DRAFT_NOT_APPROVABLE:${input.version.auditStatus}`);
  }
  if (input.version.generationStatus === 'generation_failed') {
    throw new Error('OUTREACH_V3_DRAFT_NOT_APPROVABLE:generation_failed');
  }
  if (input.version.baseApprovalStatus === 'rejected') {
    throw new Error('OUTREACH_V3_DRAFT_NOT_APPROVABLE:review_rejected');
  }
  const base = {
    schemaVersion: OUTREACH_V3_DRAFT_APPROVAL_VERSION,
    sessionId: input.sessionId,
    stateVersion: input.stateVersion,
    specHash: input.specHash,
    planHash: input.planHash,
    artifactId: input.version.artifactId,
    generationKey: input.version.generationKey,
    versionId: input.version.versionId,
    contentHash: input.version.contentHash,
  };
  return { ...base, approvalHash: sha256(JSON.stringify(base)) };
}

export function isOutreachV3ExactVersionApproved(
  version: OutreachV3DraftVersionIdentity,
  currentPlanHash: string,
  approval: OutreachV3DraftApprovalSnapshot | null,
): boolean {
  return Boolean(
    approval &&
    approval.schemaVersion === OUTREACH_V3_DRAFT_APPROVAL_VERSION &&
    approval.planHash === currentPlanHash &&
    approval.planHash === version.planHash &&
    approval.artifactId === version.artifactId &&
    approval.generationKey === version.generationKey &&
    approval.versionId === version.versionId &&
    approval.contentHash === version.contentHash &&
    auditAllowsSend(version.auditStatus) &&
    version.baseApprovalStatus !== 'rejected' &&
    version.generationStatus !== 'generation_failed',
  );
}

/**
 * V3 deliberately adds a stronger gate than the shared legacy sendability flag:
 * clean audit is necessary but never equivalent to explicit author approval.
 */
export function deriveOutreachV3DraftLifecycle(
  input: OutreachV3DraftLifecycleInput,
): OutreachV3DraftLifecycle {
  const { version } = input;
  if (input.localDirty) {
    return lifecycle('dirty', false, false, 'local_edits_not_persisted');
  }
  if (version.generationStatus === 'generation_failed') {
    return lifecycle('failed', false, false, 'generation_failed');
  }
  if (version.planHash !== input.currentPlanHash) {
    return lifecycle('stale', false, false, 'campaign_plan_changed');
  }
  if (version.auditStatus === 'unavailable') {
    return lifecycle('audit_unavailable', false, false, 'audit_unavailable');
  }
  if (version.auditStatus === 'pending') {
    return lifecycle('held', false, false, 'audit_pending');
  }
  if (version.auditStatus === 'held') {
    return lifecycle('held', false, false, 'audit_held');
  }
  if (version.baseApprovalStatus === 'rejected') {
    return lifecycle('held', false, false, 'review_rejected');
  }

  const approved = isOutreachV3ExactVersionApproved(version, input.currentPlanHash, input.approval);
  if (approved) {
    return lifecycle('approved', true, true, 'exact_version_approved');
  }
  return lifecycle('ready_for_review', false, false, 'awaiting_exact_version_approval');
}

function auditAllowsAuthorApproval(status: DraftAuditStatus): boolean {
  return status === 'not_required' || status === 'passed' || status === 'warning';
}

function auditAllowsSend(status: DraftAuditStatus): boolean {
  return status === 'not_required' || status === 'passed' || status === 'warning';
}

function lifecycle(
  state: OutreachV3DraftLifecycleState,
  exactVersionApproved: boolean,
  sendReviewEligible: boolean,
  reason: OutreachV3DraftLifecycle['reason'],
): OutreachV3DraftLifecycle {
  return { state, exactVersionApproved, sendReviewEligible, reason };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
