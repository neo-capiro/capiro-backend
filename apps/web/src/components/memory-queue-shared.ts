/**
 * UI-free types + helpers for the memory proposal/review queues — extracted
 * from MemoryProposalQueue.tsx and MemoryReviewQueue.tsx (antd) so the vNext
 * Settings module shares them (extraction pattern, purge Phase 2). Both legacy
 * files re-export; their public APIs are unchanged.
 */

// ── Proposer-owned queue (MemoryProposalQueue) ──────────────────────────────

export type OwnedMemoryCandidateStatus =
  | 'pending'
  | 'withdrawn'
  | 'rejected'
  | 'approved'
  | 'auto_committed';

export interface OwnedMemoryCandidate {
  id: string;
  scope: string;
  clientId: string | null;
  clientName?: string | null;
  sourceKind: string;
  status: OwnedMemoryCandidateStatus;
  createdAt: string;
  decidedAt: string | null;
  restricted: boolean;
  recordedSource?: { sourceType: string; sourceId: string };
  proposal: {
    key: string | null;
    value: string | null;
    canonicalItem: {
      type: string;
      slug: string;
      title: string;
      sections: Array<{
        key: string;
        heading: string;
        owner: 'human' | 'engine';
        body: string;
      }>;
    } | null;
  } | null;
  capabilities: { withdraw: boolean };
}

export interface OwnedProposalQueueResponse {
  enabled: boolean;
  candidates: OwnedMemoryCandidate[];
  /** Present only for the additive paged producer contract. */
  nextCursor?: string | null;
}

export function ownedMemoryCandidateTitle(candidate: OwnedMemoryCandidate): string {
  if (candidate.restricted) return 'Restricted client memory proposal';
  return candidate.proposal?.canonicalItem?.title ?? candidate.proposal?.key ?? 'Memory proposal';
}

export function ownedMemoryCandidateStatusLabel(status: OwnedMemoryCandidateStatus): string {
  switch (status) {
    case 'pending':
      return 'Pending review';
    case 'withdrawn':
      return 'Withdrawn';
    case 'rejected':
      return 'Rejected by reviewer';
    case 'approved':
    case 'auto_committed':
      return 'Approved';
  }
}

export function shouldRenderMemoryProposalQueue(
  response: OwnedProposalQueueResponse | undefined,
): boolean {
  return response?.enabled === true && response.candidates.length > 0;
}

// ── Reviewer queue (MemoryReviewQueue) ──────────────────────────────────────

export type MemoryCandidateKind =
  | 'standard'
  | 'correction'
  | 'restore'
  | 'contradiction'
  | 'learning_signal_conflict';

export interface MemoryReviewWorkflowSummary {
  requestId: string;
  status: string;
  submittedBy: { userId: string; name: string };
  assignedReviewer: { userId: string; name: string } | null;
  decidedBy: { userId: string; name: string } | null;
  feedbackReason: string | null;
  createdAt: string;
  decidedAt: string | null;
  capabilities: { requestChanges: boolean; reassign: boolean };
}

export interface ReviewableMemoryCandidate {
  id: string;
  candidateKind: MemoryCandidateKind;
  scope: string;
  clientId: string | null;
  clientName?: string | null;
  proposedByUserId: string;
  sourceKind: string;
  createdAt: string;
  proposal: {
    key: string | null;
    value: string | null;
    canonicalItem: {
      type: string;
      slug: string;
      title: string;
      sections: Array<{
        key: string;
        heading: string;
        owner: 'human' | 'engine';
        body: string;
      }>;
    } | null;
  };
  conflict?: { contradictsMemoryItemId: string; conflictStatus: string } | null;
  workflow?: MemoryReviewWorkflowSummary;
  capabilities: {
    approve: boolean;
    reject: boolean;
    requestChanges?: boolean;
    reassign?: boolean;
    resolveConflict?: boolean;
  };
}

export interface ReviewQueueResponse {
  enabled: boolean;
  candidates: ReviewableMemoryCandidate[];
}

export function memoryReviewCandidateTitle(candidate: ReviewableMemoryCandidate): string {
  return candidate.proposal.canonicalItem?.title ?? candidate.proposal.key ?? 'Memory proposal';
}

/** A queue target comes from its authorized proposal, never the current picker. */
export function memoryCandidateTargetLabel(candidate: {
  scope: string;
  clientId: string | null;
  clientName?: string | null;
  restricted?: boolean;
}): string {
  if (candidate.restricted) return 'Restricted client memory';
  if (candidate.scope === 'client') {
    return candidate.clientId && candidate.clientName?.trim()
      ? candidate.clientName.trim()
      : 'Client unavailable';
  }
  if (candidate.scope === 'personal' || candidate.scope === 'user_private') return 'Personal memory';
  if (candidate.scope === 'firm') return 'Firm memory';
  return 'Target unavailable';
}

export function memoryCandidateKindLabel(kind: MemoryCandidateKind): string {
  const labels: Record<MemoryCandidateKind, string> = {
    standard: 'New memory',
    correction: 'Correction',
    restore: 'Restore',
    contradiction: 'Contradiction',
    learning_signal_conflict: 'Source conflict',
  };
  return labels[kind];
}

export function candidateRejectRequiresReason(candidate: ReviewableMemoryCandidate): boolean {
  return candidate.candidateKind !== 'standard';
}

export function memoryReviewOutcomeMessage(
  result: Record<string, unknown>,
  decision: 'approve' | 'reject',
): string {
  const outcome = String(result.outcome ?? decision);
  const kind = String(result.candidateKind ?? 'standard');
  if (outcome === 'activated') {
    return kind === 'standard' ? 'Memory approved' : 'Memory version activated';
  }
  if (outcome === 'duplicate') return 'Existing controlling memory confirmed';
  if (outcome === 'conflict') return 'Memory conflict opened for resolution';
  if (outcome === 'rejected' || decision === 'reject') return 'Memory rejected';
  return decision === 'approve' ? 'Memory approved' : 'Memory rejected';
}

export function shouldRenderMemoryReviewQueue(response: ReviewQueueResponse | undefined): boolean {
  return response?.enabled === true && response.candidates.length > 0;
}

export function memoryQueueErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const response = (error as { response?: { data?: { message?: unknown } } }).response;
    if (typeof response?.data?.message === 'string') return response.data.message;
  }
  return error instanceof Error ? error.message : 'Review decision failed';
}
