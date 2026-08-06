import type { MemoryOperation } from './memory-authorization.helpers.js';

export const MEMORY_REVIEW_NOTIFICATION_EVENTS = [
  'review_assigned',
  'review_revision_assigned',
  'review_reassigned',
  'review_changes_requested',
  'review_approved',
  'review_rejected',
] as const;

export type MemoryReviewNotificationEvent =
  (typeof MEMORY_REVIEW_NOTIFICATION_EVENTS)[number];

export interface MemoryReviewNotificationWorkflowState {
  status: string;
  assignedTo: string | null;
  requestedBy: string | null;
}

export function isMemoryReviewNotificationEvent(
  value: unknown,
): value is MemoryReviewNotificationEvent {
  return MEMORY_REVIEW_NOTIFICATION_EVENTS.includes(
    value as MemoryReviewNotificationEvent,
  );
}

export function memoryReviewNotificationOperation(
  eventType: MemoryReviewNotificationEvent,
): MemoryOperation {
  return isReviewerAssignmentEvent(eventType) ? 'approve' : 'read';
}

export function memoryReviewNotificationMatchesWorkflow(
  eventType: MemoryReviewNotificationEvent,
  recipientUserId: string,
  workflow: MemoryReviewNotificationWorkflowState,
): boolean {
  if (isReviewerAssignmentEvent(eventType)) {
    return workflow.status === 'pending' && workflow.assignedTo === recipientUserId;
  }
  if (workflow.requestedBy !== recipientUserId) return false;
  if (eventType === 'review_changes_requested') {
    return workflow.status === 'changes_needed';
  }
  if (eventType === 'review_approved') return workflow.status === 'approved';
  return workflow.status === 'rejected';
}

export function normalizeNotificationTitle(value: unknown): string {
  if (typeof value !== 'string') return 'Memory proposal';
  const clean = value.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim();
  return (clean || 'Memory proposal').slice(0, 300);
}

function isReviewerAssignmentEvent(
  eventType: MemoryReviewNotificationEvent,
): boolean {
  return (
    eventType === 'review_assigned' ||
    eventType === 'review_revision_assigned' ||
    eventType === 'review_reassigned'
  );
}
