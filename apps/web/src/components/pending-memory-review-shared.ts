/**
 * UI-free pending-memory-review types + copy helpers — extracted from
 * PendingMemoryReviewPanel.tsx (antd) so the vNext Settings module shares them
 * (extraction pattern, purge Phase 2). PendingMemoryReviewPanel re-exports;
 * its public API is unchanged.
 */

export interface MemoryReviewSection {
  key: string;
  heading: string;
  owner: 'engine' | 'human';
  body: string;
  prompt?: string;
  example?: string;
}

export interface MemoryReviewerIdentity {
  userId: string;
  name: string;
  email: string;
  role: string;
}

export interface PendingMemoryReviewState {
  candidateId: string;
  status: 'pending_review';
  submittedAt: string;
  scope?: 'firm' | 'client';
  sourceKind?: string;
  proposal?: {
    title: string;
    sections: MemoryReviewSection[];
  };
  submittedBy?: MemoryReviewerIdentity;
  eligibleReviewers?: MemoryReviewerIdentity[];
  reviewerRequirement?: string;
  nextAction?: string;
  blocked?: boolean;
  canWithdraw?: boolean;
  viewerCanReview?: boolean;
  viewerCanApprove?: boolean;
  viewerCanReject?: boolean;
  auditReference?: string;
}

export function pendingReviewHeadline(pending: PendingMemoryReviewState): string {
  return pending.blocked ? 'Review blocked' : 'Waiting for approval';
}

export function pendingReviewTone(pending: PendingMemoryReviewState): 'error' | 'info' | 'success' {
  if (pending.blocked) return 'error';
  if (pending.viewerCanReview) return 'success';
  return 'info';
}

export function activeMemoryVersionPresentation(activeExists: boolean): {
  title: string;
  tag: string;
  tagColor: 'green' | 'default';
} {
  return activeExists
    ? { title: 'Current active version', tag: 'Used by Meri now', tagColor: 'green' }
    : { title: 'No active version yet', tag: 'Nothing active yet', tagColor: 'default' };
}

export function activeMemoryReviewExplanation(activeExists: boolean): string {
  return activeExists
    ? 'Meri continues using the current version until an authorized administrator or reviewer ' +
        'approves the proposal.'
    : 'No shared version is active yet. Meri will not use this proposal until an authorized ' +
        'administrator or reviewer approves it.';
}
