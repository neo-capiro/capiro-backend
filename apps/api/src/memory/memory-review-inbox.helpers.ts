import { BadRequestException } from '@nestjs/common';

export const MEMORY_REVIEW_INBOX_VIEWS = [
  'needs_my_review',
  'submitted_by_me',
  'all_pending',
  'blocked',
  'history',
] as const;

export type MemoryReviewInboxView = (typeof MEMORY_REVIEW_INBOX_VIEWS)[number];

export type MemoryReviewPublicStatus =
  | 'pending'
  | 'changes_requested'
  | 'approved'
  | 'rejected'
  | 'withdrawn'
  | 'superseded';

export type MemoryReviewNextAction =
  | 'review'
  | 'revise'
  | 'await_reviewer'
  | 'assign_reviewer'
  | 'none';

export type MemoryReviewBlockedReason =
  | 'no_reviewer'
  | 'reviewer_unavailable'
  | 'archived_client'
  | null;

export interface MemoryReviewCursor {
  createdAt: string;
  id: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseMemoryReviewInboxView(value: unknown): MemoryReviewInboxView {
  if (
    typeof value !== 'string' ||
    !MEMORY_REVIEW_INBOX_VIEWS.includes(value as MemoryReviewInboxView)
  ) {
    return 'needs_my_review';
  }
  return value as MemoryReviewInboxView;
}

export function parseMemoryReviewPageSize(value: unknown): number {
  if (value === undefined || value === null || value === '') return 25;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
    throw new BadRequestException(
      'Memory review page size must be an integer from 1 to 50.',
    );
  }
  return parsed;
}

export function encodeMemoryReviewCursor(cursor: MemoryReviewCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), 'utf8').toString(
    'base64url',
  );
}

export function decodeMemoryReviewCursor(value: unknown): MemoryReviewCursor | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 512) {
    throw new BadRequestException('Memory review cursor is invalid.');
  }
  try {
    const decoded = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    const createdAt = typeof decoded.createdAt === 'string' ? decoded.createdAt : '';
    const id = typeof decoded.id === 'string' ? decoded.id : '';
    if (
      decoded.v !== 1 ||
      !createdAt ||
      Number.isNaN(Date.parse(createdAt)) ||
      !UUID_PATTERN.test(id)
    ) {
      throw new Error('invalid cursor fields');
    }
    return { createdAt: new Date(createdAt).toISOString(), id };
  } catch {
    throw new BadRequestException('Memory review cursor is invalid.');
  }
}

export function memoryReviewStatusFromDb(value: string): MemoryReviewPublicStatus {
  switch (value) {
    case 'pending':
      return 'pending';
    case 'changes_needed':
      return 'changes_requested';
    case 'approved':
      return 'approved';
    case 'rejected':
      return 'rejected';
    case 'withdrawn':
      return 'withdrawn';
    case 'superseded':
      return 'superseded';
    default:
      throw new Error(`Unsupported memory review status: ${value}`);
  }
}

export function memoryReviewCandidateKindFromSource(
  sourceKind: string,
  metadataKind?: string | null,
): 'standard' | 'correction' | 'restore' | 'contradiction' {
  if (metadataKind === 'correction' || sourceKind === 'memory_correction') {
    return 'correction';
  }
  if (metadataKind === 'restore' || sourceKind === 'memory_restore') return 'restore';
  if (
    metadataKind === 'contradiction' ||
    sourceKind === 'memory_contradiction'
  ) {
    return 'contradiction';
  }
  return 'standard';
}

export function memoryReviewBlockedReason(input: {
  clientId: string | null;
  clientStatus: string | null;
  assignedReviewerId: string | null;
  assignedReviewerActive: boolean;
  assignedReviewerEligible: boolean;
}): MemoryReviewBlockedReason {
  if (input.clientId && input.clientStatus !== 'active') return 'archived_client';
  if (!input.assignedReviewerId) return 'no_reviewer';
  if (!input.assignedReviewerActive || !input.assignedReviewerEligible) {
    return 'reviewer_unavailable';
  }
  return null;
}

export function memoryReviewNextAction(input: {
  status: MemoryReviewPublicStatus;
  viewerIsSubmitter: boolean;
  viewerIsAssignedReviewer: boolean;
  viewerIsAdmin: boolean;
  canApprove: boolean;
  canReject: boolean;
  canRevise: boolean;
  canReassign: boolean;
}): MemoryReviewNextAction {
  if (
    input.status === 'pending' &&
    input.viewerIsAssignedReviewer &&
    (input.canApprove || input.canReject)
  ) {
    return 'review';
  }
  if (
    input.status === 'changes_requested' &&
    input.viewerIsSubmitter &&
    input.canRevise
  ) {
    return 'revise';
  }
  if (input.status === 'pending' && input.viewerIsAdmin && input.canReassign) {
    return 'assign_reviewer';
  }
  if (input.status === 'pending' && input.viewerIsSubmitter) return 'await_reviewer';
  return 'none';
}

export function memoryReviewStatusLabel(status: MemoryReviewPublicStatus): string {
  const labels: Record<MemoryReviewPublicStatus, string> = {
    pending: 'Pending review',
    changes_requested: 'Changes requested',
    approved: 'Approved',
    rejected: 'Rejected',
    withdrawn: 'Withdrawn',
    superseded: 'Revised',
  };
  return labels[status];
}
