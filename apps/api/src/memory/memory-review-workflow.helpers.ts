export const MEMORY_REVIEW_WORKFLOW_STATUSES = [
  'pending',
  'changes_requested',
  'approved',
  'rejected',
  'withdrawn',
  'superseded',
] as const;

export type MemoryReviewWorkflowStatus = (typeof MEMORY_REVIEW_WORKFLOW_STATUSES)[number];
export type MemoryReviewWorkflowDbStatus =
  | 'pending'
  | 'changes_needed'
  | 'approved'
  | 'rejected'
  | 'withdrawn'
  | 'superseded';

const PUBLIC_STATUS_SET = new Set<string>(MEMORY_REVIEW_WORKFLOW_STATUSES);

/** Review feedback is evidence, not a memory body. Keep it present, plain, and bounded. */
export function normalizeMemoryReviewReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, 500) : null;
}

export function isMemoryReviewWorkflowStatus(value: unknown): value is MemoryReviewWorkflowStatus {
  return typeof value === 'string' && PUBLIC_STATUS_SET.has(value);
}

/** review_request.status is varchar(16); map the public phrase to a bounded DB token. */
export function memoryReviewStatusFromDb(value: unknown): MemoryReviewWorkflowStatus {
  if (value === 'changes_needed') return 'changes_requested';
  return isMemoryReviewWorkflowStatus(value) ? value : 'pending';
}

export function memoryReviewStatusToDb(
  value: MemoryReviewWorkflowStatus,
): MemoryReviewWorkflowDbStatus {
  return value === 'changes_requested' ? 'changes_needed' : value;
}

/** Prefer the tenant's own reviewers; platform staff are a last-resort assignment. */
export function memoryReviewerRoleRank(role: string): number {
  if (role === 'user_admin') return 0;
  if (role === 'standard_user') return 1;
  if (role === 'capiro_admin') return 2;
  return 3;
}

export function memoryReviewerDisplayName(input: {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  fallback?: string;
}): string {
  return (
    [input.firstName, input.lastName].filter(Boolean).join(' ').trim() ||
    input.email?.trim() ||
    input.fallback ||
    'Former user'
  );
}
