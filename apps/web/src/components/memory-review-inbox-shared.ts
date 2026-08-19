/**
 * UI-free Memory Review Inbox types + label helpers — extracted from
 * MemoryReviewInbox.tsx (antd) so the vNext Settings module shares them
 * (extraction pattern, purge Phase 2). MemoryReviewInbox re-exports; its
 * public API is unchanged.
 */

export type MemoryReviewInboxView =
  | 'needs_my_review'
  | 'submitted_by_me'
  | 'all_pending'
  | 'blocked'
  | 'history';

export type MemoryReviewStatus =
  | 'pending'
  | 'changes_requested'
  | 'approved'
  | 'rejected'
  | 'withdrawn'
  | 'superseded';

export interface MemoryReviewInboxItem {
  candidateId: string;
  reviewRequestId: string;
  candidateKind: 'standard' | 'correction' | 'restore' | 'contradiction';
  scope: 'firm' | 'client';
  client: { id: string; name: string; status: string | null } | null;
  title: string;
  status: MemoryReviewStatus;
  revisionNumber: number;
  rootCandidateId: string;
  predecessorCandidateId: string | null;
  submittedBy: { userId: string; name: string };
  assignedReviewer: { userId: string; name: string } | null;
  decidedBy: { userId: string; name: string } | null;
  createdAt: string;
  decidedAt: string | null;
  blockedReason:
    | 'no_reviewer'
    | 'reviewer_unavailable'
    | 'archived_client'
    | null;
  nextAction:
    | 'review'
    | 'revise'
    | 'await_reviewer'
    | 'assign_reviewer'
    | 'none';
  capabilities: {
    open: boolean;
    approve: boolean;
    reject: boolean;
    requestChanges: boolean;
    revise: boolean;
    reassign: boolean;
    withdraw: boolean;
  };
}

export interface MemoryReviewInboxPage {
  enabled: boolean;
  view: MemoryReviewInboxView;
  items: MemoryReviewInboxItem[];
  nextCursor: string | null;
}

export interface MemoryReviewInboxSummary {
  enabled: boolean;
  counts: {
    needsMyReview: number;
    submittedByMe: number;
    allPending: number;
    blocked: number;
    history: number;
  };
  truncated: boolean;
}

export interface MemoryReviewSectionBody {
  key: string;
  heading: string;
  owner: 'human' | 'engine';
  body: string;
}

export interface MemoryReviewDetail extends MemoryReviewInboxItem {
  proposal: {
    key: string | null;
    value: string | null;
    canonicalItem: {
      type: string;
      slug: string;
      title: string;
      sections: MemoryReviewSectionBody[];
    } | null;
  };
  feedbackReason: string | null;
  eligibleReviewers: Array<{ userId: string; name: string; role: string }>;
  timeline: Array<{
    candidateId: string;
    reviewRequestId: string;
    revisionNumber: number;
    predecessorCandidateId: string | null;
    supersededById: string | null;
    title: string;
    status: MemoryReviewStatus;
    submittedBy: { userId: string; name: string };
    assignedReviewer: { userId: string; name: string } | null;
    decidedBy: { userId: string; name: string } | null;
    createdAt: string;
    decidedAt: string | null;
  }>;
  controllingMemory: { itemId: string; version: number | null } | null;
  activeMemoryUnchanged: boolean;
}

export interface MemoryReviewNotificationItem {
  id: string;
  reviewRequestId: string;
  candidateId: string;
  clientId: string | null;
  eventType: string;
  title: string;
  readAt: string | null;
  createdAt: string;
}

export interface MemoryReviewNotificationPage {
  enabled: boolean;
  items: MemoryReviewNotificationItem[];
  nextCursor: string | null;
}

export function memoryReviewStatusLabel(status: MemoryReviewStatus): string {
  const labels: Record<MemoryReviewStatus, string> = {
    pending: 'Pending review',
    changes_requested: 'Changes requested',
    approved: 'Approved',
    rejected: 'Rejected',
    withdrawn: 'Withdrawn',
    superseded: 'Revised',
  };
  return labels[status];
}

export function memoryReviewNextActionLabel(
  item: MemoryReviewInboxItem,
): string {
  switch (item.nextAction) {
    case 'review':
      return 'Your review is needed';
    case 'revise':
      return 'Revise and resubmit';
    case 'await_reviewer':
      return item.assignedReviewer
        ? `Waiting for ${item.assignedReviewer.name}`
        : 'Waiting for a reviewer';
    case 'assign_reviewer':
      return 'Assign an eligible reviewer';
    case 'none':
      return 'No action needed';
  }
}

export function memoryReviewBlockedReasonLabel(
  reason: MemoryReviewInboxItem['blockedReason'],
): string | null {
  if (reason === 'no_reviewer') return 'No reviewer is assigned.';
  if (reason === 'reviewer_unavailable') {
    return 'The assigned reviewer is no longer eligible.';
  }
  if (reason === 'archived_client') {
    return 'This client is not active, so review is paused.';
  }
  return null;
}

export function memoryReviewEmptyDescription(view: MemoryReviewInboxView): string {
  const descriptions: Record<MemoryReviewInboxView, string> = {
    needs_my_review: 'Nothing needs your review',
    submitted_by_me: 'You have no open shared-memory submissions',
    all_pending: 'No shared-memory proposals are pending',
    blocked: 'No review workflows are blocked',
    history: 'No completed memory reviews yet',
  };
  return descriptions[view];
}

export function memoryReviewErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const response = (
      error as { response?: { data?: { message?: unknown } } }
    ).response;
    if (typeof response?.data?.message === 'string') {
      return response.data.message;
    }
  }
  return error instanceof Error ? error.message : 'Memory review action failed';
}
